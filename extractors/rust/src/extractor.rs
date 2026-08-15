// extractor.rs — pipeline orchestration (skeleton; modules wired in as they
// land — order mirrors go/extractor.go):
//
//   walk → parse (facts) → module_map → lookup → imports (+[crate] nodes) →
//   calls → routes → orm → inheritance → tests → enrich →
//   dedupe → deterministic sort → result.
//
// Edge detectors resolve from facts via lookup maps — never re-walk ASTs
// (playbook rule).

use crate::contract::{ExtractorError, ExtractorResult, Stats};
use crate::fingerprint;
use crate::parser::ParsedFile;
use serde_json::Value;

/// All parsed facts for the repo — the single source consumed by every edge
/// detector (mirrors go's parsedRepo).
pub struct ParsedRepo {
    pub files: Vec<ParsedFile>,
    pub skipped: i64,
}

/// Options — the engine forwards includeThirdPartyLibs (both spellings).
#[derive(Default, Clone)]
pub struct Options {
    /// Third-party crates the user selected in the frontend. Absent/empty →
    /// ZERO third-party nodes (gate, not default-on).
    pub include_third_party_libs: Vec<String>,
}

impl Options {
    pub fn from_json(options: &Value) -> Self {
        let mut o = Options::default();
        for key in ["includeThirdPartyLibs", "includedThirdPartyLibs"] {
            if let Some(v) = options.get(key).and_then(|v| v.as_array()) {
                for item in v {
                    if let Some(s) = item.as_str() {
                        o.include_third_party_libs.push(s.to_string());
                    }
                }
            }
            if !o.include_third_party_libs.is_empty() {
                break;
            }
        }
        o
    }
}

pub fn run(repo_path: &str, opts: &Options) -> ExtractorResult {
    let _ = opts;

    let mut errors: Vec<ExtractorError> = vec![];

    // ── fingerprint (Cargo.toml only; no stdlib web framework in Rust, so no
    // post-walk upgrades like Go's net-http) ──
    let mf = fingerprint::parse_cargo_toml(repo_path);
    let fingerprint = fingerprint::fingerprint_from_manifest(&mf, repo_path);

    // ── walk + parse (facts; non-fatal per-file errors) ──
    let mut parsed = ParsedRepo {
        files: vec![],
        skipped: 0,
    };
    for rel in crate::walker::collect_rs_files(repo_path) {
        let abs = format!("{}/{}", repo_path, rel);
        match std::fs::read_to_string(&abs) {
            Ok(source) => match crate::parser::parse_file(&rel, &source) {
                Ok(pf) => parsed.files.push(pf),
                Err(e) => {
                    parsed.skipped += 1;
                    errors.push(ExtractorError {
                        file: rel.clone(),
                        error: format!("parse error: {}", e),
                    });
                }
            },
            Err(e) => {
                parsed.skipped += 1;
                errors.push(ExtractorError {
                    file: rel.clone(),
                    error: format!("read error: {}", e),
                });
            }
        }
    }

    // ── module map + lookup (ONE shared index) ──
    let module_map = crate::module_map::ModuleMap::build(&parsed.files);

    // file + code nodes (test files = leaf: testCases only)
    let file_nodes = crate::nodes::collect_file_nodes(&parsed.files);
    let mut all_nodes: Vec<crate::contract::CodeNode> = file_nodes;
    all_nodes.extend(crate::nodes::collect_code_nodes(&parsed.files));

    let mut lookup = crate::lookup::build_lookup_maps(&parsed.files, &all_nodes);

    // third-party registry — gate from options (absent/empty → ZERO [crate])
    let mut tp = crate::thirdparty::ThirdPartyRegistry::new(&opts.include_third_party_libs);

    // ── edges, in dependency order ──
    let mut all_edges: Vec<crate::contract::CodeEdge> = vec![];

    // IMPORTS + [crate] nodes
    let imports = crate::imports::detect_imports(&parsed, &mf, &module_map, &mut tp, opts);
    all_edges.extend(imports.edges);

    // CALLS
    // detect_calls writes metadata.resolvedCalls back into lookup.node_by_id
    // (it clones→mutates→reinserts). all_nodes was built BEFORE that, so we
    // must sync the resolvedCalls forward — else the output nodes carry calls
    // (parser-time) but never resolvedCalls, and the CALLS parity census reads 0.
    let calls = crate::calls::detect_calls(&parsed, &module_map, &mut lookup, &mf, &mut tp, opts);
    all_edges.extend(calls.edges);
    for n in &mut all_nodes {
        if let Some(reg) = lookup.node_by_id.get(&n.id) {
            if let Some(rc) = reg.metadata.get("resolvedCalls") {
                n.metadata.insert("resolvedCalls".to_string(), rc.clone());
            }
        }
    }

    // ROUTE nodes + HANDLES edges + BackendRouteNodes
    let routes_out = crate::routes::detect_routes(
        &parsed,
        &module_map,
        &lookup,
        &fingerprint.framework,
        opts,
        &mf,
        &mut tp,
    );
    all_nodes.extend(routes_out.route_nodes);
    all_edges.extend(routes_out.handles_edges);

    // EXTENDS / IMPLEMENTS
    let inheritance =
        crate::inheritance::detect_inheritance(&parsed, &mf, &module_map, &lookup, &mut tp, opts);
    all_edges.extend(inheritance.edges);
    all_nodes.extend(inheritance.third_party_nodes);

    // READS_FROM / WRITES_TO (Diesel)
    all_edges.extend(crate::orm_edges::detect_orm_edges(&parsed, &lookup, opts));

    // TESTS edges
    all_edges.extend(crate::tests::detect_tests(
        &parsed,
        &module_map,
        &lookup,
        opts,
    ));

    // third-party nodes — the registry is the SINGLE source (imports/calls
    // registered into it; collected last, go parity)
    all_nodes.extend(tp.all_nodes());

    // ── dedupe + deterministic sort ──
    let edges = dedupe_and_sort_edges(all_edges);
    all_nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let mut routes = routes_out.backend_routes;
    routes.sort_by(|a, b| {
        (&a.http_method, &a.url_path, &a.node_id).cmp(&(&b.http_method, &b.url_path, &b.node_id))
    });

    // semantic enrichment (isModel/isHandler) — needs the deduped edges
    crate::enrich::enrich_nodes(&parsed, &mut all_nodes, &edges);
    all_nodes.sort_by(|a, b| a.id.cmp(&b.id));

    let total_nodes = all_nodes.len() as i64;
    ExtractorResult {
        fingerprint,
        nodes: all_nodes,
        edges,
        routes,
        stats: Stats {
            total_files: parsed.files.len() as i64,
            total_nodes,
            skipped_files: parsed.skipped,
        },
        errors,
    }
}

/// Dedupe (from, type, to) then sort by (from, type, to) — deterministic.
fn dedupe_and_sort_edges(edges: Vec<crate::contract::CodeEdge>) -> Vec<crate::contract::CodeEdge> {
    let mut seen: std::collections::HashSet<(String, String, String)> =
        std::collections::HashSet::new();
    let mut out = vec![];
    for e in edges {
        let key = (e.from.clone(), e.edge_type.clone(), e.to.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(e);
    }
    out.sort_by(|a, b| (&a.from, &a.edge_type, &a.to).cmp(&(&b.from, &b.edge_type, &b.to)));
    out
}

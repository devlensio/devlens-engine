// imports.rs — IMPORTS edges from `use` declarations + [crate] third-party
// nodes (mirrors go/imports.go).
//
// Resolution (documented Rust semantics — the module tree, not a sys.path
// simulation):
//   crate::a::b  → absolute;  super::/self::  → relative;  bare → relative
//   then crate root. Longest module prefix wins; the remainder is an item.
// Targets are FILES (Python model — no MODULE nodes in V1):
//   `use crate::models::user::User;` → IMPORTS edge to src/models/user.rs
// External first segments (a Cargo.toml dep, not std, not local) →
//   gated [crate]/name[::member] node + IMPORTS edge to it. Nodes are
//   registered into the shared ThirdPartyRegistry (the pipeline collects
//   tp.all_nodes() last — go parity); this module only emits edges.

use crate::contract::CodeEdge;
use crate::extractor::{Options, ParsedRepo};
use crate::fingerprint::ParsedManifest;
use crate::module_map::ModuleMap;
use crate::thirdparty::ThirdPartyRegistry;

pub struct ImportsOutput {
    pub edges: Vec<CodeEdge>,
}

/// Emit IMPORTS edges for every use declaration.
pub fn detect_imports(
    repo: &ParsedRepo,
    mf: &ParsedManifest,
    module_map: &ModuleMap,
    tp: &mut ThirdPartyRegistry,
    _opts: &Options,
) -> ImportsOutput {
    let mut edges = vec![];
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    for pf in &repo.files {
        if pf.is_test_file {
            // test files ARE leaf nodes, but they still import — emit edges
            // from the TEST node (same file id — parentFile covers it)
        }
        let from = format!("file::{}", pf.rel_path);
        let base_module = crate::walker::module_path_for_file(&pf.rel_path);
        for u in &pf.uses {
            // resolve the target path against the module map (use-semantics:
            // crate-root absolute for bare paths — edition 2018)
            if let Some((file, rest)) = module_map.resolve_use(&u.target, &base_module) {
                // skip self-imports (`use super::*` inside a same-file mod,
                // `use crate::foo::*` from within foo.rs) — noise edges
                if file == pf.rel_path {
                    continue;
                }
                let to = format!("file::{}", file);
                let key = (from.clone(), to.clone());
                if !seen.contains(&key) {
                    seen.insert(key);
                    edges.push(crate::contract::edge(&from, &to, "IMPORTS"));
                }
                // rest (an item) is refined by calls/tests via symbol maps
                let _ = rest;
                continue;
            }
            // external crate or unresolved
            let first = crate::thirdparty::first_segment(&u.target);
            if crate::thirdparty::is_std(first) {
                continue; // skip tier — no node, no edge
            }
            if !crate::thirdparty::is_external_crate(first, mf) {
                continue; // unresolvable (typo / not a dep) — metadata only
            }
            // external: [crate]/name (+ member when the use names one) —
            // registration happens inside the registry (gated)
            if tp.crate_node(first).is_some() {
                push_import(
                    &mut edges,
                    &mut seen,
                    &from,
                    &crate::lookup::third_party_id(first),
                );
            }
            let rest: Vec<&str> = u.target.split("::").skip(1).collect();
            if !rest.is_empty() && !u.glob {
                let member = rest.join("::");
                let _ = tp.member_node(first, &member);
            }
        }
    }
    ImportsOutput { edges }
}

fn push_import(
    edges: &mut Vec<CodeEdge>,
    seen: &mut std::collections::HashSet<(String, String)>,
    from: &str,
    to: &str,
) {
    let key = (from.to_string(), to.to_string());
    if !seen.contains(&key) {
        seen.insert(key);
        edges.push(crate::contract::edge(from, to, "IMPORTS"));
    }
}

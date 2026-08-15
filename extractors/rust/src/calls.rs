// calls.rs — the CALLS ladder (syntactic — syn does no type resolution).
//
// Ladder (each rung documented; later rungs flagged heuristic where fuzzy):
//   1. Path call `a::b::c()` / `Type::m()`:
//        a. first segment via the file's use-symbol map (alias → target)
//        b. module_map.resolve → (file, rest)
//        c. rest = single name   → FUNCTION in that file (closest_by_path)
//        d. rest = Type::method  → STRUCT/ENUM/TRAIT in that file, then
//           methods_by_owner (same file preferred) → METHOD
//   2. Plain `bar()` → same-file FUNCTION first, then crate-wide name
//   3. `Type::new()` with the type in scope but NOT imported (same module /
//      no use statement) → type via closest_by_path, then its methods
//   4. `self.method()` → methods of the enclosing impl's owner type
//   5. `x.method()` (other receivers) → no type info → metadata only V1
//   6. External first segment (a Cargo.toml dep, not std/local) → lazy
//      [crate]/name::member node (gated)
//
// metadata.calls already carries the raw strings (parser); resolved targets
// are written back as metadata.resolvedCalls.

use crate::contract::{edge, CodeEdge};
use crate::extractor::{Options, ParsedRepo};
use crate::fingerprint::ParsedManifest;
use crate::lookup::LookupMaps;
use crate::module_map::ModuleMap;
use crate::parser::ParsedItem;
use crate::thirdparty::ThirdPartyRegistry;

pub struct CallsOutput {
    pub edges: Vec<CodeEdge>,
}

pub fn detect_calls(
    repo: &ParsedRepo,
    module_map: &ModuleMap,
    lookup: &mut LookupMaps,
    mf: &ParsedManifest,
    tp: &mut ThirdPartyRegistry,
    _opts: &Options,
) -> CallsOutput {
    let mut edges = vec![];

    for pf in &repo.files {
        if pf.is_test_file {
            continue;
        }
        for item in &pf.items {
            if item.is_test || item.calls.is_empty() {
                continue;
            }
            let from = crate::lookup::node_id_for_item(&pf.rel_path, item);
            if from.is_empty() {
                continue;
            }
            let base_module = crate::walker::module_path_for_file(&pf.rel_path);
            let mut resolved: Vec<String> = vec![];
            for call in &item.calls {
                if let Some(target) = resolve_call(
                    call,
                    item,
                    &pf.rel_path,
                    &base_module,
                    module_map,
                    lookup,
                    mf,
                    tp,
                ) {
                    edges.push(edge(&from, &target, "CALLS"));
                    resolved.push(target);
                }
            }
            if !resolved.is_empty() {
                // write metadata.resolvedCalls back (nodes are owned by the
                // registry; clone → mutate → reinsert)
                if let Some(node) = lookup.node_by_id.get(&from).cloned() {
                    let mut n = node;
                    let r: Vec<serde_json::Value> = resolved
                        .iter()
                        .map(|s| serde_json::Value::from(s.clone()))
                        .collect();
                    n.metadata
                        .insert("resolvedCalls".to_string(), serde_json::Value::Array(r));
                    lookup.node_by_id.insert(from, n);
                }
            }
        }
    }

    CallsOutput { edges }
}

/// Resolve one call string → target node id (or None).
#[allow(clippy::too_many_arguments)]
fn resolve_call(
    call: &str,
    item: &ParsedItem,
    rel_path: &str,
    base_module: &str,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    mf: &ParsedManifest,
    tp: &mut ThirdPartyRegistry,
) -> Option<String> {
    // `x.method()` — receiver form
    if let Some((recv, method)) = call.split_once('.') {
        if recv == "self" {
            // methods of the enclosing impl's owner type
            let owner = &item.impl_target;
            if owner.is_empty() {
                return None;
            }
            return method_of_owner(owner, method, rel_path, lookup);
        }
        // other receivers: no type resolution in V1 — metadata only
        return None;
    }
    resolve_path_call(call, rel_path, base_module, module_map, lookup, mf, tp)
}

/// Resolve a path-form call (`a::b::c`, `Type::m`, plain `bar`) to a node id.
/// Shared by the CALLS ladder and utoipa-axum route handlers (routes.rs).
///
/// Ladder (documented Rust semantics): first segment via the file's use-symbol
/// map → module map resolve (relative-first for call paths) → glob-import
/// unroll (`use crate::controllers::*` brings `krate` into scope) → external
/// crate → lazy [crate]/name::member (gated).
pub fn resolve_path_call(
    call: &str,
    rel_path: &str,
    base_module: &str,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    mf: &ParsedManifest,
    tp: &mut ThirdPartyRegistry,
) -> Option<String> {
    let segs: Vec<&str> = call.split("::").collect();
    if segs.is_empty() {
        return None;
    }
    if segs.len() == 1 {
        // plain name → same-file FUNCTION, then crate-wide
        if let Some(id) = lookup.closest_by_path(segs[0], rel_path) {
            return Some(id);
        }
        return None;
    }

    // multi-segment path — first segment via symbol map, then module resolve
    let sym_target = lookup
        .symbol_maps
        .get(rel_path)
        .and_then(|syms| syms.get(segs[0]))
        .cloned();
    let full_path = match &sym_target {
        Some(t) => format!("{}::{}", t, segs[1..].join("::")),
        None => call.to_string(),
    };

    // Relative-first module resolution (the call-path ladder). NOTE: when
    // the caller's own file IS a module (e.g. src/router.rs → module
    // "router"), bare paths like `krate::search::list_crates` resolve
    // relative-first to `router::krate::...` → matches the file's OWN module
    // → returns (src/router.rs, "krate::search::list_crates") →
    // resolve_in_file finds no item_by_module_name["router::krate"] → None.
    // That None is NOT a hard failure — fall through to glob unroll +
    // crate-root absolute, where utoipa `routes!(krate::search::list_crates)`
    // handlers actually live (brought into scope via `use crate::controllers::*;`).
    if let Some((file, rest)) = module_map.resolve(&full_path, base_module) {
        if let Some(id) = resolve_in_file(&file, &rest, rel_path, lookup) {
            return Some(id);
        }
        // don't return None — fall through to glob unroll + crate-root
    }

    // glob unroll: `use crate::controllers::*;` brings `krate` into scope, so
    // `krate::search::list_crates` resolves as `crate::controllers::krate::
    // search::list_crates` (documented Rust glob-import semantics)
    if sym_target.is_none() {
        if let Some(globs) = lookup.glob_maps.get(rel_path) {
            for g in globs {
                let cand = format!("{}::{}", g, full_path);
                if let Some((file, rest)) = module_map.resolve(&cand, base_module) {
                    if let Some(id) = resolve_in_file(&file, &rest, rel_path, lookup) {
                        return Some(id);
                    }
                }
            }
        }
    }

    // crate-root absolute fallback. A bare multi-segment path whose first
    // segment is a local module resolves from the CRATE ROOT in edition 2018
    // (same semantics as use-paths — `krate::search::list_crates` from
    // src/router.rs means `crate::krate::search::list_crates`, NOT
    // `router::krate::...`). resolve_use() is crate-root-absolute and won't
    // misresolve against the caller's own module.
    if let Some((file, rest)) = module_map.resolve_use(&full_path, base_module) {
        if let Some(id) = resolve_in_file(&file, &rest, rel_path, lookup) {
            return Some(id);
        }
    }

    // external crate (a dep, not std, not local) → lazy member node
    let first = crate::thirdparty::first_segment(&full_path);
    if crate::thirdparty::is_std(first) {
        return None;
    }
    if crate::thirdparty::is_external_crate(first, mf) {
        let member = full_path.split("::").skip(1).collect::<Vec<_>>().join("::");
        return tp.member_node(first, &member).map(|n| n.id.clone());
    }
    None
}

/// Resolve `rest` (item path within `file`) → node id.
fn resolve_in_file(file: &str, rest: &str, from_rel: &str, lookup: &LookupMaps) -> Option<String> {
    if rest.is_empty() {
        return None;
    }
    let file_module = crate::walker::module_path_for_file(file);
    let parts: Vec<&str> = rest.split("::").collect();
    if parts.len() == 1 {
        // single name — FUNCTION (or struct constructor call `Type(...)`)
        let key = if file_module.is_empty() {
            parts[0].to_string()
        } else {
            format!("{}::{}", file_module, parts[0])
        };
        if let Some(id) = lookup.item_by_module_name.get(&key) {
            return Some(id.clone());
        }
        return lookup.closest_by_path(parts[0], file);
    }
    // Type::method
    let ty_key = if file_module.is_empty() {
        parts[0].to_string()
    } else {
        format!("{}::{}", file_module, parts[0])
    };
    let type_id = lookup.item_by_module_name.get(&ty_key).cloned();
    let method = parts[1];
    if let Some(tid) = type_id {
        if let Some(mid) = method_of_owner_for_type(parts[0], method, file, lookup) {
            let _ = tid;
            return Some(mid);
        }
        // trait-dispatch call: `Trait::method(&x)` — the trait name resolved;
        // find the method among `impl Trait for ...` blocks
        if let Some(mid) = method_of_trait(parts[0], method, lookup) {
            return Some(mid);
        }
        return None;
    }
    // type not found as item — maybe a trait in that module
    let _ = from_rel;
    lookup
        .item_by_module_name
        .get(&format!("{}::{}", file_module, parts[0]))
        .cloned()
        .and_then(|_| method_of_owner(parts[0], method, file, lookup))
}

/// Method of a trait (resolved via `impl Trait for Type` blocks).
fn method_of_trait(trait_name: &str, method: &str, lookup: &LookupMaps) -> Option<String> {
    let ids = lookup.methods_by_trait.get(trait_name)?;
    // id shapes: `rel::Owner.method` (inherent) / `rel::Owner.method::Trait`
    ids.iter()
        .find(|id| id.ends_with(&format!(".{}", method)) || id.contains(&format!(".{}::", method)))
        .cloned()
}

/// Method of an owner type: same-file preferred, then any file.
fn method_of_owner(owner: &str, method: &str, file: &str, lookup: &LookupMaps) -> Option<String> {
    let ids = lookup.methods_by_owner.get(owner)?;
    // id shapes: `rel::Owner.method` / `rel::Owner.method::Trait`
    let matches = |id: &String| {
        id.ends_with(&format!(".{}", method)) || id.contains(&format!(".{}::", method))
    };
    let same_file = ids
        .iter()
        .find(|id| id.starts_with(&format!("{}::", file)) && matches(id));
    match same_file {
        Some(id) => Some(id.clone()),
        None => ids.iter().find(|id| matches(id)).cloned(),
    }
}

fn method_of_owner_for_type(
    owner: &str,
    method: &str,
    file: &str,
    lookup: &LookupMaps,
) -> Option<String> {
    method_of_owner(owner, method, file, lookup)
}

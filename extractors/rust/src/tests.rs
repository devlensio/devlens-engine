// tests.rs — TESTS edges from TEST leaf nodes to production symbols.
//
// Rust test naming (documented cargo convention): `fn test_foo` / `fn foo_test`
// inside #[cfg(test)] mods or `tests/` integration files. Resolution ladder:
//   1. same-file name-match (`test_helper` → `helper` in the same file)
//   2. the file's use symbol maps (integration tests `use crate::foo::bar` →
//      src symbol — the playbook's symbol-map refinement)
//   3. crate-wide name-match (closest_by_path)
// Sub-tests (t.Run equivalents — #[test] with nested logic) ride in
// metadata.testCases only (V1).

use crate::contract::{edge, CodeEdge};
use crate::extractor::{Options, ParsedRepo};
use crate::lookup::LookupMaps;
use crate::module_map::ModuleMap;

pub fn detect_tests(
    repo: &ParsedRepo,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    _opts: &Options,
) -> Vec<CodeEdge> {
    let mut edges = vec![];
    for pf in &repo.files {
        if !pf.is_test_file {
            continue;
        }
        let from = format!("file::{}", pf.rel_path);
        let base_module = crate::walker::module_path_for_file(&pf.rel_path);
        for name in &pf.test_fns {
            // 1. same-file name-match: test_helper → helper; helper_test → helper
            let candidate = strip_test_affix(name);
            if let Some(target) = same_file_symbol(&pf.rel_path, &candidate, lookup) {
                edges.push(edge(&from, &target, "TESTS"));
                continue;
            }
            // 2. use symbol maps: `use crate::models::user::User;` → user.rs
            if let Some(target) = use_map_symbol(pf, &candidate, &base_module, module_map, lookup) {
                edges.push(edge(&from, &target, "TESTS"));
                continue;
            }
            // 3. crate-wide name-match
            if let Some(target) = lookup.closest_by_path(&candidate, &pf.rel_path) {
                edges.push(edge(&from, &target, "TESTS"));
            }
        }
    }
    edges
}

fn strip_test_affix(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("test_") {
        return rest.to_string();
    }
    if let Some(rest) = name.strip_suffix("_test") {
        return rest.to_string();
    }
    name.to_string()
}

fn same_file_symbol(rel: &str, name: &str, lookup: &LookupMaps) -> Option<String> {
    let ids = lookup.nodes_by_name.get(name)?;
    ids.iter()
        .find(|id| id.starts_with(&format!("{}::", rel)))
        .cloned()
}

fn use_map_symbol(
    pf: &crate::parser::ParsedFile,
    name: &str,
    base_module: &str,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
) -> Option<String> {
    // direct: `use crate::x::Name;` — alias Name → path ending in Name
    if let Some(target) = lookup
        .symbol_maps
        .get(&pf.rel_path)
        .and_then(|syms| syms.get(name))
    {
        if let Some((file, rest)) = module_map.resolve(target, base_module) {
            if rest.is_empty() {
                // the use named a module — edge to its file
                return Some(format!("file::{}", file));
            }
            let file_module = crate::walker::module_path_for_file(&file);
            let key = if file_module.is_empty() {
                rest.clone()
            } else {
                format!("{}::{}", file_module, rest)
            };
            if let Some(id) = lookup.item_by_module_name.get(&key) {
                return Some(id.clone());
            }
            return lookup.closest_by_path(&rest, &file);
        }
    }
    // glob: `use crate::models::*;` — try each glob base
    if let Some(globs) = lookup.glob_maps.get(&pf.rel_path) {
        for g in globs {
            if let Some((file, _)) = module_map.resolve(&format!("{}::{}", g, name), base_module) {
                if let Some(id) = lookup.closest_by_path(name, &file) {
                    return Some(id);
                }
            }
        }
    }
    None
}

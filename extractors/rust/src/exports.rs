// exports.rs — the flattened public surface of a Rust crate, shipped in the
// ExtractorResult for cross-repo linking (docs/EXPORTS_MAP.md).
//
// Rust-specific concerns:
//   - The "door" is the crate root (src/lib.rs or src/main.rs). The map key
//     is the path an importer writes after the crate name:
//       pub fn run()               → "run"
//       pub mod foo + pub items    → "foo" (file node) and "foo::Item"
//       pub use a::B as C;         → "C" (binding-resolved, name-swap safe)
//       pub use foo::*;            → foo's pub items at the same level
//       pub methods of pub types   → "Type.method"
//   - `pub use` chains are flattened recursively through mod.rs files with a
//     visited guard — consumers of the map never walk re-export chains.
//   - Private mods (`mod foo;`) contribute nothing; only `pub mod` opens a
//     subpath. Inline `pub mod foo { ... }` bodies are out of scope for v1
//     (their items are parsed inside the same file's mod tree, not top-level).
//   - Values are ALWAYS arrays of proper nodeIds matching nodes.rs exactly
//     (func/struct/enum/trait: rel::name; inherent methods: rel::Type.method;
//     trait-impl methods are NOT surface — the trait defines them).
//   - Rust rejects duplicate re-exports at compile time, so ambiguousNames is
//     a safety net that should stay empty.
//   - Pure-test files and #[test] items are excluded.
//   - Workspace members other than the root crate are out of scope for v1.

use crate::module_map::ModuleMap;
use crate::parser::{ParsedFile, ParsedItem, KIND_ENUM, KIND_FUNCTION, KIND_METHOD, KIND_STRUCT, KIND_TRAIT};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportsMap {
    pub exports: BTreeMap<String, BTreeMap<String, Vec<String>>>,
    pub ambiguous_names: BTreeMap<String, Vec<String>>,
}

pub fn build_exports_map(files: &[ParsedFile], module_map: &ModuleMap) -> Option<ExportsMap> {
    let root = files
        .iter()
        .find(|f| f.rel_path == "src/lib.rs")
        .or_else(|| files.iter().find(|f| f.rel_path == "src/main.rs"))?;

    let index = ItemIndex::build(files);
    let mut ctx = Ctx {
        files,
        module_map,
        index,
        by_rel: files.iter().map(|f| (f.rel_path.clone(), f)).collect(),
    };

    let mut exports: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut ambiguous: Vec<String> = Vec::new();
    let mut visited = BTreeSet::new();
    collect_surface(&ctx, root, "", &mut exports, &mut ambiguous, &mut visited);

    if exports.is_empty() {
        return None;
    }
    Some(ExportsMap {
        exports: BTreeMap::from([(".".to_string(), exports)]),
        ambiguous_names: if ambiguous.is_empty() {
            BTreeMap::new()
        } else {
            BTreeMap::from([(".".to_string(), ambiguous)])
        },
    })
}

struct Ctx<'a> {
    files: &'a [ParsedFile],
    module_map: &'a ModuleMap,
    index: ItemIndex,
    by_rel: HashMap<String, &'a ParsedFile>,
}

/// (rel_path, item_name) → nodeIds, reconstructed with the SAME id helpers
/// nodes.rs uses, so map values are guaranteed joinable.
struct ItemIndex {
    by_file: HashMap<String, HashMap<String, Vec<String>>>,
    pub_types: BTreeSet<String>,
}

impl ItemIndex {
    fn build(files: &[ParsedFile]) -> Self {
        let mut by_file: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
        let mut pub_types = BTreeSet::new();
        for pf in files {
            if pf.is_pure_test_file {
                continue;
            }
            let mut names: HashMap<String, Vec<String>> = HashMap::new();
            for item in &pf.items {
                if item.is_test {
                    continue;
                }
                if let Some(id) = surface_node_id(pf, item) {
                    match item.kind {
                        KIND_STRUCT | KIND_ENUM | KIND_TRAIT => {
                            if item.is_pub {
                                pub_types.insert(item.name.clone());
                            }
                        }
                        _ => {}
                    }
                    names.entry(surface_key(item)).or_default().push(id);
                }
            }
            by_file.insert(pf.rel_path.clone(), names);
        }
        ItemIndex { by_file, pub_types }
    }

    fn get(&self, rel: &str, key: &str) -> Option<Vec<String>> {
        self.by_file.get(rel)?.get(key).cloned()
    }
}

fn surface_key(item: &ParsedItem) -> String {
    if item.kind == KIND_METHOD && !item.impl_target.is_empty() {
        format!("{}.{}", item.impl_target, item.name)
    } else {
        item.name.clone()
    }
}

/// nodeIds only for kinds that are import surface (impl blocks etc. excluded).
fn surface_node_id(pf: &ParsedFile, item: &ParsedItem) -> Option<String> {
    match item.kind {
        KIND_FUNCTION => Some(crate::lookup::func_node_id(&pf.rel_path, &item.name)),
        KIND_METHOD if item.impl_trait_path.is_none() && !item.impl_target.is_empty() => {
            Some(crate::lookup::method_node_id(
                &pf.rel_path,
                &item.impl_target,
                &item.name,
                None,
            ))
        }
        KIND_STRUCT => Some(crate::lookup::struct_node_id(&pf.rel_path, &item.name)),
        KIND_ENUM => Some(crate::lookup::enum_node_id(&pf.rel_path, &item.name)),
        KIND_TRAIT => Some(crate::lookup::trait_node_id(&pf.rel_path, &item.name)),
        _ => None,
    }
}

fn collect_surface(
    ctx: &Ctx,
    file: &ParsedFile,
    prefix: &str,
    exports: &mut BTreeMap<String, Vec<String>>,
    ambiguous: &mut Vec<String>,
    visited: &mut BTreeSet<String>,
) {
    let visit_key = format!("{}@{}", file.rel_path, prefix);
    if !visited.insert(visit_key) {
        return;
    }

    let base_module = crate::walker::module_path_for_file(&file.rel_path);
    let top_level = top_level_item_keys(file);

    for item in &file.items {
        if !item.is_pub || item.is_test {
            continue;
        }
        match item.kind {
            KIND_FUNCTION | KIND_STRUCT | KIND_ENUM | KIND_TRAIT => {
                // parser flattens inline-mod contents into file.items; only
                // DIRECT children of the file are crate surface (a `pub`
                // struct inside a PRIVATE `mod` is not importable).
                if !top_level.contains(&(item.kind.to_string(), item.name.clone())) {
                    continue;
                }
                if let Some(ids) = ctx.index.get(&file.rel_path, &surface_key(item)) {
                    record(exports, ambiguous, &format!("{}{}", prefix, item.name), ids);
                }
            }
            KIND_METHOD => {
                if item.impl_trait_path.is_none()
                    && !item.impl_target.is_empty()
                    && ctx.index.pub_types.contains(&item.impl_target)
                {
                    if let Some(ids) = ctx.index.get(&file.rel_path, &surface_key(item)) {
                        record(
                            exports,
                            ambiguous,
                            &format!("{}{}", prefix, surface_key(item)),
                            ids,
                        );
                    }
                }
            }
            _ => {}
        }
    }

    for u in &file.uses {
        if u.glob {
            if let Some((target_file, _rest)) = ctx.module_map.resolve_use(&u.target, &base_module) {
                if let Some(pf) = ctx.by_rel.get(&target_file) {
                    if pf.rel_path != file.rel_path {
                        collect_surface(ctx, pf, prefix, exports, ambiguous, visited);
                    }
                }
            }
            continue;
        }
        if let Some(ids) = resolve_use_target(ctx, file, &base_module, &u.target, &mut BTreeSet::new(), visited) {
            record(exports, ambiguous, &format!("{}{}", prefix, u.alias), ids);
        }
    }

    for m in pub_mods(file) {
        let module = if base_module.is_empty() {
            m.clone()
        } else {
            format!("{}::{}", base_module, m)
        };
        if let Some(pf) = ctx
            .module_map
            .resolve_use(&module, "")
            .and_then(|(f, _)| ctx.by_rel.get(&f).copied())
        {
            record(exports, ambiguous, &format!("{}{}", prefix, m), vec![format!("file::{}", pf.rel_path)]);
            collect_surface(ctx, pf, &format!("{}{}::", prefix, m), exports, ambiguous, visited);
        }
    }
}

/// Resolve one `use` target path to definition nodeIds, following bindings
/// through mod.rs files. Binding-based — never string-matched against names
/// the target file happens to reuse.
fn resolve_use_target(
    ctx: &Ctx,
    from_file: &ParsedFile,
    base_module: &str,
    target: &str,
    seen: &mut BTreeSet<(String, String)>,
    visited: &mut BTreeSet<String>,
) -> Option<Vec<String>> {
    let key = (from_file.rel_path.clone(), target.to_string());
    if !seen.insert(key) {
        return None;
    }

    let (file, rest) = ctx.module_map.resolve_use(target, base_module)?;
    let pf = ctx.by_rel.get(&file)?;

    if rest.is_empty() {
        let mut ids = vec![format!("file::{}", pf.rel_path)];
        if pf.rel_path != from_file.rel_path {
            collect_surface_into(ctx, pf, visited, &mut ids);
        }
        return Some(ids);
    }

    let segs: Vec<&str> = rest.split("::").collect();
    let name = segs[segs.len() - 1];

    if let Some(ids) = ctx.index.get(&pf.rel_path, name) {
        return Some(ids);
    }

    let module_of_file = crate::walker::module_path_for_file(&pf.rel_path);

    // re-export chains: the target file may bind the name via its own `use`
    // (incl. `pub use` re-exports) — follow the binding, never string-match.
    if let Some(first) = segs.first() {
        let rest_after: String = segs[1..].join("::");
        for u in &pf.uses {
            if u.glob || u.alias != *first {
                continue;
            }
            if rest_after.is_empty() {
                return resolve_use_target(ctx, pf, &module_of_file, &u.target, seen, visited);
            }
            if let Some((bf, brest)) = ctx.module_map.resolve_use(&u.target, &module_of_file) {
                let bpf = ctx.by_rel.get(&bf)?;
                let combined = if brest.is_empty() {
                    rest_after.clone()
                } else {
                    format!("{}::{}", brest, rest_after)
                };
                return resolve_use_target(
                    ctx,
                    bpf,
                    &crate::walker::module_path_for_file(&bf),
                    &combined,
                    seen,
                    visited,
                );
            }
        }
    }
    let mut module = module_of_file.clone();
    for seg in &segs {
        module = if module.is_empty() {
            seg.to_string()
        } else {
            format!("{}::{}", module, seg)
        };
        if let Some((sub_file, sub_rest)) = ctx.module_map.resolve_use(&module, "") {
            if sub_rest.is_empty() {
                let sub_pf = ctx.by_rel.get(&sub_file)?;
                if segs.len() == 1 || *seg == name {
                    return Some(vec![format!("file::{}", sub_pf.rel_path)]);
                }
                let remaining = segs[segs.iter().position(|s| *s == *seg).unwrap() + 1..].join("::");
                if remaining.is_empty() {
                    return Some(vec![format!("file::{}", sub_pf.rel_path)]);
                }
                return resolve_use_target(ctx, sub_pf, &module_of_file, &remaining, seen, visited);
            }
        }
    }

    None
}

fn collect_surface_into(ctx: &Ctx, pf: &ParsedFile, visited: &mut BTreeSet<String>, ids: &mut Vec<String>) {
    let base_module = crate::walker::module_path_for_file(&pf.rel_path);
    for item in &pf.items {
        if item.is_pub && !item.is_test {
            if let Some(id) = surface_node_id(pf, item) {
                ids.push(id);
            }
        }
    }
    for u in &pf.uses {
        if u.glob {
            continue;
        }
        if let Some(resolved) = resolve_use_target(ctx, pf, &base_module, &u.target, &mut BTreeSet::new(), visited) {
            ids.extend(resolved);
        }
    }
}

fn top_level_item_keys(file: &ParsedFile) -> std::collections::HashSet<(String, String)> {
    let mut out = std::collections::HashSet::new();
    for item in &file.ast.items {
        let key = match item {
            syn::Item::Fn(f) => ("FUNCTION".to_string(), f.sig.ident.to_string()),
            syn::Item::Struct(s) => ("STRUCT".to_string(), s.ident.to_string()),
            syn::Item::Enum(e) => ("ENUM".to_string(), e.ident.to_string()),
            syn::Item::Trait(t) => ("TRAIT".to_string(), t.ident.to_string()),
            _ => continue,
        };
        out.insert(key);
    }
    out
}

fn pub_mods(file: &ParsedFile) -> Vec<String> {
    let mut out = Vec::new();
    for item in &file.ast.items {
        if let syn::Item::Mod(m) = item {
            if matches!(m.vis, syn::Visibility::Public(_)) && m.content.is_none() {
                out.push(m.ident.to_string());
            }
        }
    }
    out
}

fn record(
    exports: &mut BTreeMap<String, Vec<String>>,
    ambiguous: &mut Vec<String>,
    key: &str,
    ids: Vec<String>,
) {
    let unique: Vec<String> = {
        let mut s: Vec<String> = ids;
        s.sort();
        s.dedup();
        s
    };
    if unique.is_empty() {
        return;
    }
    if let Some(existing) = exports.get(key) {
        if existing != &unique {
            ambiguous.push(key.to_string());
        }
        return;
    }
    exports.insert(key.to_string(), unique);
}

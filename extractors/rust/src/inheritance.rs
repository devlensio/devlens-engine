// inheritance.rs — IMPLEMENTS + EXTENDS edges (mirrors go/inheritance.go).
//
// IMPLEMENTS (documented Rust semantics — impl blocks ARE the mechanism):
//   `impl Trait for Type`  → IMPLEMENTS Type→Trait (local TRAIT node; external
//                            trait → gated [crate]/name::Trait member node —
//                            parity with Go's external gorm.Model embeds)
//   plain `impl Type`      → IMPLEMENTS IMPL_BLOCK→STRUCT (the tracker/
//                            phase-5.html convention: the impl block attaches
//                            to its target type)
// EXTENDS:
//   trait supertraits `trait Child: Parent` → EXTENDS Child→Parent (Rust's
//                            documented inheritance mechanism)
//   #[derive(LocalTrait)]  → EXTENDS struct→trait when the derive resolves to
//                            a LOCAL trait (rare; flagged heuristic)

use crate::contract::{edge, CodeEdge};
use crate::extractor::{Options, ParsedRepo};
use crate::fingerprint::ParsedManifest;
use crate::lookup::LookupMaps;
use crate::module_map::ModuleMap;
use crate::parser::ParsedFile;
use crate::thirdparty::ThirdPartyRegistry;

pub struct InheritanceOutput {
    pub edges: Vec<CodeEdge>,
    pub third_party_nodes: Vec<crate::contract::CodeNode>,
}

pub fn detect_inheritance(
    repo: &ParsedRepo,
    mf: &ParsedManifest,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    tp: &mut ThirdPartyRegistry,
    _opts: &Options,
) -> InheritanceOutput {
    let mut edges = vec![];
    let mut nodes = vec![];
    for pf in &repo.files {
        if pf.is_test_file {
            continue;
        }
        for item in &pf.items {
            if item.is_test {
                continue;
            }
            match item.kind {
                crate::parser::KIND_IMPL_BLOCK => {
                    let impl_id = crate::lookup::node_id_for_item(&pf.rel_path, item);
                    let target = &item.impl_target;
                    if target.is_empty() {
                        continue;
                    }
                    if let Some(trait_path) = &item.impl_trait_path {
                        // impl Trait for Type → Type IMPLEMENTS Trait
                        if let Some(type_id) = resolve_type_id(target, pf, module_map, lookup) {
                            if let Some(trait_id) = resolve_trait_id(
                                trait_path, pf, module_map, lookup, mf, tp, &mut nodes,
                            ) {
                                edges.push(edge(&type_id, &trait_id, "IMPLEMENTS"));
                            }
                        }
                    } else {
                        // plain impl Type → IMPL_BLOCK IMPLEMENTS STRUCT
                        if let Some(type_id) = resolve_type_id(target, pf, module_map, lookup) {
                            edges.push(edge(&impl_id, &type_id, "IMPLEMENTS"));
                        }
                    }
                }
                crate::parser::KIND_TRAIT => {
                    // supertraits: trait Child: Parent → EXTENDS Child→Parent
                    let child_id = crate::lookup::node_id_for_item(&pf.rel_path, item);
                    for st in &item.supertraits {
                        if let Some(parent_id) =
                            resolve_trait_id(st, pf, module_map, lookup, mf, tp, &mut nodes)
                        {
                            edges.push(edge(&child_id, &parent_id, "EXTENDS"));
                        }
                    }
                }
                crate::parser::KIND_STRUCT | crate::parser::KIND_ENUM => {
                    // derives resolving to LOCAL traits → EXTENDS (heuristic)
                    let id = crate::lookup::node_id_for_item(&pf.rel_path, item);
                    for d in &item.derives {
                        if is_std_derive(d) {
                            continue;
                        }
                        let base_module = crate::walker::module_path_for_file(&pf.rel_path);
                        if let Some((file, rest)) = module_map.resolve(d, &base_module) {
                            let name = if rest.is_empty() {
                                d.rsplit("::").next().unwrap_or(d)
                            } else {
                                rest.split("::").next().unwrap_or(&rest)
                            };
                            let file_module = crate::walker::module_path_for_file(&file);
                            let key = if file_module.is_empty() {
                                name.to_string()
                            } else {
                                format!("{}::{}", file_module, name)
                            };
                            if let Some(tid) = lookup.item_by_module_name.get(&key).cloned() {
                                if lookup
                                    .get(&tid)
                                    .map(|n| n.node_type == "TRAIT")
                                    .unwrap_or(false)
                                {
                                    edges.push(edge(&id, &tid, "EXTENDS"));
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let _ = mf;
    InheritanceOutput {
        edges,
        third_party_nodes: nodes,
    }
}

/// Common derives that are never local traits (std + well-known derives).
fn is_std_derive(d: &str) -> bool {
    matches!(
        d,
        "Debug"
            | "Clone"
            | "Copy"
            | "PartialEq"
            | "Eq"
            | "PartialOrd"
            | "Ord"
            | "Hash"
            | "Default"
            | "Serialize"
            | "Deserialize"
            | "Queryable"
            | "Insertable"
            | "QueryableByName"
            | "Associations"
            | "Identifiable"
            | "AsChangeset"
            | "Selectable"
            | "FromRow"
            | "DebugWith"
            | "thiserror::Error"
            | "Error"
    )
}

/// Resolve a type path (`User`, `models::User`, `crate::models::user::User`)
/// to its STRUCT/ENUM node id.
fn resolve_type_id(
    target: &str,
    pf: &ParsedFile,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
) -> Option<String> {
    let base_module = crate::walker::module_path_for_file(&pf.rel_path);
    if let Some((file, rest)) = module_map.resolve(target, &base_module) {
        let file_module = crate::walker::module_path_for_file(&file);
        let name = if rest.is_empty() {
            target.rsplit("::").next().unwrap_or(target).to_string()
        } else {
            rest.split("::").next().unwrap_or(&rest).to_string()
        };
        let key = if file_module.is_empty() {
            name.clone()
        } else {
            format!("{}::{}", file_module, name)
        };
        if let Some(id) = lookup.item_by_module_name.get(&key) {
            return Some(id.clone());
        }
        // generic target like `Vec<T>` — strip generics, try the base name
        if let Some(open) = name.find('<') {
            let base = name[..open].to_string();
            let key = if file_module.is_empty() {
                base.clone()
            } else {
                format!("{}::{}", file_module, base)
            };
            return lookup.item_by_module_name.get(&key).cloned();
        }
        return None;
    }
    // same-file name
    lookup.closest_by_path(target, &pf.rel_path)
}

/// Resolve a trait path to its node id — local TRAIT node, or (external) a
/// gated [crate]/name::Trait member node.
fn resolve_trait_id(
    trait_path: &str,
    pf: &ParsedFile,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    mf: &ParsedManifest,
    tp: &mut ThirdPartyRegistry,
    nodes: &mut Vec<crate::contract::CodeNode>,
) -> Option<String> {
    let base_module = crate::walker::module_path_for_file(&pf.rel_path);
    if let Some((file, rest)) = module_map.resolve(trait_path, &base_module) {
        let file_module = crate::walker::module_path_for_file(&file);
        let name = if rest.is_empty() {
            trait_path.rsplit("::").next().unwrap_or(trait_path)
        } else {
            rest.split("::").next().unwrap_or(&rest)
        };
        let key = if file_module.is_empty() {
            name.to_string()
        } else {
            format!("{}::{}", file_module, name)
        };
        return lookup.item_by_module_name.get(&key).cloned();
    }
    // external trait (serde::Serialize) → gated [crate]/name::Trait member
    let first = crate::thirdparty::first_segment(trait_path);
    if crate::thirdparty::is_std(first) {
        return None;
    }
    if !crate::thirdparty::is_external_crate(first, mf) {
        return None;
    }
    if let Some(node) = tp.member_node(first, &trait_path[first.len() + 1..]) {
        let id = node.id.clone();
        nodes.push(node);
        return Some(id);
    }
    None
}

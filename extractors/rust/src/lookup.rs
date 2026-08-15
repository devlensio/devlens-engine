// lookup.rs — LookupMaps: ONE shared index built once from parsed facts,
// consumed by every edge detector. Edge resolution is dict lookups only —
// never re-walks ASTs (playbook rule). Mirrors go/lookup.go.

use crate::contract::CodeNode;
use crate::parser::{ParsedFile, ParsedItem};
use std::collections::HashMap;

pub struct LookupMaps {
    /// node id → node (all emitted nodes register here)
    pub node_by_id: HashMap<String, CodeNode>,
    /// file node per rel path
    pub file_nodes_by_path: HashMap<String, String>,
    /// plain name → node ids (collisions disambiguated by closest_by_path)
    pub nodes_by_name: HashMap<String, Vec<String>>,
    /// symbol maps: rel file → alias → resolved use target
    /// (e.g. "User" → "crate::models::user::User") — the bridge for
    /// Calls/Routes/Tests (mirrors python's symbol_maps)
    pub symbol_maps: HashMap<String, HashMap<String, String>>,
    /// glob use targets per file: alias-less → base path ("crate::models")
    pub glob_maps: HashMap<String, Vec<String>>,
    /// module_path::Name → node id (exact resolution; Rust names are unique
    /// per module, so no closest_by_path needed here)
    pub item_by_module_name: HashMap<String, String>,
    /// impl owner (target type) → METHOD ids (for receiver-free lookups)
    pub methods_by_owner: HashMap<String, Vec<String>>,
    /// trait name (last segment) → METHOD ids from `impl Trait for ...` blocks
    /// — resolves `Entity::table_name(&x)` trait-dispatch calls
    pub methods_by_trait: HashMap<String, Vec<String>>,
}

impl LookupMaps {
    pub fn new() -> Self {
        LookupMaps {
            node_by_id: HashMap::new(),
            file_nodes_by_path: HashMap::new(),
            nodes_by_name: HashMap::new(),
            symbol_maps: HashMap::new(),
            glob_maps: HashMap::new(),
            item_by_module_name: HashMap::new(),
            methods_by_owner: HashMap::new(),
            methods_by_trait: HashMap::new(),
        }
    }

    pub fn register(&mut self, node: CodeNode) {
        let id = node.id.clone();
        let name = node.name.clone();
        self.node_by_id.insert(id.clone(), node);
        self.nodes_by_name.entry(name).or_default().push(id);
    }

    pub fn get(&self, id: &str) -> Option<&CodeNode> {
        self.node_by_id.get(id)
    }

    /// name lookup with file proximity: prefer nodes in the same file
    /// (python/go closest_by_path trick).
    pub fn closest_by_path(&self, name: &str, rel_path: &str) -> Option<String> {
        let ids = self.nodes_by_name.get(name)?;
        if ids.is_empty() {
            return None;
        }
        if ids.len() == 1 {
            return Some(ids[0].clone());
        }
        ids.iter()
            .find(|id| id.starts_with(&format!("{}::", rel_path)))
            .cloned()
            .or_else(|| ids.first().cloned())
    }
}

// ── node id schemes (deterministic, file-scoped — mirrors go) ──

pub fn func_node_id(rel: &str, name: &str) -> String {
    format!("{}::{}", rel, name)
}

pub fn method_node_id(rel: &str, owner: &str, method: &str, trait_path: Option<&str>) -> String {
    match trait_path {
        Some(t) => format!("{}::{}.{}::{}", rel, owner, method, last_seg(t)),
        None => format!("{}::{}.{}", rel, owner, method),
    }
}

pub fn struct_node_id(rel: &str, name: &str) -> String {
    format!("{}::{}", rel, name)
}

pub fn enum_node_id(rel: &str, name: &str) -> String {
    format!("{}::{}", rel, name)
}

pub fn trait_node_id(rel: &str, name: &str) -> String {
    format!("{}::{}", rel, name)
}

pub fn impl_block_node_id(rel: &str, label: &str, start_line: i64) -> String {
    format!("{}::{} [L{}]", rel, label, start_line)
}

pub fn third_party_id(crate_name: &str) -> String {
    format!("[crate]/{}", crate_name)
}

pub fn last_seg(p: &str) -> String {
    p.rsplit("::").next().unwrap_or(p).to_string()
}

/// The code-node id for a parsed item (shared by nodes.rs, calls.rs,
/// routes.rs — ONE source of truth for id computation).
pub fn node_id_for_item(rel: &str, item: &ParsedItem) -> String {
    match item.kind {
        crate::parser::KIND_FUNCTION => func_node_id(rel, &item.name),
        crate::parser::KIND_METHOD => method_node_id(
            rel,
            &item.impl_target,
            &item.name,
            item.impl_trait_path.as_deref(),
        ),
        crate::parser::KIND_STRUCT => struct_node_id(rel, &item.name),
        crate::parser::KIND_ENUM => enum_node_id(rel, &item.name),
        crate::parser::KIND_TRAIT => trait_node_id(rel, &item.name),
        crate::parser::KIND_IMPL_BLOCK => {
            let label = if item.impl_trait.is_some() {
                format!(
                    "impl {} for {}",
                    item.impl_trait_path.as_deref().unwrap_or(""),
                    item.impl_target
                )
            } else {
                format!("impl {}", item.impl_target)
            };
            impl_block_node_id(rel, &label, item.start_line)
        }
        _ => String::new(),
    }
}

/// Build lookup maps from parsed facts. `files_by_rel` maps rel → ParsedFile.
pub fn build_lookup_maps(files: &[ParsedFile], nodes: &[CodeNode]) -> LookupMaps {
    let mut l = LookupMaps::new();

    // file nodes
    for pf in files {
        l.file_nodes_by_path
            .insert(pf.rel_path.clone(), format!("file::{}", pf.rel_path));
    }

    // code nodes (already built by nodes.rs — register + index)
    for n in nodes {
        l.register(n.clone());
    }

    // symbol maps from use declarations
    for pf in files {
        let mut syms: HashMap<String, String> = HashMap::new();
        let mut globs: Vec<String> = vec![];
        for u in &pf.uses {
            if u.glob {
                globs.push(u.target.clone());
            } else if !u.alias.is_empty() {
                syms.insert(u.alias.clone(), u.target.clone());
            }
        }
        l.symbol_maps.insert(pf.rel_path.clone(), syms);
        l.glob_maps.insert(pf.rel_path.clone(), globs);
    }

    // item maps + impl indexes from parsed items
    for pf in files {
        let module_path = crate::walker::module_path_for_file(&pf.rel_path);
        for item in &pf.items {
            match item.kind {
                crate::parser::KIND_STRUCT
                | crate::parser::KIND_ENUM
                | crate::parser::KIND_TRAIT => {
                    let key = if module_path.is_empty() {
                        item.name.clone()
                    } else {
                        format!("{}::{}", module_path, item.name)
                    };
                    // prefer the code-node id (impl_blocks have line labels)
                    let id = struct_node_id(&pf.rel_path, &item.name);
                    l.item_by_module_name.insert(key, id);
                }
                crate::parser::KIND_FUNCTION => {
                    let key = if module_path.is_empty() {
                        item.name.clone()
                    } else {
                        format!("{}::{}", module_path, item.name)
                    };
                    l.item_by_module_name
                        .insert(key, func_node_id(&pf.rel_path, &item.name));
                }
                crate::parser::KIND_METHOD => {
                    // owner = impl target (set by the impl block's item); the
                    // method ParsedItem carries it via impl_target? — methods
                    // are collected inside impl blocks; we resolve the owner
                    // from the enclosing impl in nodes.rs; here we just index
                    // what nodes.rs emitted via item_by_module_name too
                    let owner = &item.impl_target;
                    if !owner.is_empty() {
                        let mid = crate::lookup::method_node_id(
                            &pf.rel_path,
                            owner,
                            &item.name,
                            item.impl_trait_path.as_deref(),
                        );
                        l.methods_by_owner
                            .entry(owner.clone())
                            .or_default()
                            .push(mid.clone());
                        if let Some(t) = &item.impl_trait_path {
                            let tname = crate::lookup::last_seg(t);
                            l.methods_by_trait.entry(tname).or_default().push(mid);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    l
}

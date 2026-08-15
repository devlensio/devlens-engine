// nodes.rs — CodeNode building from parsed facts (mirrors go/nodes.go).
//
// Contract rules enforced here:
//   - FILE id `file::rel/path.rs`; file nodes parent themselves
//   - TEST files (any #[test] fn) = LEAF nodes: nodes=[] for them, test fns
//     ride in metadata.testCases only (the bug that shipped in Python's
//     parser — asserted in the bun suite)
//   - rawCode + codeHash on every FUNCTION/METHOD/STRUCT/ENUM/TRAIT/IMPL_BLOCK
//   - deterministic ids (file-scoped; trait-impl method suffix for the
//     same-name-different-trait collision class)

use crate::contract::{base_metadata, code_node, file_node, CodeNode, NODE_FILE, NODE_TEST};
use crate::parser::{ParsedFile, ParsedItem};
use serde_json::{Map, Value};

/// FILE (or TEST leaf) nodes — always parents of their file's children.
pub fn collect_file_nodes(files: &[ParsedFile]) -> Vec<CodeNode> {
    let mut out = vec![];
    for pf in files {
        if pf.is_test_file {
            let mut n = file_node(&pf.rel_path, pf.line_count, NODE_TEST);
            let meta = n
                .metadata
                .entry("testCases".to_string())
                .or_insert_with(|| Value::Array(vec![]));
            if let Value::Array(arr) = meta {
                for t in &pf.test_fns {
                    arr.push(Value::from(t.clone()));
                }
            }
            out.push(n);
        } else {
            out.push(file_node(&pf.rel_path, pf.line_count, NODE_FILE));
        }
    }
    out
}

/// Code nodes (FUNCTION/METHOD/STRUCT/ENUM/TRAIT/IMPL_BLOCK) — test fns are
/// NOT emitted (leaf rule); they feed metadata.testCases only.
pub fn collect_code_nodes(files: &[ParsedFile]) -> Vec<CodeNode> {
    let mut out = vec![];
    for pf in files {
        if pf.is_test_file {
            continue;
        }
        for item in &pf.items {
            if item.is_test {
                continue;
            }
            out.push(item_node(pf, item));
        }
    }
    out
}

fn item_node(pf: &ParsedFile, item: &ParsedItem) -> CodeNode {
    let mut meta = base_metadata();
    meta.insert("isPublic".to_string(), Value::from(item.is_pub));
    if item.is_async {
        meta.insert("isAsync".to_string(), Value::from(true));
    }
    if item.receiver.contains("self") {
        meta.insert("receiver".to_string(), Value::from(item.receiver.clone()));
    }

    let (id, node_type, name) = match item.kind {
        crate::parser::KIND_FUNCTION => (
            crate::lookup::func_node_id(&pf.rel_path, &item.name),
            "FUNCTION",
            item.name.clone(),
        ),
        crate::parser::KIND_METHOD => {
            let owner = item.impl_target.clone();
            let trait_path = item.impl_trait_path.clone();
            let id = crate::lookup::method_node_id(
                &pf.rel_path,
                &owner,
                &item.name,
                trait_path.as_deref(),
            );
            meta.insert("parentStruct".to_string(), Value::from(owner.clone()));
            if let Some(t) = &trait_path {
                meta.insert("traitPath".to_string(), Value::from(t.clone()));
            }
            (id, "METHOD", item.name.clone())
        }
        crate::parser::KIND_STRUCT => {
            let id = crate::lookup::struct_node_id(&pf.rel_path, &item.name);
            if !item.fields.is_empty() {
                let fields: Vec<Value> = item
                    .fields
                    .iter()
                    .map(|f| Value::from(f.name.clone()))
                    .collect();
                meta.insert("fields".to_string(), Value::Array(fields));
            }
            if !item.derives.is_empty() {
                let d: Vec<Value> = item
                    .derives
                    .iter()
                    .map(|d| Value::from(d.clone()))
                    .collect();
                meta.insert("derives".to_string(), Value::Array(d));
            }
            (id, "STRUCT", item.name.clone())
        }
        crate::parser::KIND_ENUM => {
            let id = crate::lookup::enum_node_id(&pf.rel_path, &item.name);
            if !item.variants.is_empty() {
                let v: Vec<Value> = item
                    .variants
                    .iter()
                    .map(|v| Value::from(v.clone()))
                    .collect();
                meta.insert("variants".to_string(), Value::Array(v));
            }
            (id, "ENUM", item.name.clone())
        }
        crate::parser::KIND_TRAIT => {
            let id = crate::lookup::trait_node_id(&pf.rel_path, &item.name);
            if !item.supertraits.is_empty() {
                let s: Vec<Value> = item
                    .supertraits
                    .iter()
                    .map(|s| Value::from(s.clone()))
                    .collect();
                meta.insert("supertraits".to_string(), Value::Array(s));
            }
            (id, "TRAIT", item.name.clone())
        }
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
            let id = crate::lookup::impl_block_node_id(&pf.rel_path, &label, item.start_line);
            if let Some(t) = &item.impl_trait_path {
                meta.insert("traitPath".to_string(), Value::from(t.clone()));
            }
            if !item.impl_target.is_empty() {
                meta.insert(
                    "implTarget".to_string(),
                    Value::from(item.impl_target.clone()),
                );
            }
            (id, "IMPL_BLOCK", label)
        }
        _ => return code_node("", "", "", "", 0, 0, "", Map::new()),
    };

    let mut n = code_node(
        &id,
        &pf.rel_path,
        &name,
        node_type,
        item.start_line,
        item.end_line,
        &item.raw_code,
        meta,
    );
    // metadata.calls — contract compliance + LLM context (the orchestrator
    // never resolves them for subprocess languages, but they must be present)
    if !item.calls.is_empty() {
        let calls: Vec<Value> = item.calls.iter().map(|c| Value::from(c.clone())).collect();
        n.metadata.insert("calls".to_string(), Value::Array(calls));
    }
    n
}

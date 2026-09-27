// nodes.rs — CodeNode building from parsed facts (mirrors go/nodes.go).
//
// Contract rules enforced here:
//   - FILE id `file::rel/path.rs`; file nodes parent themselves
//   - PURE test files (tests/ integration files, or files whose every item is
//     a #[test] fn) = LEAF TEST nodes; Rust's idiomatic inline #[cfg(test)]
//     mod tests must NOT collapse a mixed production file — its non-test items
//     emit normally and #[test] fns emit as FUNCTION nodes flagged
//     metadata.isTestFunction (test bodies stay out of prod call edges there)
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
        if pf.is_pure_test_file {
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
            let mut n = file_node(&pf.rel_path, pf.line_count, NODE_FILE);
            // Mixed files keep a testCases index so consumers that never walk
            // FUNCTION nodes still see the file's tests.
            if !pf.test_fns.is_empty() {
                let meta = n
                    .metadata
                    .entry("testCases".to_string())
                    .or_insert_with(|| Value::Array(vec![]));
                if let Value::Array(arr) = meta {
                    for t in &pf.test_fns {
                        arr.push(Value::from(t.clone()));
                    }
                }
            }
            out.push(n);
        }
    }
    out
}

/// Code nodes. PURE test files stay leaves (their fns ride in testCases).
/// Mixed files emit ALL items; #[test] fns are flagged metadata.isTestFunction
/// instead of being dropped, so a test function is addressable without a new
/// node type.
pub fn collect_code_nodes(files: &[ParsedFile]) -> Vec<CodeNode> {
    let mut out = vec![];
    for pf in files {
        if pf.is_pure_test_file {
            continue;
        }
        for item in &pf.items {
            let mut n = item_node(pf, item);
            if item.is_test {
                n.metadata
                    .insert("isTestFunction".to_string(), Value::from(true));
            }
            out.push(n);
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

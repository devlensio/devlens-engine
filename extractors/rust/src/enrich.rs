// enrich.rs — semantic metadata markers applied as a final pass over the
// emitted nodes (mirrors go's enrich.go + python's edges/enrich.py).
//
// Memo-isolation rule (python incident 10): each marker scan derives from
// parsed facts independently — no shared memo map that could carry a cached
// miss between scans.
//
// Markers:
//   isModel / modelType / tableName / tableColumns — Diesel structs
//   isHandler / handlerKind — targets of HANDLES edges (routes.rs emitted)
//   isPublic / receiver / isAsync — already set in nodes.rs

use crate::contract::CodeNode;
use crate::extractor::ParsedRepo;

pub fn enrich_nodes(
    repo: &ParsedRepo,
    nodes: &mut [CodeNode],
    handles_edges: &[crate::contract::CodeEdge],
) {
    // ── isHandler: any node that is a HANDLES target ──
    let mut handler_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in handles_edges {
        if e.edge_type == "HANDLES" {
            handler_ids.insert(e.to.clone());
        }
    }
    // handlerKind from the HANDLES edge metadata
    let mut handler_kinds: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for e in handles_edges {
        if e.edge_type == "HANDLES" {
            if let Some(meta) = &e.metadata {
                if let Some(k) = meta.get("handlerKind").and_then(|v| v.as_str()) {
                    handler_kinds.insert(e.to.clone(), k.to_string());
                }
            }
        }
    }

    // ── Diesel model facts (re-derived from parsed items — orm_edges.rs
    //    computes the same map for edge targets; single source = facts) ──
    let table_to_model = crate::orm_edges::table_to_model_map(repo);
    // table name → columns (for tableColumns metadata)
    let mut table_columns: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for pf in &repo.files {
        for t in &pf.tables {
            table_columns
                .entry(t.name.clone())
                .or_default()
                .extend(t.columns.iter().map(|(n, _)| n.clone()));
        }
    }

    // model id → table name (looked up via the item facts)
    let mut model_table: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for pf in &repo.files {
        if pf.is_test_file {
            continue;
        }
        for item in &pf.items {
            if item.kind == crate::parser::KIND_STRUCT && !item.is_test {
                let id = crate::lookup::struct_node_id(&pf.rel_path, &item.name);
                if table_to_model.values().any(|v| v == &id) {
                    let tn = crate::orm_edges::diesel_table_name(item);
                    if !tn.is_empty() {
                        model_table.insert(id, tn);
                    }
                }
            }
        }
    }

    for n in nodes.iter_mut() {
        if n.node_type != "FILE" && n.node_type != "TEST" {
            if handler_ids.contains(&n.id) {
                n.metadata.insert("isHandler".to_string(), true.into());
                if let Some(k) = handler_kinds.get(&n.id) {
                    n.metadata.insert(
                        "handlerKind".to_string(),
                        serde_json::Value::from(k.clone()),
                    );
                }
            }
            if table_to_model.values().any(|v| v == &n.id) {
                n.metadata.insert("isModel".to_string(), true.into());
                n.metadata.insert("modelType".to_string(), "diesel".into());
                if let Some(tn) = model_table.get(&n.id) {
                    n.metadata
                        .insert("tableName".to_string(), serde_json::Value::from(tn.clone()));
                    if let Some(cols) = table_columns.get(tn) {
                        n.metadata.insert(
                            "tableColumns".to_string(),
                            serde_json::Value::Array(
                                cols.iter()
                                    .map(|c| serde_json::Value::from(c.clone()))
                                    .collect(),
                            ),
                        );
                    }
                }
            }
        }
    }
}

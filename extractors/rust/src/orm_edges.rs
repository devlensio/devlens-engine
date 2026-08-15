// orm_edges.rs — Diesel data layer: table! concepts + model structs →
// READS_FROM / WRITES_TO edges (consumer → store, mirroring stateEdges.ts).
//
// Model detection (documented diesel API):
//   - struct with #[derive(Queryable, Insertable, ...)] and/or
//     #[diesel(table_name = users)] (legacy #[table_name = "users"]) → model
// R/W grammar (diesel query DSL):
//   READ  — users::table.filter/.first/.get_result/.get_results/.load/.find
//   WRITE — diesel::insert_into(users::table) / users::table.insert(...) /
//           diesel::update(users::table) / diesel::delete(...)
// Target: the model STRUCT whose table_name matches; fallback = the FILE
// containing the table! decl (no TABLE node type in types.ts — documented).
// sqlx raw SQL → V2 (documented). isModel/tableName metadata enrichment
// happens in enrich.rs (same facts, single source).

use crate::contract::{edge, CodeEdge, EDGE_READS_FROM, EDGE_WRITES_TO};
use crate::extractor::{Options, ParsedRepo};
use std::collections::HashMap;

/// table name → model struct node id
pub fn table_to_model_map(repo: &ParsedRepo) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pf in &repo.files {
        if pf.is_test_file {
            continue;
        }
        for item in &pf.items {
            if item.kind != crate::parser::KIND_STRUCT || item.is_test {
                continue;
            }
            let is_diesel_model = item.derives.iter().any(|d| {
                d == "Queryable"
                    || d == "Insertable"
                    || d == "QueryableByName"
                    || d == "Associations"
                    || d == "Identifiable"
            }) || item.attrs.iter().any(|a| {
                (a.path == "diesel" && a.args.contains("table_name")) || a.path == "table_name"
            });
            if !is_diesel_model {
                continue;
            }
            let table_name = diesel_table_name(item);
            if !table_name.is_empty() {
                let id = crate::lookup::struct_node_id(&pf.rel_path, &item.name);
                map.insert(table_name, id);
            }
        }
    }
    map
}

/// table name → file containing the table! decl (fallback store target).
pub fn table_to_schema_file_map(repo: &ParsedRepo) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pf in &repo.files {
        for t in &pf.tables {
            map.insert(t.name.clone(), pf.rel_path.clone());
        }
    }
    map
}

/// Parse the table name from #[diesel(table_name = users)] /
/// #[table_name = "users"] (legacy diesel 1.x).
pub fn diesel_table_name(item: &crate::parser::ParsedItem) -> String {
    for a in &item.attrs {
        if a.path == "diesel" && a.args.contains("table_name") {
            if let Some((_, v)) = a.args.split_once('=') {
                return v.trim().trim_matches('"').to_string();
            }
        } else if a.path == "table_name" {
            return a.args.trim().trim_matches('"').to_string();
        }
    }
    String::new()
}

pub fn detect_orm_edges(
    repo: &ParsedRepo,
    _lookup: &crate::lookup::LookupMaps,
    _opts: &Options,
) -> Vec<CodeEdge> {
    let mut edges = vec![];
    if repo.files.is_empty() {
        return edges;
    }
    let table_to_model = table_to_model_map(repo);
    let table_to_schema_file = table_to_schema_file_map(repo);

    for pf in &repo.files {
        if pf.is_test_file {
            continue;
        }
        for item in &pf.items {
            if item.is_test || item.orm_calls.is_empty() {
                continue;
            }
            if item.kind != crate::parser::KIND_FUNCTION && item.kind != crate::parser::KIND_METHOD
            {
                continue;
            }
            let from = crate::lookup::node_id_for_item(&pf.rel_path, item);
            for oc in &item.orm_calls {
                // normalize the table ref ("users::table" → "users") — top-
                // level fn args keep the raw path (insert_into(users::table))
                let table = crate::parser::table_name_from_ref(&oc.table_ref);
                let target = table_to_model.get(&table).cloned().or_else(|| {
                    table_to_schema_file
                        .get(&table)
                        .map(|f| format!("file::{}", f))
                });
                if let Some(to) = target {
                    let etype = if oc.kind == "read" {
                        EDGE_READS_FROM
                    } else {
                        EDGE_WRITES_TO
                    };
                    edges.push(edge(&from, &to, etype));
                }
            }
        }
    }
    edges
}

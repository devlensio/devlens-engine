// contract.rs — the JSON shape DevLens Engine expects.
//
// Every key here is camelCase to match the TypeScript interfaces in the
// devlens-engine (src/types.ts, src/extractors/types.ts). This file is the
// single source of truth for the output shape; other modules never spell
// keys by hand. Mirrors extractors/go/contract.go.
//
// serde_json::Map for `metadata` (free-form per-node extras) and strongly
// typed structs for everything else. rawDependencies is a BTreeMap so keys
// serialize sorted (deterministic output — contract rule).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

// ── Node types (subset of the engine's NodeType union used by Rust) ──
pub const NODE_FILE: &str = "FILE";
pub const NODE_TEST: &str = "TEST";
pub const NODE_ROUTE: &str = "ROUTE";
pub const NODE_THIRD_PARTY: &str = "THIRD_PARTY";

// ── Edge types (subset of the engine's EdgeType union used by Rust) ──
pub const EDGE_READS_FROM: &str = "READS_FROM";
pub const EDGE_WRITES_TO: &str = "WRITES_TO";

// codeHash = sha256(rawCode) hex-encoded, first 16 chars (contract rule).
pub fn code_hash(raw: &str) -> String {
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    let sum = h.finalize();
    hex16(&sum)
}

fn hex16(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s.chars().take(16).collect()
}

// ── Fingerprint ──

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub language: String,
    pub project_type: String,
    pub framework: String,
    pub router: String,
    pub state_management: Vec<String>,
    pub data_fetching: Vec<String>,
    pub databases: Vec<String>,
    pub raw_dependencies: BTreeMap<String, String>,
}

impl Fingerprint {
    pub fn new() -> Self {
        Fingerprint {
            language: "rust".to_string(),
            project_type: "unknown".to_string(),
            framework: "unknown".to_string(),
            router: "none".to_string(),
            state_management: vec![],
            data_fetching: vec![],
            databases: vec![],
            raw_dependencies: BTreeMap::new(),
        }
    }
}

// ── Stats / Errors / Result ──

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_files: i64,
    pub total_nodes: i64,
    pub skipped_files: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtractorError {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub file: String,
    pub error: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtractorResult {
    pub fingerprint: Fingerprint,
    pub nodes: Vec<CodeNode>,
    pub edges: Vec<CodeEdge>,
    pub routes: Vec<RouteNode>,
    pub stats: Stats,
    pub errors: Vec<ExtractorError>,
}

// ── Input (stdin) ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractorInput {
    pub repo_path: String,
    #[serde(default)]
    pub options: Value,
}

// ── Nodes / edges ──

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodeNode {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub file_path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub parent_file: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub code_hash: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub raw_code: String,
    pub metadata: Map<String, Value>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodeEdge {
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
}

// ── Routes (the `routes` array — BackendRouteNode shape, mirrors Go) ──

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RouteNode {
    #[serde(rename = "type")]
    pub route_type: String,
    pub url_path: String,
    pub file_path: String,
    pub http_method: String,
    pub framework: String,
    pub is_dynamic: bool,
    pub params: Vec<String>,
    pub handler_name: String,
    pub node_id: String,
}

// ── Builders ──

// Base metadata every code node carries (mirrors the inline JS extractor).
pub fn base_metadata() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("nodeCount".to_string(), Value::from(0));
    m.insert("childNodeIds".to_string(), Value::Array(vec![]));
    m.insert("language".to_string(), Value::from("rust"));
    m
}

// fileNode — FILE (or TEST) node. Id format: file::rel/path.rs (matches
// src/parser/index.ts). File nodes parent themselves.
pub fn file_node(rel_path: &str, end_line: i64, node_type: &str) -> CodeNode {
    CodeNode {
        id: format!("file::{}", rel_path),
        name: rel_path.rsplit('/').next().unwrap_or(rel_path).to_string(),
        node_type: node_type.to_string(),
        file_path: rel_path.to_string(),
        start_line: 1,
        end_line,
        parent_file: format!("file::{}", rel_path),
        code_hash: String::new(),
        raw_code: String::new(),
        metadata: base_metadata(),
    }
}

// code_node — FUNCTION/METHOD/STRUCT/ENUM/TRAIT/IMPL_BLOCK/THIRD_PARTY/ROUTE.
// rawCode on every code node (summarizer input — engine discards after).
#[allow(clippy::too_many_arguments)]
pub fn code_node(
    id: &str,
    rel_path: &str,
    name: &str,
    node_type: &str,
    start_line: i64,
    end_line: i64,
    raw_code: &str,
    metadata: Map<String, Value>,
) -> CodeNode {
    CodeNode {
        id: id.to_string(),
        name: name.to_string(),
        node_type: node_type.to_string(),
        file_path: rel_path.to_string(),
        start_line,
        end_line,
        parent_file: format!("file::{}", rel_path),
        code_hash: code_hash(raw_code),
        raw_code: raw_code.to_string(),
        metadata,
    }
}

pub fn edge(from: &str, to: &str, edge_type: &str) -> CodeEdge {
    CodeEdge {
        from: from.to_string(),
        to: to.to_string(),
        edge_type: edge_type.to_string(),
        metadata: None,
    }
}

pub fn edge_with_meta(
    from: &str,
    to: &str,
    edge_type: &str,
    metadata: Map<String, Value>,
) -> CodeEdge {
    CodeEdge {
        from: from.to_string(),
        to: to.to_string(),
        edge_type: edge_type.to_string(),
        metadata: Some(metadata),
    }
}

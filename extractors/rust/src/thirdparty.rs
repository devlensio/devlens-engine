// thirdparty.rs — [crate]/name third-party registry + gating (mirrors
// go/thirdparty.go and python/third_party.py).
//
// Gating rule (non-negotiable contract): options.includeThirdPartyLibs (both
// spellings) is THE gate — absent/empty → ZERO third-party nodes. All
// detectors (imports/calls/inheritance) share ONE registry.

use crate::contract::{base_metadata, code_node, CodeNode, NODE_THIRD_PARTY};
use crate::fingerprint::ParsedManifest;
use std::collections::{HashMap, HashSet};

/// std crates — first path segment of a use path in this set → skip tier
/// (no node, no edge).
pub const STD_CRATES: [&str; 3] = ["std", "core", "alloc"];

pub struct ThirdPartyRegistry {
    /// gated (allowed) crate names — empty = gate everything
    allowed: HashSet<String>,
    /// crate name → node (id [crate]/name)
    crate_nodes: HashMap<String, CodeNode>,
    /// crate name::member → node (id [crate]/name::member)
    member_nodes: HashMap<String, CodeNode>,
}

impl ThirdPartyRegistry {
    pub fn new(allowed: &[String]) -> Self {
        ThirdPartyRegistry {
            allowed: allowed.iter().cloned().collect(),
            crate_nodes: HashMap::new(),
            member_nodes: HashMap::new(),
        }
    }

    /// Strict membership gate (mirrors go's `permitted`): absent/empty
    /// `allowed` → ZERO third-party nodes (the engine controls inclusion via
    /// options.includeThirdPartyLibs). Hyphen/underscore normalization for
    /// Cargo crate names (dep `actix-web` ↔ crate `actix_web`).
    pub fn gated(&self, crate_name: &str) -> bool {
        if self.allowed.contains(crate_name) {
            return true;
        }
        let underscored = crate_name.replace('-', "_");
        self.allowed
            .iter()
            .any(|a| a.replace('-', "_") == underscored)
    }

    /// crate node [crate]/name — None when not gated.
    pub fn crate_node(&mut self, crate_name: &str) -> Option<CodeNode> {
        if !self.gated(crate_name) {
            return None;
        }
        if let Some(n) = self.crate_nodes.get(crate_name) {
            return Some(n.clone());
        }
        let mut meta = base_metadata();
        meta.insert("crateName".to_string(), crate_name.into());
        let n = code_node(
            &crate::lookup::third_party_id(crate_name),
            "",
            crate_name,
            NODE_THIRD_PARTY,
            0,
            0,
            "",
            meta,
        );
        self.crate_nodes.insert(crate_name.to_string(), n.clone());
        Some(n)
    }

    /// member node [crate]/name::member (e.g. serde::Serialize) — None when
    /// not gated.
    pub fn member_node(&mut self, crate_name: &str, member: &str) -> Option<CodeNode> {
        if !self.gated(crate_name) {
            return None;
        }
        let key = format!("{}::{}", crate_name, member);
        if let Some(n) = self.member_nodes.get(&key) {
            return Some(n.clone());
        }
        let mut meta = base_metadata();
        meta.insert("crateName".to_string(), crate_name.into());
        meta.insert("member".to_string(), member.into());
        let id = format!("{}::{}", crate::lookup::third_party_id(crate_name), member);
        let n = code_node(&id, "", &key, NODE_THIRD_PARTY, 0, 0, "", meta);
        self.member_nodes.insert(key, n.clone());
        Some(n)
    }

    /// All created nodes (collected last in the pipeline — like go).
    pub fn all_nodes(&self) -> Vec<CodeNode> {
        let mut out: Vec<CodeNode> = self.crate_nodes.values().cloned().collect();
        out.extend(self.member_nodes.values().cloned());
        out
    }
}

/// First segment of a path (e.g. "serde" from "serde::Serialize").
pub fn first_segment(path: &str) -> &str {
    path.split("::").next().unwrap_or(path)
}

/// True when the first segment is a std crate (skip tier).
pub fn is_std(first: &str) -> bool {
    STD_CRATES.contains(&first)
}

/// True when the first segment names an external crate (in the manifest's
/// dependency set). NOT std, NOT a local module — decided by callers using
/// the module map.
pub fn is_external_crate(first: &str, mf: &ParsedManifest) -> bool {
    mf.is_external_crate(first)
}

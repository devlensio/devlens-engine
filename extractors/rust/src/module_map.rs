// module_map.rs — module path → file resolution (the Rust analog of Go's
// package grouping).
//
// Module paths are derived from the FILESYSTEM (walker::module_path_for_file):
//   src/models/user.rs → module `models::user`
// `mod foo;` declarations are also recorded (mod_decls) but the map itself is
// filesystem-driven — deterministic by construction.
//
// Resolution rules (documented Rust module semantics):
//   crate::a::b  → absolute within the crate
//   super::a     → parent of the current file's module
//   self::a      → sibling of the current file's module
//   bare `a::b`  → try relative to the current module, then crate root

use crate::parser::ParsedFile;
use std::collections::HashMap;

pub struct ModuleMap {
    /// module path → rel file path (all .rs files, empty path = crate root)
    map: HashMap<String, String>,
}

impl ModuleMap {
    pub fn build(files: &[ParsedFile]) -> Self {
        let mut map = HashMap::new();
        for pf in files {
            let mpath = crate::walker::module_path_for_file(&pf.rel_path);
            map.insert(mpath, pf.rel_path.clone());
        }
        ModuleMap { map }
    }

    /// Is `name` a module reachable from `base_module` (or the crate root)?
    /// Resolve a use/call path from a file whose module is `base_module`.
    /// Returns (file rel path, remaining item path) for the LONGEST module
    /// prefix of the path. External crates / std → None.
    ///
    /// `crate::models::user::User` (base "models::db") →
    ///    candidates: "models::user" (module) + "User" (item)
    pub fn resolve(&self, path: &str, base_module: &str) -> Option<(String, String)> {
        let (crate_abs, stripped) = normalize(path, base_module);
        if crate_abs {
            // absolute within this crate: try longest module prefix
            return self.longest_prefix(&stripped);
        }
        // bare path: relative to base module first, then crate root
        if !base_module.is_empty() {
            let rel = format!("{}::{}", base_module, stripped);
            if let Some(hit) = self.longest_prefix(&rel) {
                return Some(hit);
            }
        }
        self.longest_prefix(&stripped)
    }

    /// Resolve a `use` path (edition-2018 semantics): bare first segments are
    /// crate-root-absolute — `use axum::routing::get` NEVER means "relative
    /// to this module"; relative requires explicit `self::`/`super::` (which
    /// normalize() handles). Call paths (calls.rs) keep resolve()'s
    /// relative-first ladder; use paths MUST NOT (a bare path whose first
    /// segment collides with the current module would self-resolve).
    pub fn resolve_use(&self, path: &str, base_module: &str) -> Option<(String, String)> {
        let (crate_abs, stripped) = normalize(path, base_module);
        if crate_abs {
            return self.longest_prefix(&stripped);
        }
        self.longest_prefix(&stripped)
    }

    /// Try the full path as a module, then backtrack segment by segment.
    /// `models::user::User` → module `models::user`, item `User`.
    fn longest_prefix(&self, path: &str) -> Option<(String, String)> {
        let segs: Vec<&str> = path.split("::").collect();
        for cut in (1..=segs.len()).rev() {
            let module = segs[..cut].join("::");
            if let Some(file) = self.map.get(&module) {
                let rest = segs[cut..].join("::");
                return Some((file.clone(), rest));
            }
        }
        None
    }
}

/// Normalize a path against the base module. Returns (is_crate_absolute, path).
fn normalize(path: &str, base_module: &str) -> (bool, String) {
    // bare root/self/super tokens (glob targets like `use crate::*`)
    if path == "crate" {
        return (true, String::new());
    }
    if path == "self" {
        return (true, base_module.to_string());
    }
    if path == "super" {
        let mut base_parts: Vec<&str> = base_module.split("::").collect();
        base_parts.pop();
        return (true, base_parts.join("::"));
    }
    if let Some(rest) = path.strip_prefix("crate::") {
        return (true, rest.to_string());
    }
    if let Some(rest) = path.strip_prefix("self::") {
        let p = if base_module.is_empty() {
            rest.to_string()
        } else {
            format!("{}::{}", base_module, rest)
        };
        return (true, p);
    }
    if let Some(rest) = path.strip_prefix("super::") {
        // count supers
        let mut count = 1;
        let mut rest = rest.to_string();
        while let Some(r2) = rest.strip_prefix("super::") {
            count += 1;
            rest = r2.to_string();
        }
        let mut base_parts: Vec<&str> = base_module.split("::").collect();
        for _ in 0..count {
            base_parts.pop();
        }
        let p = if base_parts.is_empty() {
            rest
        } else {
            format!("{}::{}", base_parts.join("::"), rest)
        };
        return (true, p);
    }
    // bare — resolve() decides relative-vs-root
    (false, path.to_string())
}

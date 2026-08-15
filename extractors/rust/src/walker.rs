// walker.rs — .rs file discovery with IGNORE pruning at the frontier
// (mirrors go/walker.go). Deterministic: read_dir entries are sorted.

use std::path::Path;

const IGNORE_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "target", // cargo build dir (can be ~1GB)
    "vendor", // vendored deps — never walked for nodes (like go)
    "bin",
    "dist",
    "build",
    ".cargo",
    ".idea",
];

/// Recursively collect .rs files under repo_path, pruning IGNORE dirs at the
/// frontier (never descend into them).
pub fn collect_rs_files(repo_path: &str) -> Vec<String> {
    let mut out = vec![];
    walk(repo_path, repo_path, &mut out);
    out.sort();
    out
}

fn walk(root: &str, dir: &str, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    for name in names {
        if name.starts_with('.') && name != ".github" {
            continue;
        }
        let full = format!("{}/{}", dir, name);
        let rel = full
            .strip_prefix(root)
            .unwrap_or(&full)
            .trim_start_matches('/');
        let path = Path::new(&full);
        if path.is_dir() {
            if IGNORE_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(root, &full, out);
        } else if name.ends_with(".rs") {
            out.push(rel.to_string());
        }
    }
}

/// Derive a file's module path within its crate: strip the crate's `src`
/// segment, drop `mod.rs`/`main.rs`/`lib.rs` suffixes, map / → ::.
///   src/models/user.rs  → models::user
///   src/foo/mod.rs      → foo
///   src/main.rs         → (crate root) ""
///   crates/a/src/bar.rs → crates::a::bar (workspace member)
pub fn module_path_for_file(rel_path: &str) -> String {
    let mut parts: Vec<&str> = rel_path.split('/').collect();
    if let Some(idx) = parts.iter().position(|p| *p == "src") {
        parts = parts[idx + 1..].to_vec();
    }
    let mut last = parts.pop().unwrap_or("");
    if last == "mod.rs" || last == "main.rs" || last == "lib.rs" {
        last = "";
    } else {
        last = last.strip_suffix(".rs").unwrap_or(last);
    }
    if last.is_empty() {
        return parts.join("::");
    }
    if parts.is_empty() {
        return last.to_string();
    }
    format!("{}::{}", parts.join("::"), last)
}

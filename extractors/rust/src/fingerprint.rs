// fingerprint.rs — Cargo.toml parsing → framework / projectType / databases /
// rawDependencies. Manifest is PARSED, never executed (security rule, same as
// setup.py/pom.xml/go.mod handling in the other phases).
//
// Workspace-aware: [workspace] members' Cargo.tomls and the root
// [workspace.dependencies] are unioned into one dependency view.

use crate::contract::Fingerprint;
use std::collections::BTreeMap;
use std::path::Path;

/// Parsed manifest facts — consumed by fingerprint AND import resolution
/// (dependency names = the external-crate set for [crate]/ gating).
pub struct ParsedManifest {
    /// union of [dependencies] + [dev-dependencies] + [workspace.dependencies]
    /// (name → version; version may be empty for path/git deps)
    pub dependencies: BTreeMap<String, String>,
    /// member crate directories (relative, from [workspace].members globs)
    pub workspace_members: Vec<String>,
}

impl ParsedManifest {
    pub fn is_external_crate(&self, name: &str) -> bool {
        // strip a leading crate-name prefix (e.g. `axum::extract` → `axum`)
        let root = name.split("::").next().unwrap_or(name);
        if self.dependencies.contains_key(root) {
            return true;
        }
        // Cargo normalization: the `actix-web` dependency provides the
        // `actix_web` crate (hyphens → underscores in source)
        let underscored = root.replace('-', "_");
        if underscored != root && self.dependencies.contains_key(&underscored) {
            return true;
        }
        self.dependencies
            .keys()
            .any(|k| k.replace('-', "_") == underscored)
    }
}

/// Parse Cargo.toml at repoPath (if present). Never fails hard — a missing or
/// malformed manifest yields an empty ParsedManifest (fingerprint degrades to
/// unknown, documented non-fatal).
pub fn parse_cargo_toml(repo_path: &str) -> ParsedManifest {
    let mut mf = ParsedManifest {
        dependencies: BTreeMap::new(),
        workspace_members: vec![],
    };
    let root_toml = Path::new(repo_path).join("Cargo.toml");
    if !root_toml.exists() {
        return mf;
    }
    let text = match std::fs::read_to_string(&root_toml) {
        Ok(t) => t,
        Err(_) => return mf,
    };
    let root: toml::Value = match toml::from_str(&text) {
        Ok(v) => v,
        Err(_) => return mf,
    };

    // root package deps
    collect_deps(&root, &mut mf.dependencies);

    // workspace: root [workspace.dependencies] + member crates
    let mut member_dirs: Vec<String> = vec![];
    if let Some(ws) = root.get("workspace") {
        if let Some(wd) = ws.get("dependencies").and_then(|d| d.as_table()) {
            for (name, spec) in wd {
                insert_dep(&mut mf.dependencies, name, spec);
            }
        }
        if let Some(members) = ws.get("members").and_then(|m| m.as_array()) {
            for m in members {
                if let Some(s) = m.as_str() {
                    expand_members(s, repo_path, &mut member_dirs);
                }
            }
        }
    }
    mf.workspace_members = member_dirs;

    // member crates' own [dependencies]
    for dir in &mf.workspace_members {
        let member_toml = Path::new(repo_path).join(dir).join("Cargo.toml");
        if let Ok(t) = std::fs::read_to_string(&member_toml) {
            if let Ok(v) = toml::from_str::<toml::Value>(&t) {
                collect_deps(&v, &mut mf.dependencies);
            }
        }
    }
    mf
}

fn collect_deps(v: &toml::Value, out: &mut BTreeMap<String, String>) {
    for section in ["dependencies", "dev-dependencies"] {
        if let Some(t) = v.get(section).and_then(|d| d.as_table()) {
            for (name, spec) in t {
                insert_dep(out, name, spec);
            }
        }
    }
}

/// dep spec forms: `foo = "1.0"` (string), `foo = { version = "1.0", ... }`
/// (inline table), `[dependencies.foo]` (table header) — all land as
/// Value::String or Value::Table in the toml crate.
fn insert_dep(out: &mut BTreeMap<String, String>, name: &str, spec: &toml::Value) {
    match spec {
        toml::Value::String(s) => {
            out.insert(name.to_string(), s.clone());
        }
        toml::Value::Table(t) => {
            let ver = t
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            out.insert(name.to_string(), ver);
        }
        toml::Value::Array(a) => {
            // multi-spec form: `foo = ["1.0", { ... }]` — take first string
            for item in a {
                if let toml::Value::String(s) = item {
                    out.insert(name.to_string(), s.clone());
                    return;
                }
            }
            out.insert(name.to_string(), String::new());
        }
        _ => {
            out.insert(name.to_string(), String::new());
        }
    }
}

/// `members = ["crates/*", "core", "libs/foo"]` — expand `*` against the
/// filesystem (a glob segment matches exactly one directory level).
fn expand_members(glob: &str, repo_path: &str, out: &mut Vec<String>) {
    let mut segments: Vec<&str> = glob.split('/').collect();
    let mut current_dirs: Vec<String> = vec![String::new()];
    while let Some(seg) = segments.first() {
        let seg = *seg;
        segments.remove(0);
        let mut next: Vec<String> = vec![];
        for base in &current_dirs {
            if seg == "*" {
                let dir = Path::new(repo_path).join(base);
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for e in entries.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if name.starts_with('.') {
                            continue;
                        }
                        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            next.push(if base.is_empty() {
                                name
                            } else {
                                format!("{}/{}", base, name)
                            });
                        }
                    }
                }
            } else {
                next.push(if base.is_empty() {
                    seg.to_string()
                } else {
                    format!("{}/{}", base, seg)
                });
            }
        }
        current_dirs = next;
    }
    for d in current_dirs {
        // only actual crates (has Cargo.toml)
        if Path::new(repo_path).join(&d).join("Cargo.toml").exists() {
            out.push(d);
        }
    }
}

// ── framework / database / projectType detection ──

const FRAMEWORKS: [(&str, &str); 5] = [
    ("axum", "axum"),
    ("actix-web", "actix-web"),
    ("rocket", "rocket"),
    ("warp", "warp"),
    ("poem", "poem"),
];

const DATABASES: [(&str, &str); 8] = [
    ("diesel", "diesel"),
    ("sqlx", "sqlx"),
    ("postgres", "postgresql"),
    ("tokio-postgres", "postgresql"),
    ("rusqlite", "sqlite"),
    ("sqlite", "sqlite"),
    ("mysql", "mysql"),
    ("mongodb", "mongo"),
];

pub fn fingerprint_from_manifest(mf: &ParsedManifest, repo_path: &str) -> Fingerprint {
    let mut fp = Fingerprint::new();

    for (crate_name, fw) in FRAMEWORKS {
        if mf.is_external_crate(crate_name) {
            fp.framework = fw.to_string();
            fp.router = fw.to_string();
            fp.project_type = "backend".to_string();
            break;
        }
    }

    let mut dbs: Vec<String> = vec![];
    for (crate_name, db) in DATABASES {
        if mf.is_external_crate(crate_name) && !dbs.contains(&db.to_string()) {
            dbs.push(db.to_string());
        }
    }
    fp.databases = dbs;

    // projectType: main.rs → backend (bin crate); lib.rs only → library.
    if fp.project_type == "unknown" {
        let has_main = Path::new(repo_path).join("src/main.rs").exists();
        let has_lib = Path::new(repo_path).join("src/lib.rs").exists();
        fp.project_type = if has_main {
            "backend".to_string()
        } else if has_lib {
            "library".to_string()
        } else {
            "unknown".to_string()
        };
    }

    fp.raw_dependencies = mf.dependencies.clone();
    fp
}

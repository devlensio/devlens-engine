use crate::contract::CodeNode;
use crate::exports::build_exports_map;
use crate::module_map::ModuleMap;
use crate::parser;

fn parse_fixture() -> (Vec<parser::ParsedFile>, ModuleMap) {
    let repo = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/exportsfix");
    let mut files = vec![];
    for rel in crate::walker::collect_rs_files(repo) {
        let abs = format!("{}/{}", repo, rel);
        if let Ok(source) = std::fs::read_to_string(&abs) {
            if let Ok(pf) = parser::parse_file(&rel, &source) {
                files.push(pf);
            }
        }
    }
    let map = ModuleMap::build(&files);
    (files, map)
}

#[test]
fn root_surface_maps_pub_items_to_proper_node_ids() {
    let (files, mm) = parse_fixture();
    let m = build_exports_map(&files, &mm).expect("map expected");
    let root = m.exports.get(".").expect("root subpath");

    assert_eq!(root.get("run"), Some(&vec!["src/lib.rs::run".to_string()]));
    assert_eq!(root.get("Engine"), Some(&vec!["src/lib.rs::Engine".to_string()]));
    assert_eq!(root.get("Mode"), Some(&vec!["src/lib.rs::Mode".to_string()]));
    assert_eq!(root.get("Storage"), Some(&vec!["src/lib.rs::Storage".to_string()]));
    assert_eq!(root.get("Engine.start"), Some(&vec!["src/lib.rs::Engine.start".to_string()]));
    assert_eq!(root.get("private_helper"), None);
    assert_eq!(root.get("Hidden"), None);
}

#[test]
fn pub_mod_opens_a_prefixed_surface() {
    let (files, mm) = parse_fixture();
    let m = build_exports_map(&files, &mm).expect("map expected");
    let root = m.exports.get(".").expect("root subpath");

    assert_eq!(root.get("models"), Some(&vec!["file::src/models/mod.rs".to_string()]));
    assert_eq!(root.get("models::user"), Some(&vec!["file::src/models/user.rs".to_string()]));
    assert_eq!(root.get("models::user::PublicUser"), Some(&vec!["src/models/user.rs::PublicUser".to_string()]));
    assert_eq!(root.get("models::user::Role"), Some(&vec!["src/models/user.rs::Role".to_string()]));
    assert_eq!(root.get("models::user::PublicUser.new"), Some(&vec!["src/models/user.rs::PublicUser.new".to_string()]));
    assert_eq!(root.get("models::user::PrivateThing"), None);
    assert_eq!(root.get("models::internal::InternalDetail"), None);
}

#[test]
fn pub_use_aliases_resolve_through_bindings_name_swap_safe() {
    let (files, mm) = parse_fixture();
    let m = build_exports_map(&files, &mm).expect("map expected");
    let root = m.exports.get(".").expect("root subpath");

    assert_eq!(root.get("VisibleUser"), Some(&vec!["src/models/user.rs::PublicUser".to_string()]));
    // lib.rs re-exports aliasing's names SWAPPED: lib's SwappedA = aliasing's
    // SwappedB = Role; lib's SwappedB = aliasing's SwappedA = PublicUser.
    assert_eq!(root.get("SwappedA"), Some(&vec!["src/models/user.rs::Role".to_string()]));
    assert_eq!(root.get("SwappedB"), Some(&vec!["src/models/user.rs::PublicUser".to_string()]));
}

#[test]
fn glob_reexport_brings_target_pub_items_to_same_level() {
    let (files, mm) = parse_fixture();
    let m = build_exports_map(&files, &mm).expect("map expected");
    let root = m.exports.get(".").expect("root subpath");

    assert_eq!(root.get("aliasing::Extra"), Some(&vec!["src/aliasing/extra.rs::Extra".to_string()]));
}

#[test]
fn ambiguous_names_stay_empty_and_shape_is_uniform() {
    let (files, mm) = parse_fixture();
    let m = build_exports_map(&files, &mm).expect("map expected");
    assert!(m.ambiguous_names.is_empty());
    for (subpath, names) in &m.exports {
        assert_eq!(subpath, ".");
        for (name, ids) in names {
            assert!(!ids.is_empty(), "{} has empty ids", name);
        }
    }
}

#[test]
fn map_values_all_exist_in_nodes_array() {
    let (files, mm) = parse_fixture();
    let m = build_exports_map(&files, &mm).expect("map expected");
    let mut node_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let nodes: Vec<CodeNode> = crate::nodes::collect_code_nodes(&files)
        .into_iter()
        .chain(crate::nodes::collect_file_nodes(&files))
        .collect();
    for n in &nodes {
        node_ids.insert(n.id.clone());
    }
    for names in m.exports.values() {
        for ids in names.values() {
            for id in ids {
                assert!(node_ids.contains(id), "dangling map value {}", id);
            }
        }
    }
}

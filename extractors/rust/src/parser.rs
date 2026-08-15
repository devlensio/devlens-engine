// parser.rs — parse-time FACT collection via syn. Everything an edge detector
// needs is collected HERE in one pass per file; detectors resolve from the
// facts via lookup maps, never re-walking ASTs (playbook rule).
//
// syn is SYNTACTIC — no type resolution (rust-analyzer would be V2). All
// name-based resolution downstream is flagged where heuristic.

use proc_macro2::{Span, TokenStream, TokenTree};
use quote::ToTokens;
use std::collections::BTreeSet;
use syn::spanned::Spanned;
use syn::visit::Visit;

// ── line index: (line, char-col) → byte offset (exact rawCode slicing) ──

pub struct LineIndex {
    /// per line: byte offset of the line start, then byte offset of each
    /// char boundary within the line (0-based char index → byte offset)
    lines: Vec<LineEntry>,
}

struct LineEntry {
    byte_offset: usize,
    char_offsets: Vec<usize>,
}

impl LineIndex {
    pub fn new(source: &str) -> Self {
        let mut lines = vec![];
        let mut line_start = 0usize;
        for line in source.split('\n') {
            let mut char_offsets = vec![0usize];
            for (idx, (byte, _c)) in line.char_indices().enumerate() {
                if idx > 0 {
                    char_offsets.push(byte);
                }
            }
            char_offsets.push(line.len());
            lines.push(LineEntry {
                byte_offset: line_start,
                char_offsets,
            });
            line_start += line.len() + 1; // +1 for '\n'
        }
        LineIndex { lines }
    }

    /// line: 1-based, col: 1-based char column → byte offset into source.
    fn byte_offset(&self, line: usize, col: usize) -> usize {
        if line == 0 || line > self.lines.len() {
            return 0;
        }
        let entry = &self.lines[line - 1];
        entry.byte_offset
            + entry
                .char_offsets
                .get(col.saturating_sub(1))
                .copied()
                .unwrap_or(0)
    }

    /// Byte range of a proc_macro2 span (span.start()/end() are 1-based).
    pub fn span_range(&self, span: Span) -> (usize, usize) {
        let start = span.start();
        let end = span.end();
        (
            self.byte_offset(start.line, start.column + 1),
            self.byte_offset(end.line, end.column + 1),
        )
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }
}

// ── parsed facts ──

#[derive(Clone)]
pub struct UseDecl {
    /// alias in scope (last path segment, or explicit `as` name)
    pub alias: String,
    /// full target path (crate::foo::bar / axum::Router / super::x)
    pub target: String,
    /// true for `use foo::*;` / `use foo::{a::*, b};` glob portions
    pub glob: bool,
}

#[derive(Clone)]
pub struct TableDecl {
    pub name: String,
    pub columns: Vec<(String, String)>,
}

#[derive(Clone, Default)]
pub struct AttrInfo {
    /// attr path joined with :: (e.g. "actix_web::get", "derive", "diesel")
    pub path: String,
    /// raw arg tokens for list metas (e.g. `"/users/{id}"` or `table_name = users`)
    pub args: String,
}

#[derive(Clone)]
pub struct FieldInfo {
    pub name: String,
}

pub const KIND_FUNCTION: &str = "FUNCTION";
pub const KIND_METHOD: &str = "METHOD";
pub const KIND_STRUCT: &str = "STRUCT";
pub const KIND_ENUM: &str = "ENUM";
pub const KIND_TRAIT: &str = "TRAIT";
pub const KIND_IMPL_BLOCK: &str = "IMPL_BLOCK";

#[derive(Clone, Default)]
pub struct OrmCall {
    /// "read" | "write"
    pub kind: String,
    /// table reference as written (e.g. "users::table", "users::dsl::users",
    /// "users" — or the first arg of diesel::insert_into/update/delete)
    pub table_ref: String,
}

#[derive(Clone)]
pub struct ParsedItem {
    pub kind: &'static str,
    pub name: String,
    pub start_line: i64,
    pub end_line: i64,
    pub raw_code: String,
    pub attrs: Vec<AttrInfo>,
    pub is_pub: bool,
    pub is_async: bool,
    /// method receiver: "&self" / "&mut self" / "self" / "" (free fn)
    pub receiver: String,
    pub calls: Vec<String>,
    pub is_test: bool,
    /// Diesel R/W call facts (collected alongside calls)
    pub orm_calls: Vec<OrmCall>,
    // kind-specific
    pub fields: Vec<FieldInfo>,
    pub variants: Vec<String>,
    pub supertraits: Vec<String>,
    pub derives: Vec<String>,
    /// impl blocks: Some(path) when `impl Trait for Type`
    pub impl_trait: Option<String>,
    /// impl blocks: the target type path (e.g. "User", "Vec < T >" → "Vec<T>")
    pub impl_target: String,
    /// impl blocks: for trait impls, the trait path
    pub impl_trait_path: Option<String>,
}

#[derive(Clone)]
pub struct ParsedFile {
    pub rel_path: String,
    /// the parsed AST — kept for detection passes that need expression
    /// structure (routes.rs walks fn bodies for axum chains; mirrors go's
    /// `Decl *ast.FuncDecl` retention)
    #[allow(dead_code)]
    pub ast: syn::File,
    pub uses: Vec<UseDecl>,
    pub items: Vec<ParsedItem>,
    pub tables: Vec<TableDecl>,
    pub test_fns: Vec<String>,
    pub is_test_file: bool,
    pub line_count: i64,
}

// ── attribute helpers ──

pub fn attr_info(a: &syn::Attribute) -> AttrInfo {
    let path = a
        .path()
        .segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::");
    let args = match &a.meta {
        syn::Meta::List(l) => l.tokens.to_string(),
        syn::Meta::NameValue(nv) => nv.value.to_token_stream().to_string(),
        syn::Meta::Path(_) => String::new(),
    };
    AttrInfo { path, args }
}

/// last path segment of an attr path (e.g. "get" for actix_web::get)
pub fn attr_last_segment(a: &syn::Attribute) -> String {
    a.path()
        .segments
        .last()
        .map(|s| s.ident.to_string())
        .unwrap_or_default()
}

fn has_cfg_test(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| {
        let p = attr_info(a).path;
        p == "cfg" && a.meta.to_token_stream().to_string().contains("test")
    })
}

// ── call collection (per fn body; nested items are NOT descended into) ──

struct CallCollector {
    calls: Vec<String>,
    orm_calls: Vec<OrmCall>,
}

/// Diesel query-DSL verbs (documented diesel API — anti-overfit rule).
const ORM_READ_VERBS: [&str; 9] = [
    "filter",
    "first",
    "get_result",
    "get_results",
    "load",
    "find",
    "select",
    "count",
    "all",
];
const ORM_WRITE_VERBS: [&str; 3] = ["insert", "update", "delete"];
const DIESEL_WRITE_FNS: [&str; 3] = ["insert_into", "update", "delete"];

/// Collapse token-stream rendering ("users :: table" → "users::table").
/// to_token_stream() emits spaces around punctuation; removing ALL whitespace
/// yields the canonical compact form every detector matches on.
fn collapse_tokens(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join("")
}

fn path_string(p: &syn::Path) -> String {
    p.segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

/// Normalize a table reference to its bare table name:
///   users::table / users::dsl::users / users::dsl::users::columns::id /
///   schema::users::table → users
pub fn table_name_from_ref(r: &str) -> String {
    let parts: Vec<&str> = r.split("::").collect();
    for (i, part) in parts.iter().enumerate() {
        if *part == "table" && i > 0 {
            return parts[i - 1].to_string();
        }
        if *part == "dsl" && i + 1 < parts.len() {
            return parts[i + 1].to_string();
        }
    }
    // bare identifier: first segment (e.g. `users` imported via dsl::*)
    parts[0].to_string()
}

impl<'ast> Visit<'ast> for CallCollector {
    // scope rule: nested item definitions (fns/impls inside a body) do NOT
    // belong to the enclosing function — skip them entirely
    fn visit_item(&mut self, _item: &'ast syn::Item) {}

    fn visit_expr_call(&mut self, e: &'ast syn::ExprCall) {
        let name = match &*e.func {
            syn::Expr::Path(p) => {
                if p.qself.is_none() {
                    path_string(&p.path)
                } else {
                    collapse_tokens(&p.to_token_stream().to_string())
                }
            }
            other => collapse_tokens(&other.to_token_stream().to_string()),
        };
        self.calls.push(name.clone());
        // diesel top-level write fns: insert_into(table) / update(table) /
        // delete(table)
        if let Some(first) = DIESEL_WRITE_FNS
            .iter()
            .find(|f| name.ends_with(&format!("::{}", f)))
        {
            let _ = first;
            if let Some(arg) = e.args.first() {
                self.orm_calls.push(OrmCall {
                    kind: "write".to_string(),
                    table_ref: collapse_tokens(&arg.to_token_stream().to_string()),
                });
            }
        }
        syn::visit::visit_expr_call(self, e);
    }

    fn visit_expr_method_call(&mut self, e: &'ast syn::ExprMethodCall) {
        let recv = collapse_tokens(&e.receiver.to_token_stream().to_string());
        let method = e.method.to_string();
        self.calls.push(format!("{}.{}", recv, method));
        // Diesel query DSL on a table path (receiver contains ::table or
        // ::dsl::, or is a bare table-name alias)
        let is_table_path = recv.contains("::table")
            || recv.contains("::dsl::")
            || (!recv.contains("::") && !recv.contains('.'));
        if is_table_path {
            if ORM_READ_VERBS.contains(&method.as_str()) {
                self.orm_calls.push(OrmCall {
                    kind: "read".to_string(),
                    table_ref: table_name_from_ref(&recv),
                });
            } else if ORM_WRITE_VERBS.contains(&method.as_str()) {
                self.orm_calls.push(OrmCall {
                    kind: "write".to_string(),
                    table_ref: table_name_from_ref(&recv),
                });
            }
        }
        syn::visit::visit_expr_method_call(self, e);
    }
}

// ── file parsing ──

pub fn parse_file(rel_path: &str, source: &str) -> Result<ParsedFile, String> {
    let ast = syn::parse_file(source).map_err(|e| e.to_string())?;
    let line_index = LineIndex::new(source);
    let mut pf = ParsedFile {
        rel_path: rel_path.to_string(),
        ast,
        uses: vec![],
        items: vec![],
        tables: vec![],
        test_fns: vec![],
        is_test_file: false,
        line_count: line_index.line_count() as i64,
    };

    // module path from the file's location (walker::module_path_for_file)
    let module_path = crate::walker::module_path_for_file(rel_path);

    // collect facts from the AST items (take avoids the immutable-borrow-vs-
    // mutable-pf conflict; put them BACK — routes.rs walks pf.ast for
    // expression-level detection)
    let ast_items = std::mem::take(&mut pf.ast.items);
    for item in &ast_items {
        collect_item(item, &module_path, source, &line_index, &mut pf);
    }
    pf.ast.items = ast_items;

    pf.is_test_file = !pf.test_fns.is_empty();
    Ok(pf)
}

fn slice_range(source: &str, start: usize, end: usize) -> String {
    if start >= end || start >= source.len() {
        return String::new();
    }
    source[start..end.min(source.len())].to_string()
}

fn item_span_code<T: Spanned>(
    item: &T,
    source: &str,
    line_index: &LineIndex,
) -> (i64, i64, String) {
    let span = item.span();
    let (s, e) = line_index.span_range(span);
    let start_line = span.start().line as i64;
    let end_line = span.end().line as i64;
    (start_line, end_line, slice_range(source, s, e))
}

fn collect_item(
    item: &syn::Item,
    module_path: &str,
    source: &str,
    line_index: &LineIndex,
    pf: &mut ParsedFile,
) {
    match item {
        syn::Item::Use(u) => {
            collect_use_tree(&u.tree, &mut pf.uses);
        }
        syn::Item::Mod(m) => {
            let cfg_test = has_cfg_test(&m.attrs);
            match &m.content {
                None => {
                    // external `mod x;` — the file exists on disk; the module
                    // map is filesystem-derived, nothing to record here
                }
                Some((_, items)) => {
                    if cfg_test {
                        // #[cfg(test)] mod — items stay OUT of the graph, but
                        // #[test] fns still feed the file's testCases (leaf
                        // rule: a file with tests IS a TEST node)
                        collect_test_names(items, pf);
                    } else {
                        let child_module = if module_path.is_empty() {
                            m.ident.to_string()
                        } else {
                            format!("{}::{}", module_path, m.ident)
                        };
                        for it in items {
                            collect_item(it, &child_module, source, line_index, pf);
                        }
                    }
                }
            }
        }
        syn::Item::Macro(mac) => {
            // Diesel table! — the extractor's one macro we understand
            if mac
                .mac
                .path
                .segments
                .last()
                .map(|s| s.ident == "table")
                .unwrap_or(false)
            {
                if let Some(t) = parse_table_macro(&mac.mac.tokens) {
                    pf.tables.push(t);
                }
            }
        }
        syn::Item::Fn(f) => collect_fn(
            &f.attrs,
            &f.sig,
            &f.block,
            &f.vis,
            module_path,
            source,
            line_index,
            pf,
        ),
        syn::Item::Struct(s) => {
            let (sl, el, raw) = item_span_code(s, source, line_index);
            let mut pi = base_item(
                KIND_STRUCT,
                &s.ident.to_string(),
                sl,
                el,
                raw,
                &s.attrs,
                s.vis.clone(),
            );
            pi.derives = collect_derives(&s.attrs);
            if let syn::Fields::Named(named) = &s.fields {
                for f in &named.named {
                    if let Some(name) = &f.ident {
                        pi.fields.push(FieldInfo {
                            name: name.to_string(),
                        });
                    }
                }
            }
            // struct generics bounds → metadata (EXTENDS for local traits is
            // resolved in inheritance.rs from the bound paths)
            collect_generic_bounds(&s.generics, &mut pi);
            pf.items.push(pi);
        }
        syn::Item::Enum(e) => {
            let (sl, el, raw) = item_span_code(e, source, line_index);
            let mut pi = base_item(
                KIND_ENUM,
                &e.ident.to_string(),
                sl,
                el,
                raw,
                &e.attrs,
                e.vis.clone(),
            );
            pi.derives = collect_derives(&e.attrs);
            for v in &e.variants {
                pi.variants.push(v.ident.to_string());
            }
            collect_generic_bounds(&e.generics, &mut pi);
            pf.items.push(pi);
        }
        syn::Item::Trait(t) => {
            let (sl, el, raw) = item_span_code(t, source, line_index);
            let mut pi = base_item(
                KIND_TRAIT,
                &t.ident.to_string(),
                sl,
                el,
                raw,
                &t.attrs,
                t.vis.clone(),
            );
            pi.supertraits = t
                .supertraits
                .iter()
                .filter_map(|b| match b {
                    syn::TypeParamBound::Trait(tb) => Some(path_string(&tb.path)),
                    _ => None,
                })
                .collect();
            pf.items.push(pi);
        }
        syn::Item::Impl(im) => {
            let (sl, el, raw) = item_span_code(im, source, line_index);
            let trait_opt = im.trait_.as_ref().map(|(_, path, _)| path_string(path));
            let target = collapse_tokens(&im.self_ty.to_token_stream().to_string());
            let name = match &trait_opt {
                Some(t) => format!("impl {} for {}", t, target),
                None => format!("impl {}", target),
            };
            let mut pi = base_item(
                KIND_IMPL_BLOCK,
                &name,
                sl,
                el,
                raw,
                &im.attrs,
                // impl blocks carry no visibility in syn (always inherited)
                syn::Visibility::Inherited,
            );
            pi.impl_trait = trait_opt.clone();
            pi.impl_trait_path = trait_opt.clone();
            pi.impl_target = target;
            for ii in &im.items {
                if let syn::ImplItem::Fn(ifn) = ii {
                    let mut m = parse_fn_like(
                        &ifn.attrs,
                        &ifn.sig,
                        &ifn.block,
                        &ifn.vis,
                        module_path,
                        source,
                        line_index,
                        true,
                    );
                    // the method belongs to the impl's target type (and trait
                    // when `impl Trait for Type`) — id + lookup keys need it
                    m.impl_target = pi.impl_target.clone();
                    m.impl_trait_path = pi.impl_trait_path.clone();
                    pf.items.push(m);
                }
            }
            pf.items.push(pi);
        }
        _ => {}
    }
}

fn base_item(
    kind: &'static str,
    name: &str,
    start_line: i64,
    end_line: i64,
    raw_code: String,
    attrs: &[syn::Attribute],
    vis: syn::Visibility,
) -> ParsedItem {
    ParsedItem {
        kind,
        name: name.to_string(),
        start_line,
        end_line,
        raw_code,
        attrs: attrs.iter().map(attr_info).collect(),
        is_pub: matches!(vis, syn::Visibility::Public(_)),
        is_async: false,
        receiver: String::new(),
        calls: vec![],
        is_test: false,
        orm_calls: vec![],
        fields: vec![],
        variants: vec![],
        supertraits: vec![],
        derives: vec![],
        impl_trait: None,
        impl_target: String::new(),
        impl_trait_path: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_fn(
    attrs: &[syn::Attribute],
    sig: &syn::Signature,
    block: &syn::Block,
    vis: &syn::Visibility,
    module_path: &str,
    source: &str,
    line_index: &LineIndex,
    pf: &mut ParsedFile,
) {
    let pi = parse_fn_like(
        attrs,
        sig,
        block,
        vis,
        module_path,
        source,
        line_index,
        false,
    );
    if pi.is_test {
        pf.test_fns.push(pi.name.clone());
    }
    pf.items.push(pi);
}

/// Scan items (recursively through mods) for #[test]-attributed fns — used
/// for #[cfg(test)] mods whose items are otherwise excluded from the graph.
fn collect_test_names(items: &[syn::Item], pf: &mut ParsedFile) {
    for item in items {
        match item {
            syn::Item::Fn(f) => {
                if f.attrs.iter().any(|a| attr_last_segment(a) == "test") {
                    pf.test_fns.push(f.sig.ident.to_string());
                }
            }
            syn::Item::Mod(m) => {
                if let Some((_, inner)) = &m.content {
                    collect_test_names(inner, pf);
                }
            }
            _ => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn parse_fn_like(
    attrs: &[syn::Attribute],
    sig: &syn::Signature,
    block: &syn::Block,
    vis: &syn::Visibility,
    _module_path: &str,
    source: &str,
    line_index: &LineIndex,
    is_method: bool,
) -> ParsedItem {
    let sig_span = sig.span();
    let block_span = block.span();
    let start_line = sig_span.start().line as i64;
    let end_line = block_span.end().line as i64;
    let (s, _) = line_index.span_range(sig_span);
    let (_, e) = line_index.span_range(block_span);
    let raw = slice_range(source, s, e);

    let mut pi = base_item(
        if is_method {
            KIND_METHOD
        } else {
            KIND_FUNCTION
        },
        &sig.ident.to_string(),
        start_line,
        end_line,
        raw,
        attrs,
        vis.clone(),
    );
    pi.is_async = sig.asyncness.is_some();

    // receiver (methods only): &self / &mut self / self
    if is_method {
        pi.receiver = match sig.receiver() {
            Some(r) => {
                let m = if r.mutability.is_some() { "mut " } else { "" };
                let a = if r.reference.is_some() { "&" } else { "" };
                format!("{}{}self", a, m)
            }
            None => String::new(),
        };
    }

    // #[test] / #[tokio::test] / #[actix_web::test] — last segment "test"
    for a in attrs {
        if attr_last_segment(a) == "test" {
            pi.is_test = true;
        }
    }

    // calls + Diesel R/W facts within THIS body only (nested items skipped)
    let mut cc = CallCollector {
        calls: vec![],
        orm_calls: vec![],
    };
    cc.visit_block(block);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for c in cc.calls {
        seen.insert(c);
    }
    pi.calls = seen.into_iter().collect();
    pi.orm_calls = cc.orm_calls;
    pi
}

fn collect_use_tree(tree: &syn::UseTree, out: &mut Vec<UseDecl>) {
    let mut acc: Vec<UseDecl> = vec![];
    collect_use_tree_inner(tree, "", &mut acc);
    out.extend(acc);
}

/// Recursively collect use targets, threading the path prefix.
/// `use crate::models::{user::User, helpers::*};` →
///   User → crate::models::user::User
///   (glob) helpers → crate::models::helpers
fn collect_use_tree_inner(tree: &syn::UseTree, prefix: &str, out: &mut Vec<UseDecl>) {
    match tree {
        syn::UseTree::Path(p) => {
            let seg = p.ident.to_string();
            let next = if prefix.is_empty() {
                seg.clone()
            } else {
                format!("{}::{}", prefix, seg)
            };
            collect_use_tree_inner(&p.tree, &next, out);
        }
        syn::UseTree::Name(n) => {
            let target = if prefix.is_empty() {
                n.ident.to_string()
            } else {
                format!("{}::{}", prefix, n.ident)
            };
            out.push(UseDecl {
                alias: n.ident.to_string(),
                target,
                glob: false,
            });
        }
        syn::UseTree::Rename(r) => {
            let target = if prefix.is_empty() {
                r.ident.to_string()
            } else {
                format!("{}::{}", prefix, r.ident)
            };
            out.push(UseDecl {
                alias: r.rename.to_string(),
                target,
                glob: false,
            });
        }
        syn::UseTree::Glob(_) => {
            out.push(UseDecl {
                alias: String::new(),
                target: prefix.to_string(),
                glob: true,
            });
        }
        syn::UseTree::Group(g) => {
            for item in &g.items {
                collect_use_tree_inner(item, prefix, out);
            }
        }
    }
}

fn collect_derives(attrs: &[syn::Attribute]) -> Vec<String> {
    let mut out = vec![];
    for a in attrs {
        if attr_last_segment(a) != "derive" {
            continue;
        }
        if let syn::Meta::List(l) = &a.meta {
            let paths = l.parse_args_with(
                syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
            );
            if let Ok(paths) = paths {
                for p in paths {
                    out.push(path_string(&p));
                }
            }
        }
    }
    out
}

fn collect_generic_bounds(generics: &syn::Generics, pi: &mut ParsedItem) {
    for param in &generics.params {
        if let syn::GenericParam::Type(tp) = param {
            for bound in &tp.bounds {
                if let syn::TypeParamBound::Trait(tb) = bound {
                    pi.supertraits.push(path_string(&tb.path));
                }
            }
        }
    }
}

// ── Diesel table! macro ──
//
fn parse_table_macro(tokens: &TokenStream) -> Option<TableDecl> {
    let mut iter = tokens.clone().into_iter();
    // first token: table name ident
    let name = match iter.next()? {
        TokenTree::Ident(i) => i.to_string(),
        _ => return None,
    };
    // optional `(pk)` group, then the `{ columns }` group
    let columns_group: proc_macro2::Group = match iter.next()? {
        TokenTree::Group(g) if g.delimiter() == proc_macro2::Delimiter::Brace => g,
        TokenTree::Group(g) if g.delimiter() == proc_macro2::Delimiter::Parenthesis => {
            match iter.next()? {
                TokenTree::Group(g2) if g2.delimiter() == proc_macro2::Delimiter::Brace => g2,
                _ => return None,
            }
        }
        _ => return None,
    };
    Some(TableDecl {
        name,
        columns: parse_table_columns(&columns_group.stream()),
    })
}

fn parse_table_columns(tokens: &TokenStream) -> Vec<(String, String)> {
    let mut out = vec![];
    let tokens: Vec<TokenTree> = tokens.clone().into_iter().collect();
    let mut idx = 0;
    while idx < tokens.len() {
        // column name ident
        let name = match &tokens[idx] {
            TokenTree::Ident(i) => i.to_string(),
            _ => {
                idx += 1;
                continue;
            }
        };
        idx += 1;
        // skip `->` (TWO puncts: '-' then '>') and ',' separators
        while idx < tokens.len() {
            match &tokens[idx] {
                TokenTree::Punct(p) if p.as_char() == '-' || p.as_char() == '>' => {
                    idx += 1;
                }
                TokenTree::Punct(p) if p.as_char() == ',' => {
                    idx += 1;
                    break;
                }
                _ => break,
            }
        }
        // type: idents (possibly with ::)
        let mut ty_parts: Vec<String> = vec![];
        while idx < tokens.len() {
            match &tokens[idx] {
                TokenTree::Ident(i) => {
                    ty_parts.push(i.to_string());
                    idx += 1;
                }
                TokenTree::Punct(p) if p.as_char() == ':' => {
                    idx += 1; // skip second ':'
                    if idx < tokens.len() {
                        idx += 1;
                    }
                }
                TokenTree::Punct(p) if p.as_char() == ',' => {
                    idx += 1;
                    break;
                }
                _ => break,
            }
        }
        if !ty_parts.is_empty() {
            out.push((name, ty_parts.join("::")));
        }
    }
    out
}

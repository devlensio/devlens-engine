// routes.rs — route detection: axum method chains + actix-web/rocket
// attribute macros → ROUTE nodes + HANDLES edges + BackendRouteNodes.
//
// Detection passes walk fn bodies (mirrors go/routes.go which keeps the
// FuncDecl for body walks); handler RESOLUTION goes through the lookup maps
// (never re-walks for resolution).
//
// axum (documented Router API): `Router::new().route("/x", get(h).post(h2))`
// chains; `.nest(prefix, router)` composes prefixes cross-variable (the
// Python APIRouter(prefix=) rule — prefix + registration can live in
// different files); `.merge(router)` unions. MethodRouter combinators
// get/post/put/delete/patch/options/head/any select the verb; a plain fn
// passed to `.route()` registers ALL methods (axum docs → "ANY").
//
// actix-web / rocket: attribute macros #[get("/x")] / #[route("/x",
// method="GET")] — macro presence IS the route declaration (the attribute
// macro contract); the framework comes from the fingerprint.

use crate::contract::{edge_with_meta, CodeEdge, CodeNode, RouteNode, NODE_ROUTE};
use crate::extractor::{Options, ParsedRepo};
use crate::fingerprint::ParsedManifest;
use crate::lookup::LookupMaps;
use crate::module_map::ModuleMap;
use crate::parser::{ParsedFile, ParsedItem};
use crate::thirdparty::ThirdPartyRegistry;
use quote::ToTokens;
use std::collections::{HashMap, HashSet};
use syn::spanned::Spanned;

pub struct RoutesOutput {
    pub route_nodes: Vec<CodeNode>,
    pub handles_edges: Vec<CodeEdge>,
    pub backend_routes: Vec<RouteNode>,
}

// ── axum facts ──

#[derive(Clone)]
enum HandlerRef {
    Ident(String),
    Path(String), // a::b::c (fn or Type::method)
    MethodValue,
    Closure,
}

#[derive(Clone)]
struct RouteOp {
    verb: String,
    raw_path: String,
    handler: HandlerRef,
    handler_name: String,
    line: i64,
    file: String,
    /// node id of the fn containing the registration (closure handlers
    /// point here — the Go var-closure rule)
    reg_fn: String,
}

#[derive(Clone)]
enum RouterOp {
    Route(RouteOp),
    Nest {
        prefix: String,
        target: String,
    },
    Merge {
        target: String,
    },
    /// utoipa-axum `.routes(routes!(h1, h2, ...))` — raw handler paths; the
    /// method+path live in each handler's `#[utoipa::path(...)]` attribute.
    /// Resolved to RouteOps by expand_macro_routes (needs repo/lookup/mf).
    MacroRoutes {
        paths: Vec<String>,
        file: String,
        line: i64,
        reg_fn: String,
    },
}

struct RouterFact {
    /// var name binding the router ("" for anonymous chains)
    key: String,
    ops: Vec<RouterOp>,
}

pub fn detect_routes(
    repo: &ParsedRepo,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    framework: &str,
    opts: &Options,
    mf: &ParsedManifest,
    tp: &mut ThirdPartyRegistry,
) -> RoutesOutput {
    let mut facts: Vec<RouterFact> = vec![];
    let mut func_lit_vars: HashMap<(String, String), String> = HashMap::new();

    for pf in &repo.files {
        if pf.is_test_file {
            continue;
        }
        for item in &pf.items {
            if item.is_test {
                continue;
            }
            let fn_id = crate::lookup::node_id_for_item(&pf.rel_path, item);
            match item.kind {
                crate::parser::KIND_FUNCTION | crate::parser::KIND_METHOD => {
                    collect_axum_facts(pf, item, &fn_id, &mut facts, &mut func_lit_vars);
                }
                _ => {}
            }
        }
    }

    let mut out = RoutesOutput {
        route_nodes: vec![],
        handles_edges: vec![],
        backend_routes: vec![],
    };
    let mut seen: HashSet<String> = HashSet::new();

    // utoipa-axum `.routes(routes!(...))` — handler paths → RouteOps (the
    // method+path come from each handler's #[utoipa::path] attribute)
    expand_macro_routes(&mut facts, repo, module_map, lookup, mf, tp);

    // ── axum: resolve nests/merges → final route list per router ──
    if framework == "axum" || framework == "unknown" {
        let mut router_map: HashMap<String, Vec<RouteOp>> = HashMap::new();
        // routers referenced by nest/merge — their routes surface ONLY via
        // the referencing router (with prefix composition); skip direct emit
        let mut referenced: HashSet<String> = HashSet::new();
        for f in &facts {
            let routes: Vec<RouteOp> = f
                .ops
                .iter()
                .filter_map(|op| match op {
                    RouterOp::Route(r) => Some(r.clone()),
                    _ => None,
                })
                .collect();
            router_map.entry(f.key.clone()).or_default().extend(routes);
            for op in &f.ops {
                match op {
                    RouterOp::Nest { target, .. } | RouterOp::Merge { target, .. } => {
                        referenced.insert(target.clone());
                    }
                    _ => {}
                }
            }
        }
        for f in &facts {
            if referenced.contains(&f.key) {
                continue; // consumed by a nest/merge — composed elsewhere
            }
            let mut final_routes: Vec<RouteOp> = vec![];
            let mut stack: Vec<&RouterOp> = f.ops.iter().collect();
            // compose: nests bring in the target router's routes with prefix
            while let Some(op) = stack.pop() {
                match op {
                    RouterOp::Route(r) => final_routes.push(r.clone()),
                    RouterOp::MacroRoutes { .. } => {
                        // expanded by expand_macro_routes before composition
                    }
                    RouterOp::Merge { target, .. } => {
                        if let Some(inner) = router_map.get(target) {
                            final_routes.extend(inner.iter().cloned());
                        }
                    }
                    RouterOp::Nest { prefix, target, .. } => {
                        if let Some(inner) = router_map.get(target) {
                            for r in inner {
                                let mut r2 = r.clone();
                                r2.raw_path = compose_paths(prefix, &r2.raw_path);
                                final_routes.push(r2);
                            }
                        }
                    }
                }
            }
            for r in final_routes {
                emit_route(
                    &r,
                    framework,
                    &func_lit_vars,
                    module_map,
                    lookup,
                    &mut out,
                    &mut seen,
                );
            }
        }
    }

    // ── actix-web / rocket: attribute macros ──
    if framework == "actix-web" || framework == "rocket" {
        for pf in &repo.files {
            if pf.is_test_file {
                continue;
            }
            for item in &pf.items {
                if item.is_test {
                    continue;
                }
                if item.kind == crate::parser::KIND_FUNCTION
                    || item.kind == crate::parser::KIND_METHOD
                {
                    detect_macro_routes(pf, item, framework, &mut out, &mut seen);
                }
            }
        }
    }

    let _ = opts;
    out
}

/// Collect router chains inside one fn body (axum).
fn collect_axum_facts(
    pf: &ParsedFile,
    item: &ParsedItem,
    fn_id: &str,
    facts: &mut Vec<RouterFact>,
    func_lit_vars: &mut HashMap<(String, String), String>,
) {
    let fn_node = find_fn_ast(&pf.ast, item);
    let Some(fn_node) = fn_node else { return };
    let body = match fn_node {
        FnAst::Free(f) => &f.block,
        FnAst::Impl(i) => &i.block,
    };

    // 1) closure/let bindings for handler resolution:
    //    `let api_handler = |...| {...};` → api_handler → fn_id
    // 2) router var bindings: `let app = Router::new()...;`
    // 3) outer method-chain exprs whose receiver chain is a router
    let mut router_vars: HashSet<String> = HashSet::new();
    let mut chain_exprs: Vec<syn::Expr> = vec![];
    collect_bindings(
        body,
        fn_id,
        pf,
        func_lit_vars,
        &mut router_vars,
        &mut chain_exprs,
    );

    // anonymous chains (no let binding): outer MethodCall exprs
    let mut seen_chains: HashSet<String> = HashSet::new();
    for e in &chain_exprs {
        let ops = chain_ops(e, pf, &router_vars, fn_id);
        if ops.is_empty() {
            continue;
        }
        // dedupe identical chains (each link of a chain matches)
        let sig = ops
            .iter()
            .map(|o| match o {
                RouterOp::Route(r) => format!("R{} {}", r.verb, r.raw_path),
                RouterOp::Nest { prefix, target, .. } => format!("N{} {}", prefix, target),
                RouterOp::Merge { target, .. } => format!("M{}", target),
                RouterOp::MacroRoutes { paths, .. } => {
                    format!("MR{}", paths.join(","))
                }
            })
            .collect::<Vec<_>>()
            .join("|");
        if !seen_chains.insert(sig) {
            continue;
        }
        // key = the fn NAME: `nest("/api", routes::api_router())` targets a
        // router returned from a fn — the fn name IS the router key
        facts.push(RouterFact {
            key: item.name.clone(),
            ops,
        });
    }
    // router vars bound to chains
    for var in &router_vars {
        if let Some(root) = find_router_var_expr(body, var) {
            let ops = chain_ops(&root, pf, &router_vars, fn_id);
            if !ops.is_empty() {
                facts.push(RouterFact {
                    key: var.clone(),
                    ops,
                });
            }
        }
    }
}

enum FnAst<'a> {
    Free(&'a syn::ItemFn),
    Impl(&'a syn::ImplItemFn),
}

/// Find the fn item in the AST matching a ParsedItem (name + start line).
fn find_fn_ast<'a>(file: &'a syn::File, item: &ParsedItem) -> Option<FnAst<'a>> {
    fn walk<'a>(items: &'a [syn::Item], item: &ParsedItem) -> Option<FnAst<'a>> {
        for it in items {
            match it {
                syn::Item::Fn(f) => {
                    if f.sig.ident == item.name
                        && f.sig.span().start().line as i64 == item.start_line
                    {
                        return Some(FnAst::Free(f));
                    }
                }
                syn::Item::Impl(im) => {
                    for ii in &im.items {
                        if let syn::ImplItem::Fn(ifn) = ii {
                            if ifn.sig.ident == item.name
                                && ifn.sig.span().start().line as i64 == item.start_line
                            {
                                return Some(FnAst::Impl(ifn));
                            }
                        }
                    }
                }
                syn::Item::Mod(m) => {
                    if let Some((_, inner)) = &m.content {
                        if let Some(hit) = walk(inner, item) {
                            return Some(hit);
                        }
                    }
                }
                _ => {}
            }
        }
        None
    }
    walk(&file.items, item)
}

/// Walk a body: closure/let-var bindings, router var bindings, router chains.
///
/// Iterates STATEMENTS directly (not exprs derived from `Stmt::Local`'s
/// init). Syn distinguishes `Stmt::Local` (a let STATEMENT:
/// `let x = ...;`/`let (a, b) = ...;`) from `Expr::Let` (a let-CHAIN, only
/// valid inside `if`/`while` conditions: `if let Some(x) = ...`). The previous
/// seed collapsed `Stmt::Local` → `&init.expr`, so the `Expr::Let` arm below
/// only fired for let-chains (rare) — `let (router, openapi) = ...` and plain
/// `let app = Router::new()` statements NEVER registered their bindings,
/// silently killing router_vars. Fix: handle `Stmt::Local` directly for
/// `Pat::Ident`/`Pat::Tuple`, and descend into `Stmt::Expr` for chains.
#[allow(clippy::collapsible_if)]
fn collect_bindings(
    body: &syn::Block,
    fn_id: &str,
    pf: &ParsedFile,
    func_lit_vars: &mut HashMap<(String, String), String>,
    router_vars: &mut HashSet<String>,
    chain_exprs: &mut Vec<syn::Expr>,
) {
    // reversed seed → pop() yields FORWARD order, so let-shadowing
    // (`let router = ...; let router = router.route(...)`) and reassignment
    // resolve in source order
    let mut stack: Vec<StmtNode> = body
        .stmts
        .iter()
        .rev()
        .filter_map(|s| match s {
            syn::Stmt::Local(l) => Some(StmtNode::Local(l)),
            syn::Stmt::Expr(e, _) => Some(StmtNode::Expr(e)),
            _ => None,
        })
        .collect();
    let mut seen: HashSet<usize> = HashSet::new();
    while let Some(node) = stack.pop() {
        match node {
            StmtNode::Local(l) => {
                // let STATEMENT: `let pat = init;`
                let Some(init) = &l.init else {
                    continue;
                };
                let expr = &*init.expr;
                match &l.pat {
                    syn::Pat::Ident(pid) => {
                        let name = pid.ident.to_string();
                        if is_router_expr(expr, router_vars) {
                            router_vars.insert(name.clone());
                            chain_exprs.push(expr.clone());
                        }
                        if let syn::Expr::Closure(_) = expr {
                            func_lit_vars.insert((pf.rel_path.clone(), name), fn_id.to_string());
                        }
                    }
                    syn::Pat::Tuple(t) if is_router_expr(expr, router_vars) => {
                        // `let (router, openapi) = BaseOpenApi::router()` —
                        // utoipa-axum's documented (Router, OpenApi) return;
                        // the FIRST binding is the router
                        if let Some(syn::Pat::Ident(pid)) = t.elems.first() {
                            router_vars.insert(pid.ident.to_string());
                        }
                        chain_exprs.push(expr.clone());
                    }
                    _ => {}
                }
                // descend into nested blocks/calls for inner router chains
                push_children_stmt(expr, &mut stack);
            }
            StmtNode::Expr(e) => {
                let ptr = e as *const syn::Expr as usize;
                if !seen.insert(ptr) {
                    continue;
                }
                match e {
                    syn::Expr::Let(l) => {
                        // let-CHAIN (inside if/while conditions): same shape
                        // as a let statement but parsed as an expression
                        if let syn::Pat::Ident(pid) = l.pat.as_ref() {
                            let name = pid.ident.to_string();
                            if is_router_expr(&l.expr, router_vars) {
                                router_vars.insert(name.clone());
                                chain_exprs.push((*l.expr).clone());
                            }
                            if let syn::Expr::Closure(_) = &*l.expr {
                                func_lit_vars
                                    .insert((pf.rel_path.clone(), name), fn_id.to_string());
                            }
                        } else if let syn::Pat::Tuple(t) = l.pat.as_ref() {
                            if is_router_expr(&l.expr, router_vars) {
                                if let Some(syn::Pat::Ident(pid)) = t.elems.first() {
                                    router_vars.insert(pid.ident.to_string());
                                }
                                chain_exprs.push((*l.expr).clone());
                            }
                        }
                    }
                    syn::Expr::Assign(a) => {
                        // `router = router.route(...)` — axum builder
                        // reassignment (documented pattern; crates.io
                        // router.rs registers the dev git-index route this way)
                        if let syn::Expr::Path(p) = &*a.left {
                            if p.qself.is_none()
                                && p.path.segments.len() == 1
                                && router_vars.contains(&p.path.segments[0].ident.to_string())
                                && is_router_expr(&a.right, router_vars)
                            {
                                chain_exprs.push((*a.right).clone());
                            }
                        }
                    }
                    syn::Expr::MethodCall(mc) if is_router_expr(&mc.receiver, router_vars) => {
                        chain_exprs.push(e.clone());
                    }
                    _ => {}
                }
                push_children_stmt(e, &mut stack);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum StmtNode<'a> {
    Local(&'a syn::Local),
    Expr(&'a syn::Expr),
}

/// Push child expressions onto the stack for continued traversal.
/// (children pushed reversed → forward order on pop)
fn push_children_stmt<'a>(e: &'a syn::Expr, stack: &mut Vec<StmtNode<'a>>) {
    match e {
        syn::Expr::Block(b) => {
            for s in b.block.stmts.iter().rev() {
                match s {
                    syn::Stmt::Local(l) => stack.push(StmtNode::Local(l)),
                    syn::Stmt::Expr(ie, _) => stack.push(StmtNode::Expr(ie)),
                    _ => {}
                }
            }
        }
        syn::Expr::Let(l) => stack.push(StmtNode::Expr(&l.expr)),
        syn::Expr::Call(c) => {
            stack.push(StmtNode::Expr(&c.func));
            for a in c.args.iter().rev() {
                stack.push(StmtNode::Expr(a));
            }
        }
        syn::Expr::MethodCall(mc) => {
            stack.push(StmtNode::Expr(&mc.receiver));
            for a in mc.args.iter().rev() {
                stack.push(StmtNode::Expr(a));
            }
        }
        _ => {}
    }
}

/// Is `e` a router constructor call? Covers:
///   - `Router::new()` / `axum::Router::new()` / `Router::<S>::new()`
///     (path segments ... Router::new)
///   - `BaseOpenApi::router()` — utoipa-axum's documented (Router, OpenApi)
///     constructor; also accepts a bare `router()` free-fn call (a local
///     builder fn returning Router — heuristic, only matters when the result
///     is then chained with .route()/.nest()/.routes())
fn is_router_new(e: &syn::Expr) -> bool {
    let syn::Expr::Call(c) = e else {
        return false;
    };
    let syn::Expr::Path(p) = &*c.func else {
        return false;
    };
    if p.qself.is_some() {
        return false;
    }
    let segs = &p.path.segments;
    if segs.is_empty() {
        return false;
    }
    let last = segs.last().map(|s| s.ident.to_string()).unwrap_or_default();
    if last == "router" {
        return true;
    }
    last == "new"
        && segs
            .get(segs.len() - 2)
            .map(|s| s.ident == "Router")
            .unwrap_or(false)
}

fn is_router_expr(e: &syn::Expr, router_vars: &HashSet<String>) -> bool {
    match e {
        syn::Expr::Call(c) => {
            is_router_new(e) || {
                match &*c.func {
                    syn::Expr::MethodCall(mc) => is_router_expr(&mc.receiver, router_vars),
                    _ => false,
                }
            }
        }
        syn::Expr::MethodCall(mc) => is_router_expr(&mc.receiver, router_vars),
        syn::Expr::Path(p) => {
            p.qself.is_none()
                && p.path.segments.len() == 1
                && router_vars.contains(&p.path.segments[0].ident.to_string())
        }
        _ => false,
    }
}

fn find_router_var_expr(body: &syn::Block, var: &str) -> Option<syn::Expr> {
    for stmt in &body.stmts {
        if let syn::Stmt::Local(l) = stmt {
            if let syn::Pat::Ident(pid) = &l.pat {
                if pid.ident == var {
                    if let Some(init) = &l.init {
                        return Some((*init.expr).clone());
                    }
                }
            }
        }
    }
    None
}

// ── utoipa-axum `.routes(routes!(...))` ──
//
// utoipa-axum (the standard OpenAPI router for axum; used by crates.io in
// production) registers handlers in BATCHES: `router.routes(routes!(a::b::c,
// d::e::f))`. The method + path for each handler live in its
// `#[utoipa::path(get, path = "/api/v1/x", ...)]` attribute — the documented
// utoipa contract. Handlers without the attribute (not OpenAPI'd) are
// skipped — their route info simply doesn't exist in the source.

/// Expand MacroRoutes ops (raw handler paths) into RouteOps by reading each
/// handler's `#[utoipa::path]` attribute.
fn expand_macro_routes(
    facts: &mut [RouterFact],
    repo: &ParsedRepo,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    mf: &ParsedManifest,
    tp: &mut ThirdPartyRegistry,
) {
    for f in facts.iter_mut() {
        let mut out: Vec<RouterOp> = vec![];
        for op in std::mem::take(&mut f.ops) {
            match op {
                RouterOp::MacroRoutes {
                    paths,
                    file,
                    line,
                    reg_fn,
                } => {
                    let base_module = crate::walker::module_path_for_file(&file);
                    for p in paths {
                        if let Some(op2) = utoipa_route_op(
                            &p,
                            &file,
                            &base_module,
                            line,
                            &reg_fn,
                            repo,
                            module_map,
                            lookup,
                            mf,
                            tp,
                        ) {
                            out.push(op2);
                        }
                    }
                }
                other => out.push(other),
            }
        }
        f.ops = out;
    }
}

/// Resolve ONE `routes!(...)` handler path to a RouteOp (method+path from the
/// handler's `#[utoipa::path]` attribute).
#[allow(clippy::too_many_arguments)]
fn utoipa_route_op(
    handler_path: &str,
    file: &str,
    base_module: &str,
    line: i64,
    reg_fn: &str,
    repo: &ParsedRepo,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    mf: &ParsedManifest,
    tp: &mut ThirdPartyRegistry,
) -> Option<RouterOp> {
    let node_id = crate::calls::resolve_path_call(
        handler_path,
        file,
        base_module,
        module_map,
        lookup,
        mf,
        tp,
    )?;
    let (hfile, hname) = node_id.rsplit_once("::")?;
    let item = repo
        .files
        .iter()
        .find(|pf| pf.rel_path == hfile)
        .and_then(|pf| {
            pf.items
                .iter()
                .find(|it| it.name == hname && it.kind == crate::parser::KIND_FUNCTION)
        })?;
    let (verb, path) = utoipa_attr(&item.attrs)?;
    Some(RouterOp::Route(RouteOp {
        verb,
        raw_path: path,
        handler: HandlerRef::Ident(hname.to_string()),
        handler_name: hname.to_string(),
        line,
        file: file.to_string(),
        reg_fn: reg_fn.to_string(),
    }))
}

/// Parse `#[utoipa::path(get, path = "/api/v1/crates", ...)]` → (verb, path).
/// Returns None when the attribute is absent or lacks path/method info.
fn utoipa_attr(attrs: &[crate::parser::AttrInfo]) -> Option<(String, String)> {
    for a in attrs {
        if a.path != "utoipa::path" {
            continue;
        }
        // first token = the HTTP verb ident (`get`, `post`, `delete`, ...).
        // utoipa's #[utoipa::path(get, path = "/x", ...)] documents the verb
        // as a bare ident; normalize to uppercase for parity with axum's
        // get()/post()/... combinators and the route node contract.
        let verb = a
            .args
            .split(|c: char| c == ',' || c.is_whitespace())
            .next()?
            .trim()
            .to_uppercase();
        if verb.is_empty() {
            return None;
        }
        // `path = "/x"` — tokens render with spaces; normalize `path=` too
        let norm: String = a.args.split_whitespace().collect::<Vec<_>>().join(" ");
        let norm = norm.replace("path=", "path = ");
        let path = norm
            .split("path = ")
            .nth(1)?
            .trim_start_matches('"')
            .split('"')
            .next()?
            .to_string();
        if path.is_empty() {
            return None;
        }
        return Some((verb, path));
    }
    None
}

/// Parse `routes!(a::b::c, d::e::f)` macro tokens → ["a::b::c", "d::e::f"].
fn macro_path_args(tokens: &proc_macro2::TokenStream) -> Vec<String> {
    let mut out = vec![];
    let mut cur: Vec<String> = vec![];
    for tt in tokens.clone() {
        match tt {
            proc_macro2::TokenTree::Ident(i) => cur.push(i.to_string()),
            proc_macro2::TokenTree::Punct(p) => match p.as_char() {
                ':' => {
                    if cur.last().map(|s| s != "::").unwrap_or(false) {
                        cur.push("::".to_string());
                    }
                    // second ':' of a path separator — already recorded
                }
                ',' if !cur.is_empty() => {
                    out.push(cur.join(""));
                    cur.clear();
                }
                _ => {}
            },
            _ => {}
        }
    }
    if !cur.is_empty() {
        out.push(cur.join(""));
    }
    out
}

/// Extract route/nest/merge ops from a router chain expr (walking INWARD
/// along receivers — the outermost MethodCall first).
fn chain_ops(
    outer: &syn::Expr,
    pf: &ParsedFile,
    router_vars: &HashSet<String>,
    fn_id: &str,
) -> Vec<RouterOp> {
    let mut ops = vec![];
    let mut current = outer.clone();
    while let syn::Expr::MethodCall(mc) = &current {
        let method = mc.method.to_string();
        let line = mc.span().start().line as i64;
        match method.as_str() {
            "route" => {
                if mc.args.len() >= 2 {
                    let path = lit_str(&mc.args[0]);
                    let handler_arg = &mc.args[1];
                    let ops2 = method_router_ops(handler_arg, &path, pf, line, fn_id);
                    ops.extend(ops2);
                }
            }
            "routes" => {
                // utoipa-axum: `.routes(routes!(h1, h2, ...))` — batch
                // registration; method+path come from each handler's
                // #[utoipa::path(...)] attribute (resolved later)
                if let Some(syn::Expr::Macro(m)) = mc.args.first() {
                    let is_routes_macro = m
                        .mac
                        .path
                        .segments
                        .last()
                        .map(|s| s.ident == "routes")
                        .unwrap_or(false);
                    if is_routes_macro {
                        let paths = macro_path_args(&m.mac.tokens);
                        if !paths.is_empty() {
                            ops.push(RouterOp::MacroRoutes {
                                paths,
                                file: pf.rel_path.clone(),
                                line,
                                reg_fn: fn_id.to_string(),
                            });
                        }
                    }
                }
            }
            "nest" => {
                if mc.args.len() >= 2 {
                    let prefix = lit_str(&mc.args[0]);
                    let target = expr_ident(&mc.args[1]);
                    ops.push(RouterOp::Nest { prefix, target });
                }
            }
            "merge" => {
                if let Some(target) = mc.args.first() {
                    let target = expr_ident(target);
                    ops.push(RouterOp::Merge { target });
                }
            }
            // with_state / layer / route_layer / fallback — not routes
            _ => {}
        }
        match &*mc.receiver {
            syn::Expr::MethodCall(inner) => current = syn::Expr::MethodCall(inner.clone()),
            syn::Expr::Call(inner) => current = syn::Expr::Call(inner.clone()),
            syn::Expr::Path(p) => {
                if p.qself.is_none()
                    && p.path.segments.len() == 1
                    && router_vars.contains(&p.path.segments[0].ident.to_string())
                {
                    break;
                }
                break;
            }
            _ => break,
        }
    }
    ops
}

/// Expand a MethodRouter combinator: `get(h).post(h2)` → [GET h, POST h2];
/// plain fn/ident → ANY (axum registers all methods).
fn method_router_ops(
    e: &syn::Expr,
    path: &str,
    pf: &ParsedFile,
    line: i64,
    fn_id: &str,
) -> Vec<RouterOp> {
    let mut out = vec![];
    match e {
        syn::Expr::Call(c) => {
            if let syn::Expr::Path(p) = &*c.func {
                if p.qself.is_none() {
                    if let Some(verb) = verb_for(&p.path) {
                        out.push(route_op(&verb, path, c.args.first(), pf, line, fn_id));
                    }
                }
            }
        }
        syn::Expr::MethodCall(mc) => {
            // chain: get(h).post(h2) — root first, then chained methods
            let mut chain: Vec<&syn::ExprMethodCall> = vec![mc];
            let mut recv = &mc.receiver;
            while let syn::Expr::MethodCall(inner) = &**recv {
                chain.push(inner);
                recv = &inner.receiver;
            }
            for m in chain.iter().rev() {
                if let Some(verb) = verb_for_method(&m.method.to_string()) {
                    out.push(route_op(&verb, path, m.args.first(), pf, line, fn_id));
                }
            }
            if let syn::Expr::Call(c) = &**recv {
                if let syn::Expr::Path(p) = &*c.func {
                    if p.qself.is_none() {
                        if let Some(verb) = verb_for(&p.path) {
                            out.push(route_op(&verb, path, c.args.first(), pf, line, fn_id));
                        }
                    }
                }
            }
        }
        _ => {
            // plain handler → ALL methods
            out.push(route_op("ANY", path, Some(e), pf, line, fn_id));
        }
    }
    out
}

fn verb_for(p: &syn::Path) -> Option<String> {
    verb_for_method(&p.segments.last()?.ident.to_string())
}

fn verb_for_method(m: &str) -> Option<String> {
    match m {
        "get" => Some("GET".to_string()),
        "post" => Some("POST".to_string()),
        "put" => Some("PUT".to_string()),
        "delete" => Some("DELETE".to_string()),
        "patch" => Some("PATCH".to_string()),
        "options" => Some("OPTIONS".to_string()),
        "head" => Some("HEAD".to_string()),
        "any" => Some("ANY".to_string()),
        _ => None,
    }
}

fn route_op(
    verb: &str,
    path: &str,
    handler: Option<&syn::Expr>,
    pf: &ParsedFile,
    line: i64,
    fn_id: &str,
) -> RouterOp {
    let (hr, name) = match handler {
        Some(syn::Expr::Path(p)) if p.qself.is_none() && p.path.segments.len() == 1 => (
            HandlerRef::Ident(p.path.segments[0].ident.to_string()),
            p.path.segments[0].ident.to_string(),
        ),
        Some(syn::Expr::Path(p)) if p.qself.is_none() => (
            HandlerRef::Path(
                p.path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::"),
            ),
            p.path
                .segments
                .last()
                .map(|s| s.ident.to_string())
                .unwrap_or_default(),
        ),
        Some(syn::Expr::Closure(_)) => (HandlerRef::Closure, "<closure>".to_string()),
        Some(syn::Expr::MethodCall(mc)) => (HandlerRef::MethodValue, mc.method.to_string()),
        _ => (HandlerRef::Closure, "<expr>".to_string()),
    };
    RouterOp::Route(RouteOp {
        verb: verb.to_string(),
        raw_path: path.to_string(),
        handler: hr,
        handler_name: name,
        line,
        file: pf.rel_path.clone(),
        reg_fn: fn_id.to_string(),
    })
}

fn lit_str(e: &syn::Expr) -> String {
    if let syn::Expr::Lit(syn::ExprLit {
        lit: syn::Lit::Str(s),
        ..
    }) = e
    {
        s.value()
    } else {
        String::new()
    }
}

fn expr_ident(e: &syn::Expr) -> String {
    match e {
        syn::Expr::Path(p) => {
            if p.qself.is_none() && p.path.segments.len() == 1 {
                return p.path.segments[0].ident.to_string();
            }
        }
        // `nest("/api", routes::api_router())` — the target router is the
        // RETURN VALUE of the called fn; the fn name IS the router key
        // (the var fact carries that key — see collect_axum_facts)
        syn::Expr::Call(c) => {
            if let syn::Expr::Path(p) = &*c.func {
                if p.qself.is_none() {
                    if let Some(last) = p.path.segments.last() {
                        return last.ident.to_string();
                    }
                }
            }
        }
        _ => {}
    }
    collapse(e.to_token_stream().to_string())
}

fn collapse(s: String) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── emission ──

fn emit_route(
    r: &RouteOp,
    framework: &str,
    func_lit_vars: &HashMap<(String, String), String>,
    module_map: &ModuleMap,
    lookup: &LookupMaps,
    out: &mut RoutesOutput,
    seen: &mut HashSet<String>,
) {
    let (norm, params) = normalize_path(&r.raw_path);
    let is_dynamic = !params.is_empty();
    let id = format!("{}::{} {}", r.file, r.verb, norm);
    if !seen.insert(id.clone()) {
        return;
    }

    // handler resolution
    let (handler_id, kind) = match &r.handler {
        HandlerRef::Ident(name) => {
            if let Some(id) = lookup.closest_by_path(name, &r.file) {
                (Some(id), "function".to_string())
            } else if let Some(id) = func_lit_vars.get(&(r.file.clone(), name.clone())) {
                (Some(id.clone()), "closure".to_string())
            } else {
                (None, "unresolved".to_string())
            }
        }
        HandlerRef::Path(path) => {
            let base_module = crate::walker::module_path_for_file(&r.file);
            if let Some((file, rest)) = module_map.resolve(path, &base_module) {
                if rest.is_empty() {
                    (lookup.closest_by_path(path, &file), "function".to_string())
                } else {
                    let parts: Vec<&str> = rest.split("::").collect();
                    if parts.len() == 1 {
                        // plain fn in the resolved module
                        (
                            lookup.closest_by_path(parts[0], &file),
                            "function".to_string(),
                        )
                    } else {
                        // Type::method
                        let mid = method_id_for(parts[0], parts[1], &file, lookup);
                        (mid, "method".to_string())
                    }
                }
            } else {
                (None, "unresolved".to_string())
            }
        }
        HandlerRef::Closure => (Some(r.reg_fn.clone()), "closure".to_string()),
        HandlerRef::MethodValue => (None, "unresolved".to_string()),
    };

    let handler_name = r.handler_name.clone();

    let mut meta = serde_json::Map::new();
    meta.insert("urlPath".to_string(), norm.clone().into());
    meta.insert("httpMethod".to_string(), r.verb.clone().into());
    meta.insert("isDynamic".to_string(), is_dynamic.into());
    meta.insert(
        "params".to_string(),
        serde_json::Value::Array(
            params
                .iter()
                .map(|p| serde_json::Value::from(p.clone()))
                .collect(),
        ),
    );
    meta.insert("framework".to_string(), framework.into());
    meta.insert("handlerName".to_string(), handler_name.clone().into());
    meta.insert("routeKind".to_string(), "backend".into());
    meta.insert("rawPath".to_string(), r.raw_path.clone().into());

    let node = crate::contract::code_node(
        &id,
        &r.file,
        &format!("{} {}", r.verb, norm),
        NODE_ROUTE,
        r.line,
        r.line,
        "",
        meta,
    );
    out.route_nodes.push(node);

    if let Some(hid) = handler_id {
        let mut m = serde_json::Map::new();
        m.insert("urlPath".to_string(), norm.clone().into());
        m.insert("httpMethod".to_string(), r.verb.clone().into());
        m.insert("framework".to_string(), framework.into());
        m.insert("handlerKind".to_string(), kind.into());
        out.handles_edges
            .push(edge_with_meta(&id, &hid, "HANDLES", m));
    }

    out.backend_routes.push(RouteNode {
        route_type: "BACKEND_ROUTE".to_string(),
        url_path: norm.clone(),
        file_path: r.file.clone(),
        http_method: r.verb.clone(),
        framework: framework.to_string(),
        is_dynamic,
        params,
        handler_name,
        node_id: id,
    });
}

fn method_id_for(owner: &str, method: &str, file: &str, lookup: &LookupMaps) -> Option<String> {
    let ids = lookup.methods_by_owner.get(owner)?;
    let matches = |id: &String| {
        id.ends_with(&format!(".{}", method)) || id.contains(&format!(".{}::", method))
    };
    ids.iter()
        .find(|id| id.starts_with(&format!("{}::", file)) && matches(id))
        .or_else(|| ids.iter().find(|id| matches(id)))
        .cloned()
}

/// :param / {param} / <param> / *wild → {param}; collapses double slashes.
fn normalize_path(p: &str) -> (String, Vec<String>) {
    let mut params = vec![];
    let mut out = String::new();
    let chars: Vec<char> = p.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == ':' || c == '*' {
            let mut name = String::new();
            i += 1;
            while i < chars.len() && chars[i] != '/' {
                name.push(chars[i]);
                i += 1;
            }
            params.push(name.clone());
            out.push_str(&format!("{{{}}}", name));
        } else if c == '{' || c == '<' {
            let close = if c == '{' { '}' } else { '>' };
            let mut name = String::new();
            i += 1;
            while i < chars.len() && chars[i] != close {
                name.push(chars[i]);
                i += 1;
            }
            i += 1; // skip close
            params.push(name.clone());
            out.push_str(&format!("{{{}}}", name));
        } else {
            out.push(c);
            i += 1;
        }
    }
    while out.contains("//") {
        out = out.replace("//", "/");
    }
    if out.is_empty() {
        out = "/".to_string();
    }
    (out, params)
}

fn compose_paths(prefix: &str, path: &str) -> String {
    if prefix.is_empty() {
        return path.to_string();
    }
    format!(
        "{}/{}",
        prefix.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

// ── actix-web / rocket attribute macros ──

const MACRO_VERBS: [(&str, &str); 8] = [
    ("get", "GET"),
    ("post", "POST"),
    ("put", "PUT"),
    ("delete", "DELETE"),
    ("patch", "PATCH"),
    ("head", "HEAD"),
    ("options", "OPTIONS"),
    ("any", "ANY"),
];

fn detect_macro_routes(
    pf: &ParsedFile,
    item: &ParsedItem,
    framework: &str,
    out: &mut RoutesOutput,
    seen: &mut HashSet<String>,
) {
    for attr in &item.attrs {
        let last = attr.path.rsplit("::").next().unwrap_or("").to_string();
        let verb = if last == "route" {
            parse_route_attr(&attr.args)
        } else {
            MACRO_VERBS
                .iter()
                .find(|(m, _)| *m == last)
                .map(|(_, v)| v.to_string())
        };
        let Some(verb) = verb else { continue };
        let path = if last == "route" {
            parse_route_attr_path(&attr.args)
        } else {
            parse_lit_from_tokens(&attr.args)
        };
        if path.is_empty() {
            continue;
        }
        let (norm, params) = normalize_path(&path);
        let is_dynamic = !params.is_empty();
        let id = format!("{}::{} {}", pf.rel_path, verb, norm);
        if !seen.insert(id.clone()) {
            continue;
        }
        let handler_id = crate::lookup::node_id_for_item(&pf.rel_path, item);

        let mut meta = serde_json::Map::new();
        meta.insert("urlPath".to_string(), norm.clone().into());
        meta.insert("httpMethod".to_string(), verb.clone().into());
        meta.insert("isDynamic".to_string(), is_dynamic.into());
        meta.insert(
            "params".to_string(),
            serde_json::Value::Array(
                params
                    .iter()
                    .map(|p| serde_json::Value::from(p.clone()))
                    .collect(),
            ),
        );
        meta.insert("framework".to_string(), framework.into());
        meta.insert("handlerName".to_string(), item.name.clone().into());
        meta.insert("routeKind".to_string(), "backend".into());
        meta.insert("rawPath".to_string(), path.clone().into());

        let node = crate::contract::code_node(
            &id,
            &pf.rel_path,
            &format!("{} {}", verb, norm),
            NODE_ROUTE,
            item.start_line,
            item.end_line,
            "",
            meta,
        );
        out.route_nodes.push(node);

        let mut m = serde_json::Map::new();
        m.insert("urlPath".to_string(), norm.clone().into());
        m.insert("httpMethod".to_string(), verb.clone().into());
        m.insert("framework".to_string(), framework.into());
        m.insert("handlerKind".to_string(), "function".into());
        out.handles_edges
            .push(edge_with_meta(&id, &handler_id, "HANDLES", m));

        out.backend_routes.push(RouteNode {
            route_type: "BACKEND_ROUTE".to_string(),
            url_path: norm.clone(),
            file_path: pf.rel_path.clone(),
            http_method: verb.clone(),
            framework: framework.to_string(),
            is_dynamic,
            params,
            handler_name: item.name.clone(),
            node_id: id,
        });
    }
}

fn parse_lit_from_tokens(tokens: &str) -> String {
    // `"/users/{id}"` — tokens render with quotes; strip them
    let t = tokens.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        String::new()
    }
}

fn parse_route_attr(tokens: &str) -> Option<String> {
    // `"/path", method = "GET"` → GET
    let parts: Vec<&str> = tokens.split(',').collect();
    for part in parts {
        let part = part.trim();
        if let Some((_, v)) = part.split_once('=') {
            let v = v.trim().trim_matches('"').to_uppercase();
            if v == "GET" || v == "POST" || v == "PUT" || v == "DELETE" || v == "PATCH" {
                return Some(v);
            }
        }
    }
    None
}

fn parse_route_attr_path(tokens: &str) -> String {
    let t = tokens.trim();
    if t.len() >= 2 && t.starts_with('"') {
        if let Some(end) = t[1..].find('"') {
            return t[1..1 + end].to_string();
        }
    }
    String::new()
}

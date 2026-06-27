// Detects client-side navigation and emits NAVIGATES_TO edges from
// COMPONENT/HOOK/FUNCTION nodes to ROUTE nodes. Covers React Router (v5/v6),
// TanStack Router, wouter, Next.js (next/link, next/navigation, next/router),
// and native window.location / window.history navigation.
//
// Structure mirrors apiFetchEdges.ts: one ts-morph Project, each candidate
// file scanned once, calls attributed to the innermost owning node by line
// range, paths normalized + matched against a route index, edges deduped.
import { Project, SyntaxKind } from "ts-morph";
import path from "node:path";
import { extractUrlFromArg, normalizeUrl, urlPathtoRegex } from "./helpers/routeMatching.js";
// Recognized routing libraries (import-source gating).
const RR_LIBS = ["react-router-dom", "react-router", "wouter", "@tanstack/react-router"];
const NEXT_LINK_LIBS = ["next/link"];
const NEXT_ROUTER_LIBS = ["next/navigation", "next/router"];
// Build the route index from navigable ROUTE nodes (NOT API routes).
function buildNavRouteIndex(nodes) {
    const staticByPath = new Map();
    const dynamic = [];
    const routeNodes = nodes.filter(n => n.type === "ROUTE" &&
        (n.metadata.routeNodeType === "PAGE" || n.metadata.routeNodeType === "REACT_ROUTER_ROUTE") &&
        typeof n.metadata.urlPath === "string");
    for (const routeNode of routeNodes) {
        const urlPath = routeNode.metadata.urlPath;
        const isDynamic = Boolean(routeNode.metadata.isDynamic);
        const entry = { routeNode, urlPath, isDynamic, urlRegex: urlPathtoRegex(urlPath) };
        if (isDynamic)
            dynamic.push(entry);
        else if (!staticByPath.has(urlPath))
            staticByPath.set(urlPath, entry);
    }
    return { staticByPath, dynamic };
}
// Two-pass match: static exact first, then dynamic regex.
function matchNavRoute(normalizedUrl, index) {
    const exact = index.staticByPath.get(normalizedUrl);
    if (exact)
        return exact;
    for (const e of index.dynamic) {
        if (e.urlRegex.test(normalizedUrl))
            return e;
    }
    return null;
}
// Per-file map: local imported name → module specifier.
function buildImportSourceMap(sourceFile) {
    const map = new Map();
    for (const importDecl of sourceFile.getImportDeclarations()) {
        const spec = importDecl.getModuleSpecifierValue();
        for (const named of importDecl.getNamedImports()) {
            const local = named.getAliasNode()?.getText() ?? named.getName();
            map.set(local, spec);
        }
        const def = importDecl.getDefaultImport();
        if (def)
            map.set(def.getText(), spec);
        const ns = importDecl.getNamespaceImport();
        if (ns)
            map.set(ns.getText(), spec);
    }
    return map;
}
// Track local vars bound to navigate fn / router obj / history obj — only when
// the producing hook is imported from a recognized routing library.
function buildNavBindingMaps(sourceFile, importMap) {
    const navigateVars = new Set(); // useNavigate (RR / TanStack)
    const routerVars = new Set(); // useRouter   (Next.js)
    const historyVars = new Set(); // useHistory  (RR v5)
    // Use descendants, not getVariableDeclarations() — the latter only returns
    // top-level declarations, but `const navigate = useNavigate()` lives inside
    // the component/hook body.
    for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const init = decl.getInitializer();
        if (!init || init.getKind() !== SyntaxKind.CallExpression)
            continue;
        const callee = init.getExpression().getText();
        const src = importMap.get(callee);
        if (!src)
            continue;
        const nameNode = decl.getNameNode();
        if (nameNode.getKind() !== SyntaxKind.Identifier)
            continue; // skip destructuring
        const name = nameNode.getText();
        if (callee === "useNavigate" && RR_LIBS.includes(src))
            navigateVars.add(name);
        else if (callee === "useRouter" && NEXT_ROUTER_LIBS.includes(src))
            routerVars.add(name);
        else if (callee === "useHistory" && RR_LIBS.includes(src))
            historyVars.add(name);
    }
    return { navigateVars, routerVars, historyVars };
}
function getJsxAttrValueNode(attr) {
    const init = attr.getInitializer?.();
    if (!init)
        return null;
    const k = init.getKind();
    if (k === SyntaxKind.StringLiteral)
        return init;
    if (k === SyntaxKind.JsxExpression)
        return init.getExpression();
    return null;
}
function extractNavCallsFromFile(sourceFile, project) {
    const results = [];
    const importMap = buildImportSourceMap(sourceFile);
    const { navigateVars, routerVars, historyVars } = buildNavBindingMaps(sourceFile, importMap);
    // ── Call expressions ─────────────────────────────────────────────────
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        const args = call.getArguments();
        // navigate('/x') / navigate(`/x/${id}`) / navigate({ to: '/x' })
        if (expr.getKind() === SyntaxKind.Identifier) {
            const name = expr.getText();
            if (!navigateVars.has(name) || args.length === 0)
                continue;
            const arg0 = args[0];
            let urlResult = null;
            if (arg0.getKind() === SyntaxKind.ObjectLiteralExpression) {
                const toInit = arg0.getProperty("to")?.getInitializer?.();
                urlResult = toInit ? extractUrlFromArg(toInit, sourceFile, project) : null;
            }
            else {
                urlResult = extractUrlFromArg(arg0, sourceFile, project);
            }
            if (!urlResult)
                continue;
            results.push({ startLine: call.getStartLineNumber(), callerType: "navigate",
                rawUrl: urlResult.rawUrl, resolvedUrl: urlResult.resolvedUrl, method: "navigate" });
            continue;
        }
        // member calls
        if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
            const member = expr;
            const propName = member.getName();
            const objText = member.getExpression().getText();
            const objLeaf = objText.split(".").pop();
            // window.location.replace/assign('/x') — native, always eligible
            if ((propName === "replace" || propName === "assign") && objText.endsWith("location")) {
                if (args.length === 0)
                    continue;
                const urlResult = extractUrlFromArg(args[0], sourceFile, project);
                if (!urlResult)
                    continue;
                results.push({ startLine: call.getStartLineNumber(), callerType: `location.${propName}`,
                    rawUrl: urlResult.rawUrl, resolvedUrl: urlResult.resolvedUrl, method: "location" });
                continue;
            }
            // window.history.pushState/replaceState(state, title, '/x') — native, url is arg[2]
            if ((propName === "pushState" || propName === "replaceState") && objText.endsWith("history")) {
                if (args.length < 3)
                    continue;
                const urlResult = extractUrlFromArg(args[2], sourceFile, project);
                if (!urlResult)
                    continue;
                results.push({ startLine: call.getStartLineNumber(), callerType: `history.${propName}`,
                    rawUrl: urlResult.rawUrl, resolvedUrl: urlResult.resolvedUrl, method: "history" });
                continue;
            }
            // router.push/replace (Next) / history.push/replace (RR v5) — gated by binding maps
            if (propName === "push" || propName === "replace") {
                const eligible = routerVars.has(objText) || historyVars.has(objText) ||
                    routerVars.has(objLeaf) || historyVars.has(objLeaf);
                if (!eligible || args.length === 0)
                    continue;
                const arg0 = args[0];
                let urlResult = null;
                if (arg0.getKind() === SyntaxKind.ObjectLiteralExpression) {
                    const pInit = arg0.getProperty("pathname")?.getInitializer?.();
                    urlResult = pInit ? extractUrlFromArg(pInit, sourceFile, project) : null;
                }
                else {
                    urlResult = extractUrlFromArg(arg0, sourceFile, project);
                }
                if (!urlResult)
                    continue;
                results.push({ startLine: call.getStartLineNumber(), callerType: `router.${propName}`,
                    rawUrl: urlResult.rawUrl, resolvedUrl: urlResult.resolvedUrl, method: propName });
                continue;
            }
        }
    }
    // ── window.location.href = '/x' / location.href = '/x' ───────────────
    for (const bin of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken)
            continue;
        const left = bin.getLeft();
        if (left.getKind() !== SyntaxKind.PropertyAccessExpression)
            continue;
        const member = left;
        if (member.getName() !== "href")
            continue;
        if (!member.getExpression().getText().endsWith("location"))
            continue;
        const urlResult = extractUrlFromArg(bin.getRight(), sourceFile, project);
        if (!urlResult)
            continue;
        results.push({ startLine: bin.getStartLineNumber(), callerType: "location.href",
            rawUrl: urlResult.rawUrl, resolvedUrl: urlResult.resolvedUrl, method: "location" });
    }
    // ── <Link to> / <NavLink to> (RR/wouter) and <Link href> (next/link) ──
    for (const el of [
        ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ]) {
        const tag = el.getTagNameNode().getText();
        if (tag !== "Link" && tag !== "NavLink")
            continue;
        const importSrc = importMap.get(tag);
        if (!importSrc)
            continue; // gate: must be an imported Link
        const toAttr = el.getAttribute("to");
        const hrefAttr = el.getAttribute("href");
        let attr = null;
        if (toAttr && RR_LIBS.includes(importSrc))
            attr = toAttr;
        else if (hrefAttr && NEXT_LINK_LIBS.includes(importSrc))
            attr = hrefAttr;
        if (!attr)
            continue;
        const valueNode = getJsxAttrValueNode(attr);
        if (!valueNode)
            continue;
        const urlResult = extractUrlFromArg(valueNode, sourceFile, project);
        if (!urlResult)
            continue;
        results.push({ startLine: el.getStartLineNumber(), callerType: `<${tag}>`,
            rawUrl: urlResult.rawUrl, resolvedUrl: urlResult.resolvedUrl, method: "link" });
    }
    return results;
}
function makeGhostRoute(id, target, flags) {
    return {
        id,
        name: target,
        type: "ROUTE",
        filePath: "[route]",
        startLine: 0,
        endLine: 0,
        metadata: {
            urlPath: target,
            routeKind: "react-router",
            isDynamic: /[:*]/.test(target),
            framework: "unknown",
            ...flags,
        },
    };
}
export function detectNavigationEdges(nodes, repoPath) {
    const edges = [];
    const dedupSet = new Set();
    const ghostMap = new Map();
    const index = buildNavRouteIndex(nodes);
    const existingIds = new Set(nodes.map(n => n.id));
    const project = new Project({
        compilerOptions: { allowJs: true, checkJs: false, jsx: 4, strict: false },
        skipAddingFilesFromTsConfig: true,
    });
    const candidateNodes = nodes.filter(n => n.type !== "ROUTE" && n.type !== "THIRD_PARTY" &&
        typeof n.rawCode === "string" && n.rawCode.length > 0);
    const nodesByFile = new Map();
    for (const node of candidateNodes) {
        const abs = path.resolve(repoPath, node.filePath);
        if (!nodesByFile.has(abs))
            nodesByFile.set(abs, []);
        nodesByFile.get(abs).push(node);
    }
    for (const [abs, fileNodes] of nodesByFile) {
        let sourceFile = project.getSourceFile(abs);
        if (!sourceFile) {
            try {
                sourceFile = project.addSourceFileAtPath(abs);
            }
            catch {
                continue;
            }
        }
        const located = extractNavCallsFromFile(sourceFile, project);
        if (located.length === 0)
            continue;
        for (const loc of located) {
            // Attribute to the innermost node whose line range contains the call.
            let owner = null;
            for (const node of fileNodes) {
                if (loc.startLine < node.startLine || loc.startLine > node.endLine)
                    continue;
                if (owner === null || (node.endLine - node.startLine) < (owner.endLine - owner.startLine)) {
                    owner = node;
                }
            }
            if (owner === null)
                continue;
            const rawTarget = loc.resolvedUrl;
            let toId;
            let matchType;
            if (rawTarget.startsWith("http://") || rawTarget.startsWith("https://")) {
                toId = `[route]::${rawTarget}`;
                matchType = "external";
                if (!existingIds.has(toId) && !ghostMap.has(toId)) {
                    ghostMap.set(toId, makeGhostRoute(toId, rawTarget, { isExternal: true }));
                }
            }
            else {
                const normalized = normalizeUrl(rawTarget);
                if (!normalized)
                    continue; // relative / unparseable → can't reason, skip
                const match = matchNavRoute(normalized, index);
                if (match) {
                    toId = match.routeNode.id;
                    matchType = match.isDynamic ? "dynamic" : "exact";
                }
                else {
                    toId = `[route]::${normalized}`;
                    matchType = "unresolved";
                    if (!existingIds.has(toId) && !ghostMap.has(toId)) {
                        ghostMap.set(toId, makeGhostRoute(toId, normalized, { isUnresolved: true }));
                    }
                }
            }
            const dedupKey = `${owner.id}→${toId}:${loc.method}`;
            if (dedupSet.has(dedupKey))
                continue;
            dedupSet.add(dedupKey);
            edges.push({
                from: owner.id,
                to: toId,
                type: "NAVIGATES_TO",
                metadata: {
                    path: rawTarget,
                    rawPath: loc.rawUrl,
                    method: loc.method,
                    callerType: loc.callerType,
                    matchType,
                },
            });
        }
    }
    return { edges, ghostNodes: [...ghostMap.values()] };
}

import { Project, SyntaxKind } from "ts-morph";
import path from "path";
import fs from "fs";
const HTTP_METHODS = [
    "get", "post", "put", "delete",
    "patch", "options", "head",
];
const APP_INSTANCE_NAMES = [
    "app", "router", "fastify",
    "server", "api", "koa", "hono", "elysia",
];
const IGNORE_DIRS = [
    "node_modules", "dist", "build",
    ".next", "coverage", ".git",
];
const METHOD_PROP_NAMES = ["method", "verb"];
const PATH_PROP_NAMES = ["pattern", "path", "url", "pathname", "route"];
const HANDLER_PROP_NAMES = ["handler", "handlerFunc", "handlerFn", "action", "callback", "middleware"];
function extractParams(urlPath) {
    const matches = urlPath.match(/:([a-zA-Z0-9_]+)/g) || [];
    return matches.map((m) => m.replace(":", ""));
}
function normalizeMethod(method) {
    return method.toUpperCase();
}
// ─── Route-table (object-literal) recognizer ─────────────────────────────────
//
// Detects routes declared as an array of object literals, e.g.:
//
//   const ROUTES: Route[] = [
//     { method: "GET",  pattern: "/api/health",   handler: () => Response.json(...) },
//     { method: "GET",  pattern: "/api/pre-scan", handler: (_p, req) => handlePreScan(req) },
//     { method: "POST", pattern: "/users/:id",   handler: createUser },
//   ];
//
// This is framework-agnostic — it covers hand-rolled routers used by bare
// Bun.serve apps, plain Node http servers, and any project that doesn't use a
// router library. The `method`-property requirement is the discriminator that
// prevents confusing this with React Router config arrays (path + element) or
// arbitrary config arrays.
//
// Handler resolution mirrors the imperative recognizer:
//   • handler is an Identifier                  → handlerName (resolved later by routeEdge.ts)
//   • handler is an arrow/function body whose
//     first bare-name call is a local function  → handlerName (the delegated handler)
//                                                 e.g. (_p, req) => handlePreScan(req) → "handlePreScan"
//   • otherwise (self-contained inline)         → inlineHandler (synthetic node created
//                                                 by routesToCodeNodes in pipeline)
// Set form for O(1) HTTP-verb checks on the `method` property value.
const HTTP_METHODS_SET = new Set(HTTP_METHODS);
// Reads the first matching string-literal property from an object literal.
// Tries each alias in `propNames` and returns the literal text of the first hit.
function readStringProperty(obj, propNames) {
    for (const name of propNames) {
        const prop = obj.getProperty(name);
        if (prop && prop.getInitializer) {
            const v = literalStringValue(prop.getInitializer());
            if (v !== null)
                return v;
        }
    }
    return null;
}
// True if `obj` is a route-table element — has BOTH a literal `method` that is
// an HTTP verb AND a literal path-like property starting with "/". This strict
// gate keeps the recognizer from misfiring on config objects.
function hasRouteTableShape(obj) {
    const methodRaw = readStringProperty(obj, METHOD_PROP_NAMES);
    if (methodRaw === null)
        return false;
    if (!HTTP_METHODS_SET.has(methodRaw.toLowerCase()))
        return false;
    const pathRaw = readStringProperty(obj, PATH_PROP_NAMES);
    if (pathRaw === null || !pathRaw.startsWith("/"))
        return false;
    return true;
}
// From an arrow/function-literal handler, return the name it delegates to
// (first CallExpression with a bare-Identifier callee), else keep it inline.
// Skips PropertyAccessExpression callees like Response.json / req.json so we
// don't grab noise as the handler name.
function resolveHandlerLiteral(init) {
    if (!init)
        return {};
    const k = init.getKind();
    // handler: createUser          → resolve by name only
    if (k === SyntaxKind.Identifier) {
        return { handlerName: init.getText() };
    }
    // handler: (_p, req) => handlePreScan(req)   → "handlePreScan"
    // handler: () => Response.json({ ... })       → inline (no delegated name)
    if (k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) {
        const calls = init.getDescendantsOfKind(SyntaxKind.CallExpression);
        for (const c of calls) {
            const callee = c.getExpression();
            if (callee.getKind() === SyntaxKind.Identifier) {
                return { handlerName: callee.getText() };
            }
        }
        // No delegation to a named handler → treat as self-contained inline handler.
        return {
            inlineHandler: {
                rawCode: init.getText(),
                startLine: init.getStartLineNumber(),
                endLine: init.getEndLineNumber(),
            },
        };
    }
    return {};
}
// Finds array literals shaped like a route table and emits one BackendRouteNode
// per qualifying element. Gated on the FIRST element having route-table shape so
// we don't iterate arbitrary object arrays.
function detectRouteTableRoutes(file, filePath, framework, out, seen) {
    for (const arr of file.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)) {
        const elements = arr.getElements();
        if (elements.length === 0)
            continue;
        // Gate — first element must be a route-shaped object literal. This skips
        // React Router children arrays, plain config arrays, etc.
        if (elements[0].getKind() !== SyntaxKind.ObjectLiteralExpression)
            continue;
        if (!hasRouteTableShape(elements[0]))
            continue;
        for (const el of elements) {
            if (el.getKind() !== SyntaxKind.ObjectLiteralExpression)
                continue;
            if (!hasRouteTableShape(el))
                continue;
            const methodRaw = readStringProperty(el, METHOD_PROP_NAMES);
            const urlPath = readStringProperty(el, PATH_PROP_NAMES);
            // Handler (optional — some entries may be middleware-only)
            let handlerName;
            let inlineHandler;
            for (const name of HANDLER_PROP_NAMES) {
                const prop = el.getProperty(name);
                if (!prop || !prop.getInitializer)
                    continue;
                const res = resolveHandlerLiteral(prop.getInitializer());
                handlerName = res.handlerName;
                inlineHandler = res.inlineHandler;
                if (handlerName || inlineHandler)
                    break;
            }
            // Dedup against the imperative + bun.serve recognizers (disjoint shapes,
            // but defensive — same route won't be emitted twice).
            const key = `${filePath}::${normalizeMethod(methodRaw)}::${urlPath}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            const params = extractParams(urlPath);
            out.push({
                type: "BACKEND_ROUTE",
                urlPath,
                filePath,
                httpMethod: normalizeMethod(methodRaw),
                handlerName,
                inlineHandler,
                framework,
                isDynamic: params.length > 0,
                params: params.length > 0 ? params : undefined,
            });
        }
    }
}
// ─── Bun.serve fetch-handler recognizer ───────────────────────────────────────
//
// For bare `Bun.serve({ fetch(req) { ... } })` apps that dispatch routes inline
// (if/switch on the URL instead of a route table or app.METHOD), extract route
// nodes from:
//   • Binary comparisons:  req.url === '/api/health'   pathname === '/users'
//   • switch (pathname) { case '/x': ...; case '/y': ... }
//
// Method cannot be reliably inferred from a path-only comparison, so emitted
// routes use httpMethod "ANY". Handler wiring is NOT attempted here — these
// routes appear as entry-point ROUTE nodes (consistent with routeEdge.ts's
// documented behavior that an unresolved route node is still a valid graph
// node, useful for "unconnected entry points" analysis). The valuable
// handler→route edges for structured routers come from detectRouteTableRoutes
// and the imperative recognizer above.
function makeAnyRoute(urlPath, filePath, framework, out, seen) {
    if (!urlPath.startsWith("/"))
        return;
    const key = `${filePath}::ANY::${urlPath}`;
    if (seen.has(key))
        return;
    seen.add(key);
    const params = extractParams(urlPath);
    out.push({
        type: "BACKEND_ROUTE",
        urlPath,
        filePath,
        httpMethod: "ANY",
        framework,
        isDynamic: params.length > 0,
        params: params.length > 0 ? params : undefined,
    });
}
// True if an expression reads something URL-ish (req.url, request.url, url,
// pathname, req.path, …). Used to validate the non-string side of a `=== '/path'`
// comparison so we don't pick up unrelated string compares like `status === "/done"`.
function isUrlReference(node) {
    if (!node)
        return false;
    const k = node.getKind();
    if (k === SyntaxKind.Identifier) {
        return ["url", "pathname", "path", "req"].includes(node.getText());
    }
    if (k === SyntaxKind.PropertyAccessExpression) {
        const text = node.getText().toLowerCase();
        return (text.endsWith(".url") ||
            text.endsWith(".pathname") ||
            text.endsWith(".path"));
    }
    return false;
}
// Extracts route nodes from a Bun.serve() call whose fetch handler dispatches
// via inline if/switch. Only fires when the config object literal has a `fetch`
// property whose body is a Block — covers both `fetch(req) { ... }` and
// `fetch: (req) => { ... }` / `fetch: async (req) => { ... }`.
function detectBunServeRoutes(file, filePath, framework, out, seen) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getExpression().getText() !== "Bun.serve")
            continue;
        const args = call.getArguments();
        if (args.length === 0)
            continue;
        const cfg = args[0];
        if (cfg.getKind() !== SyntaxKind.ObjectLiteralExpression)
            continue;
        // The `fetch` member can be:
        //   • a method shorthand:  fetch(req) { ... }   → MethodDeclaration, body IS the block
        //   • a property assignment: fetch: (req) => { ... } / fetch: async (req) => {...}
        //     → PropertyAssignment with an ArrowFunction/FunctionExpression initializer
        // Find the fetch body block across both shapes.
        const fetchProp = cfg.getProperty("fetch");
        if (!fetchProp)
            continue;
        let fetchBody = null;
        if (fetchProp.getKind() === SyntaxKind.MethodDeclaration) {
            // fetch(req) { ... } — the method itself has a body.
            fetchBody = fetchProp.getBody?.() ?? null;
        }
        else if (fetchProp.getInitializer) {
            // { fetch: <initializer> } — unwrap to the function body.
            const fetchInit = fetchProp.getInitializer();
            if (fetchInit) {
                fetchBody =
                    fetchInit.getKind() === SyntaxKind.Block
                        ? fetchInit
                        : fetchInit.getBody?.();
            }
        }
        if (!fetchBody || !fetchBody.getDescendantsOfKind)
            continue;
        // Pattern: `something === '/path'` where one side is a string literal
        // starting with "/" and the other is a url-ish reference.
        for (const bin of fetchBody.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
            const op = bin.getOperatorToken().getKind();
            if (op !== SyntaxKind.EqualsEqualsEqualsToken &&
                op !== SyntaxKind.EqualsEqualsToken)
                continue;
            const left = bin.getLeft();
            const right = bin.getRight();
            const leftLit = literalStringValue(left);
            const rightLit = literalStringValue(right);
            const lit = leftLit ?? rightLit;
            if (!lit || !lit.startsWith("/"))
                continue;
            const otherSide = leftLit !== null ? right : left;
            if (!isUrlReference(otherSide))
                continue;
            makeAnyRoute(lit, filePath, framework, out, seen);
        }
        // Pattern: switch (pathname) { case '/x': ...; case '/y': ... }
        for (const caseClause of fetchBody.getDescendantsOfKind(SyntaxKind.CaseClause)) {
            const lit = literalStringValue(caseClause.getExpression());
            if (lit && lit.startsWith("/")) {
                makeAnyRoute(lit, filePath, framework, out, seen);
            }
        }
    }
}
function includesImport(fileContent, mod) {
    return (fileContent.includes(`from '${mod}'`) ||
        fileContent.includes(`from "${mod}"`) ||
        fileContent.includes(`require('${mod}')`) ||
        fileContent.includes(`require("${mod}")`));
}
// Reads a string-literal value from a property initializer (single/double/backtick).                                                                                   
// Returns null for non-literal (computed) values. 
function literalStringValue(node) {
    if (!node)
        return null;
    const nodeKind = node.getKind();
    if (nodeKind === SyntaxKind.StringLiteral || nodeKind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        return node.getLiteralText();
    }
    return null;
}
// Detects backend framework from file import statements
function detectFileFramework(fileContent) {
    if (includesImport(fileContent, "elysia"))
        return "elysia";
    if (includesImport(fileContent, "hono"))
        return "hono";
    if (includesImport(fileContent, "express"))
        return "express";
    if (includesImport(fileContent, "fastify"))
        return "fastify";
    if (includesImport(fileContent, "koa"))
        return "koa";
    if (fileContent.includes("Bun.serve(") || includesImport(fileContent, "bun"))
        return "bun"; // Bun is a runtime, not a framework, so we check for Bun.serve() usage or bun import.
    return null;
}
function findBackendFiles(dir, files = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return files;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (IGNORE_DIRS.includes(entry.name))
                continue;
            findBackendFiles(fullPath, files);
        }
        else if (entry.isFile()) {
            if (/\.(ts|js)$/.test(entry.name)) {
                files.push(fullPath);
            }
        }
    }
    return files;
}
export function analyzeBackendRoutes(repoPath, framework) {
    const nodes = [];
    const project = new Project({
        compilerOptions: {
            allowJs: true,
            checkJs: false,
            strict: false,
        },
        skipAddingFilesFromTsConfig: true,
    });
    const files = findBackendFiles(repoPath);
    const scanFiles = framework === "bun";
    const fileFrameWorks = new Map();
    // Only add files that actually import a backend framework
    for (const filePath of files) {
        const content = fs.readFileSync(filePath, "utf-8");
        const detectedFramework = detectFileFramework(content);
        if (detectedFramework) {
            fileFrameWorks.set(filePath, detectedFramework);
            project.addSourceFileAtPath(filePath);
        }
        else if (scanFiles) {
            // No framework import, but in bun mode we still scan: route tables are framework-agnostic                                                                         
            project.addSourceFileAtPath(filePath);
        }
    }
    // Dedup across recognizers (key = filePath::METHOD::path).                             
    const seen = new Set();
    for (const file of project.getSourceFiles()) {
        const filePath = file.getFilePath();
        const content = fs.readFileSync(filePath, "utf-8");
        // Per-file framework label; fall back to the project framework for files that
        // had no framework import but were scanned in bun mode (route tables + Bun.serve
        // dispatch code often import nothing framework-specific).
        const framework = fileFrameWorks.get(filePath) ?? detectFileFramework(content) ?? "bun";
        // Route-table (object-literal) recognizer — runs on every scanned file.
        // Independent of the imperative recognizer below; the two match disjoint
        // shapes, so a single route is never emitted twice.
        detectRouteTableRoutes(file, filePath, framework, nodes, seen);
        // Bun.serve fetch-handler recognizer (inline url comparisons / switch).
        // Only fires on Bun.serve() calls; no-op on other frameworks.
        detectBunServeRoutes(file, filePath, framework, nodes, seen);
        const callExpressions = file.getDescendantsOfKind(SyntaxKind.CallExpression);
        for (const call of callExpressions) {
            try {
                const expression = call.getExpression();
                const expressionText = expression.getText();
                const parts = expressionText.split(".");
                if (parts.length < 2)
                    continue;
                const methodName = parts[parts.length - 1].toLowerCase();
                const objectName = parts[parts.length - 2].toLowerCase();
                if (!HTTP_METHODS.includes(methodName))
                    continue;
                const isKnownInstance = APP_INSTANCE_NAMES.includes(objectName);
                const looksLikeRouter = objectName.includes("router") ||
                    objectName.includes("app") ||
                    objectName.includes("server") ||
                    objectName.includes("api");
                if (!isKnownInstance && !looksLikeRouter)
                    continue;
                const args = call.getArguments();
                if (args.length === 0)
                    continue;
                const firstArgText = args[0].getText();
                // Must be a string literal
                if (!firstArgText.startsWith("'") &&
                    !firstArgText.startsWith('"') &&
                    !firstArgText.startsWith("`"))
                    continue;
                // Remove quotes correctly — handles single, double, and backtick
                const urlPath = firstArgText.replace(/^['"`]|['"`]$/g, "");
                if (!urlPath.startsWith("/"))
                    continue;
                // Extract handler name if last argument is a simple identifier
                let handlerName;
                let inlineHandler;
                if (args.length >= 2) {
                    const lastArg = args[args.length - 1];
                    const lastArgText = lastArg.getText();
                    if (!lastArgText.includes("=>") &&
                        !lastArgText.includes("function") &&
                        /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(lastArgText)) {
                        handlerName = lastArgText;
                    }
                    else if (lastArgText.includes("=>") || lastArgText.includes("function")) {
                        //extract the inline handler 
                        inlineHandler = {
                            rawCode: lastArgText,
                            startLine: lastArg.getStartLineNumber(),
                            endLine: lastArg.getEndLineNumber(),
                        };
                    }
                    ;
                }
                const params = extractParams(urlPath);
                // Dedup against the route-table + bun.serve recognizers (disjoint shapes,
                // but defensive — same route won't be emitted twice across recognizers).
                const _imperativeKey = `${filePath}::${normalizeMethod(methodName)}::${urlPath}`;
                if (seen.has(_imperativeKey))
                    continue;
                seen.add(_imperativeKey);
                nodes.push({
                    type: "BACKEND_ROUTE",
                    urlPath,
                    filePath,
                    httpMethod: normalizeMethod(methodName),
                    handlerName,
                    inlineHandler,
                    framework,
                    isDynamic: params.length > 0,
                    params: params.length > 0 ? params : undefined,
                });
            }
            catch {
                continue;
            }
        }
    }
    return nodes;
}

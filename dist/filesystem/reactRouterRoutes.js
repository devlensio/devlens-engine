// Detects React Router (v5/v6), TanStack Router, and wouter routes, which are
// defined in CODE (not on the filesystem). Mirrors backendRoutes.ts structure.
import { Project, SyntaxKind } from "ts-morph";
import path from "path";
import fs from "fs";
const IGNORE_DIRS = [
    "node_modules", "dist", "build",
    ".next", "coverage", ".git",
];
const ROUTER_FACTORY_NAMES = [
    "createBrowserRouter", "createHashRouter", "createMemoryRouter", "useRoutes",
];
function extractParams(urlPath) {
    const matches = urlPath.match(/:([a-zA-Z0-9_]+)/g) || [];
    return matches.map((m) => m.replace(":", ""));
}
// Normalizes a route path:
//   - converts React Router splat segment "*" → ":splat*" (so urlPathtoRegex
//     treats it as a catch-all, matching the Next.js ":slug*" convention)
//   - ensures a leading "/"
//   - strips trailing "/" (except root)
// Returns null for empty / pathless entries.
function normalizePath(p) {
    if (p === null || p === undefined)
        return null;
    let s = p.trim();
    if (s === "")
        return null;
    s = s.split("/").map(seg => (seg === "*" ? ":splat*" : seg)).join("/");
    if (!s.startsWith("/"))
        s = "/" + s;
    s = s.replace(/\/+$/, "");
    return s === "" ? "/" : s;
}
// Joins a parent path with a (possibly relative) child segment.
function joinPath(parent, seg) {
    if (seg.startsWith("/"))
        return seg; // absolute child
    if (parent === "" || parent === "/")
        return "/" + seg;
    return parent + "/" + seg;
}
// Reads a string literal / no-substitution template value, else null.
function literalString(node) {
    if (!node)
        return null;
    const k = node.getKind();
    if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
        return node.getLiteralText();
    }
    return null;
}
// Resolves the component name from a route's element/component value.
//   <Home/> / <Home></Home> → "Home"   (element={<Home/>}, element: <Home/>)
//   Home                     → "Home"   (component={Home}, Component: Home)
// Returns undefined for inline render functions, lazy imports, etc.
function extractComponentName(valueNode) {
    if (!valueNode)
        return undefined;
    const k = valueNode.getKind();
    if (k === SyntaxKind.JsxSelfClosingElement)
        return valueNode.getTagNameNode().getText();
    if (k === SyntaxKind.JsxElement)
        return valueNode.getOpeningElement().getTagNameNode().getText();
    if (k === SyntaxKind.Identifier)
        return valueNode.getText();
    return undefined;
}
// Unwraps a JSX attribute initializer (element={<Home/>}) to its inner expression.
function unwrapJsxAttr(attr) {
    if (!attr || !attr.getInitializer)
        return null;
    const init = attr.getInitializer();
    if (!init)
        return null;
    return init.getKind() === SyntaxKind.JsxExpression ? init.getExpression() : init;
}
// Reads the rendered-component name from a route-config object literal's
// element / Component / component property (checked in that priority order).
function objComponentName(obj) {
    for (const propName of ["element", "Component", "component"]) {
        const prop = obj.getProperty(propName);
        if (prop && prop.getInitializer) {
            const name = extractComponentName(prop.getInitializer());
            if (name)
                return name;
        }
    }
    return undefined;
}
function pushRoute(out, rawPath, filePath, seen, rendersComponent) {
    const normalized = normalizePath(rawPath);
    if (normalized === null)
        return;
    const key = filePath + "::" + normalized;
    if (seen.has(key))
        return;
    seen.add(key);
    const params = extractParams(normalized);
    out.push({
        type: "REACT_ROUTER_ROUTE",
        urlPath: normalized,
        filePath,
        isDynamic: /[:*]/.test(normalized),
        isCatchAll: normalized.includes("*"),
        isGroupRoute: false,
        params: params.length > 0 ? params : undefined,
        rendersComponent,
    });
}
// Recursively walks an array literal of route-config objects
// (createBrowserRouter([...]) / useRoutes([...]) / nested children).
function walkRouteObjects(arr, parentPath, filePath, out, seen) {
    for (const el of arr.getElements()) {
        if (el.getKind() !== SyntaxKind.ObjectLiteralExpression)
            continue;
        const pathProp = el.getProperty("path");
        const indexProp = el.getProperty("index");
        let seg = null;
        if (pathProp && pathProp.getInitializer) {
            seg = literalString(pathProp.getInitializer());
        }
        const fullPath = seg !== null ? joinPath(parentPath, seg) : parentPath;
        const rendersComponent = objComponentName(el);
        // A real route node when it has a literal path, or is an index route.
        if (seg !== null) {
            pushRoute(out, fullPath, filePath, seen, rendersComponent);
        }
        else if (indexProp) {
            pushRoute(out, parentPath, filePath, seen, rendersComponent);
        }
        // Recurse into children with fullPath as the new parent.
        const childrenProp = el.getProperty("children");
        const childInit = childrenProp && childrenProp.getInitializer ? childrenProp.getInitializer() : null;
        if (childInit && childInit.getKind() === SyntaxKind.ArrayLiteralExpression) {
            walkRouteObjects(childInit, fullPath, filePath, out, seen);
        }
    }
}
function findReactFiles(dir, files = []) {
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
            findReactFiles(fullPath, files);
        }
        else if (entry.isFile()) {
            if (/\.(tsx|jsx|ts|js)$/.test(entry.name))
                files.push(fullPath);
        }
    }
    return files;
}
export function analyzeReactRouterRoutes(repoPath) {
    const nodes = [];
    const project = new Project({
        compilerOptions: { allowJs: true, checkJs: false, jsx: 4, strict: false },
        skipAddingFilesFromTsConfig: true,
    });
    for (const filePath of findReactFiles(repoPath)) {
        try {
            project.addSourceFileAtPath(filePath);
        }
        catch {
            continue;
        }
    }
    for (const file of project.getSourceFiles()) {
        const filePath = file.getFilePath();
        const seen = new Set();
        // ── Pattern A: JSX <Route path="..."> / <Route path="..." /> (v5/v6, wouter)
        for (const el of [
            ...file.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
            ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
        ]) {
            const tag = el.getTagNameNode().getText();
            if (tag !== "Route")
                continue;
            const pathAttr = el.getAttribute("path");
            if (!pathAttr || !pathAttr.getInitializer)
                continue;
            const init = pathAttr.getInitializer();
            if (!init)
                continue;
            let valueNode = init;
            if (init.getKind() === SyntaxKind.JsxExpression) {
                valueNode = init.getExpression();
            }
            const raw = literalString(valueNode);
            if (raw === null)
                continue; // computed path — skip
            // element={<Home/>} (v6) or component={Home} / Component={Home} (v5)
            const rendersComponent = extractComponentName(unwrapJsxAttr(el.getAttribute("element"))) ??
                extractComponentName(unwrapJsxAttr(el.getAttribute("component"))) ??
                extractComponentName(unwrapJsxAttr(el.getAttribute("Component")));
            pushRoute(nodes, raw, filePath, seen, rendersComponent);
        }
        // ── Patterns B & C: createBrowserRouter([...]) / useRoutes([...]) (+ nested children)
        // ── Pattern D: TanStack createRoute / createFileRoute / createRootRoute
        for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const callee = call.getExpression().getText();
            const calleeLeaf = callee.split(".").pop();
            const args = call.getArguments();
            if (ROUTER_FACTORY_NAMES.includes(calleeLeaf)) {
                if (args.length === 0)
                    continue;
                if (args[0].getKind() === SyntaxKind.ArrayLiteralExpression) {
                    walkRouteObjects(args[0], "", filePath, nodes, seen);
                }
                continue;
            }
            if (calleeLeaf === "createFileRoute") {
                // createFileRoute('/dashboard')(...) — path is the string arg
                if (args.length > 0)
                    pushRoute(nodes, literalString(args[0]), filePath, seen);
                continue;
            }
            if (calleeLeaf === "createRoute") {
                // createRoute({ path: '/x', component: X })
                if (args.length > 0 && args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
                    const pathProp = args[0].getProperty("path");
                    if (pathProp && pathProp.getInitializer) {
                        pushRoute(nodes, literalString(pathProp.getInitializer()), filePath, seen, objComponentName(args[0]));
                    }
                }
                continue;
            }
            if (calleeLeaf === "createRootRoute") {
                pushRoute(nodes, "/", filePath, seen);
                continue;
            }
        }
    }
    return nodes;
}

import { SyntaxKind } from "ts-morph";
import { returnsJSX } from "./components.js";
import { detectFunctionDirective } from "../directives.js";
import { extractParams, extractReturnTypeAnnotation, extractBareTypeNames, extractReferencedInterfaces, } from "../typeUtils.js";
// these are used to detect the routes in the Nextjs
const HTTP_METHOD_EXPORTS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
export const JS_BUILTINS = new Set([
    "console", "Math", "JSON", "Object", "Date",
    "Promise", "Error", "Array", "String", "Number", "Boolean", "document",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "parseInt", "parseFloat", "isNaN", "isFinite",
    "Reflect", "Proxy", "Intl", "BigInt", "Symbol", "Map", "Set",
    "WeakMap", "WeakSet", "ArrayBuffer", "DataView",
]);
function makeId(filePath, name) {
    return `${filePath}::${name}`;
}
// Cheap arg-type inference without the type checker: literal/object/array/
// function/new expressions map to coarse type tags; identifiers and property
// accesses stay undefined (resolving those needs the checker, too slow for
// whole-repo analysis).
function inferArgType(arg) {
    const kind = arg.getKind?.();
    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.TemplateExpression)
        return "string";
    if (kind === SyntaxKind.NumericLiteral)
        return "number";
    if (kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword)
        return "boolean";
    if (kind === SyntaxKind.ObjectLiteralExpression)
        return "object";
    if (kind === SyntaxKind.ArrayLiteralExpression)
        return "array";
    if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression)
        return "function";
    if (kind === SyntaxKind.NewExpression) {
        const ident = arg.getExpression?.();
        return typeof ident?.getName === "function" ? ident.getName() : undefined;
    }
    return undefined;
}
// Arg-shape tags for the API-call families, used by the single-walk
// classifier below.
const API_HOOK_FAMILIES = new Set(["useQuery", "useMutation", "useInfiniteQuery", "useSuspenseQuery", "useSWR", "useSWRMutation"]);
const AXIOS_METHODS = new Set(["axios.get", "axios.post", "axios.put", "axios.delete", "axios.patch", "axios"]);
// SINGLE traversal over all call expressions producing every call-derived
// output at once: structured call sites + legacy bare names, custom hook
// calls, and API-call strings. The per-aspect extractors used to walk the
// same descendants tree four times per function-like; whole-repo cost is now
// one walk.
export function extractCallsWithSites(node) {
    const callExprs = node.getDescendantsOfKind(SyntaxKind.CallExpression);
    const sites = [];
    const seenSites = new Set();
    const hookCalls = [];
    const apiCalls = [];
    const dependencyNames = [];
    const contextRefs = [];
    for (const call of callExprs) {
        const name = call.getExpression().getText();
        // use* family: custom hooks (^use[A-Z]) plus ALL use* names (incl.
        // built-ins like useState) for hook dependency tracking
        if (name.startsWith("use")) {
            if (/^use[A-Z]/.test(name) && !hookCalls.includes(name))
                hookCalls.push(name);
            if (!dependencyNames.includes(name))
                dependencyNames.push(name);
            if (name === "useContext") {
                const ctxArg = call.getArguments()[0];
                if (ctxArg && !contextRefs.includes(ctxArg.getText()))
                    contextRefs.push(ctxArg.getText());
            }
        }
        // API-call families: fetch / axios.* / React Query / SWR
        if (name === "fetch" || AXIOS_METHODS.has(name) || API_HOOK_FAMILIES.has(name)) {
            const args = call.getArguments();
            if (args.length > 0)
                apiCalls.push(`${name}(${args[0].getText()})`);
        }
        // Plain calls/sites skip hooks and builtin noise
        if (name.startsWith("use"))
            continue;
        const rootName = name.split(".")[0];
        if (JS_BUILTINS.has(rootName))
            continue;
        const args = call.getArguments();
        let hasSpread = false;
        const argTypes = [];
        for (const arg of args) {
            if (arg.getKind?.() === SyntaxKind.SpreadElement) {
                hasSpread = true;
                argTypes.push("unknown");
            }
            else {
                argTypes.push(inferArgType(arg) ?? "unknown");
            }
        }
        // One record per (name, arity, argTypes) triple — two calls to the same
        // name with different arg counts OR arg type shapes are both overload
        // signals (same arity + different literal types can hit different
        // overloads, and each deserves its own edge).
        const key = `${name}/${args.length}/${argTypes.join(",")}`;
        if (seenSites.has(key))
            continue;
        seenSites.add(key);
        sites.push({ name, argCount: args.length, argTypes, ...(hasSpread && { hasSpread: true }) });
    }
    return {
        calls: [...new Set(sites.map((cs) => cs.name))],
        callSites: sites,
        hookCalls,
        apiCalls,
        dependencyNames,
        contextRefs,
    };
}
export function extractFunctionCalls(node) {
    return extractCallsWithSites(node).calls;
}
export function hasErrorHandling(node) {
    const tryCatch = node.getDescendantsOfKind(SyntaxKind.TryStatement);
    return tryCatch.length > 0;
}
export function extractThrowStatements(node) {
    const throws = node.getDescendantsOfKind(SyntaxKind.ThrowStatement);
    return throws.length > 0;
}
export function extractFunctions(file, fileDirective = null) {
    const nodes = [];
    const filePath = file.getFilePath();
    // ─── Function Declarations ─────────────────────────────────────────────────
    for (const fn of file.getFunctions()) {
        const name = fn.getName();
        if (!name)
            continue;
        // Skip React components (uppercase and must return JSX) — handled by components extractor.
        // Exception: HTTP method exports (GET, POST, etc.) are uppercase but are
        // route handlers, not components. Captured in the dedicated section below.
        if (/^[A-Z]/.test(name) && !HTTP_METHOD_EXPORTS.has(name) && returnsJSX(fn))
            continue;
        // Skip hooks - handled by hooks extractor
        if (/^use[A-Z]/.test(name))
            continue;
        const typedParams = extractParams(fn);
        const { calls, callSites, hookCalls, apiCalls } = extractCallsWithSites(fn);
        const isAsync = fn.isAsync();
        const hasErrors = hasErrorHandling(fn);
        const throws = extractThrowStatements(fn);
        const renderingBoundary = detectFunctionDirective(fn.getBody()) ?? fileDirective;
        const returnType = extractReturnTypeAnnotation(fn);
        const bareTypeNames = extractBareTypeNames([...typedParams.map((p) => p.type), returnType]);
        const referencedTypes = extractReferencedInterfaces(file, bareTypeNames);
        // Overload signatures have no body — flagged so the disambiguator can
        // collapse them into the implementation when signatures match.
        const isOverloadSignature = !fn.getBody();
        nodes.push({
            id: makeId(filePath, name),
            name,
            type: "FUNCTION",
            filePath,
            startLine: fn.getStartLineNumber(),
            endLine: fn.getEndLineNumber(),
            rawCode: fn.getText(),
            metadata: {
                params: typedParams.map((p) => p.name),
                parameters: typedParams,
                returnType,
                referencedTypes,
                calls,
                callSites,
                ...(isOverloadSignature && { isOverloadSignature: true }),
                hookCalls,
                apiCalls,
                isAsync,
                hasErrorHandling: hasErrors,
                throws,
                lineCount: fn.getEndLineNumber() - fn.getStartLineNumber(),
                isHttpHandler: HTTP_METHOD_EXPORTS.has(name),
                httpMethod: HTTP_METHOD_EXPORTS.has(name) ? name : undefined,
                ...(renderingBoundary !== null && { renderingBoundary }),
            },
        });
        // Overload signature declarations — ts-morph's getFunctions() returns only
        // the implementation; signatures hang off getOverloads(). Each becomes its
        // own FUNCTION node (no body) so the disambiguator can give it a
        // signature-derived id or collapse it into an identical implementation.
        for (const overload of fn.getOverloads() ?? []) {
            const ovParams = extractParams(overload);
            const ovReturnType = extractReturnTypeAnnotation(overload);
            nodes.push({
                id: makeId(filePath, name),
                name,
                type: "FUNCTION",
                filePath,
                startLine: overload.getStartLineNumber(),
                endLine: overload.getEndLineNumber(),
                rawCode: overload.getText(),
                metadata: {
                    params: ovParams.map((p) => p.name),
                    parameters: ovParams,
                    returnType: ovReturnType,
                    referencedTypes: [],
                    calls: [],
                    callSites: [],
                    hookCalls: [],
                    apiCalls: [],
                    isAsync: false,
                    hasErrorHandling: false,
                    throws: false,
                    lineCount: overload.getEndLineNumber() - overload.getStartLineNumber(),
                    isHttpHandler: HTTP_METHOD_EXPORTS.has(name),
                    httpMethod: HTTP_METHOD_EXPORTS.has(name) ? name : undefined,
                    isOverloadSignature: true,
                },
            });
        }
    }
    // ─── Arrow Function Declarations ───────────────────────────────────────────
    for (const variable of file.getVariableDeclarations()) {
        const name = variable.getName();
        // Skip React components and not nextJs HTTP routes
        if (/^[A-Z]/.test(name) && !HTTP_METHOD_EXPORTS.has(name))
            continue;
        // Skip hooks
        if (/^use[A-Z]/.test(name))
            continue;
        const initializer = variable.getInitializer();
        if (!initializer)
            continue;
        const isArrow = initializer.getKind() === SyntaxKind.ArrowFunction;
        if (!isArrow)
            continue;
        const typedParams = extractParams(initializer);
        const { calls, callSites, hookCalls, apiCalls } = extractCallsWithSites(initializer);
        const isAsync = initializer.getText().startsWith("async");
        const hasErrors = hasErrorHandling(initializer);
        const throws = extractThrowStatements(initializer);
        const renderingBoundary = detectFunctionDirective(initializer.getBody?.()) ?? fileDirective;
        const returnType = extractReturnTypeAnnotation(initializer);
        const bareTypeNames = extractBareTypeNames([...typedParams.map((p) => p.type), returnType]);
        const referencedTypes = extractReferencedInterfaces(file, bareTypeNames);
        nodes.push({
            id: makeId(filePath, name),
            name,
            type: "FUNCTION",
            filePath,
            startLine: variable.getStartLineNumber(),
            endLine: variable.getEndLineNumber(),
            rawCode: variable.getText(),
            metadata: {
                params: typedParams.map((p) => p.name),
                parameters: typedParams,
                returnType,
                referencedTypes,
                calls,
                callSites,
                hookCalls,
                apiCalls,
                isAsync,
                hasErrorHandling: hasErrors,
                throws,
                lineCount: variable.getEndLineNumber() - variable.getStartLineNumber(),
                isHttpHandler: HTTP_METHOD_EXPORTS.has(name),
                httpMethod: HTTP_METHOD_EXPORTS.has(name) ? name : undefined,
                ...(renderingBoundary !== null && { renderingBoundary }),
            },
        });
    }
    // ─── HTTP Method Exports (re-exported via export { GET } pattern) ──────────
    //
    // Handles the case where a route.ts re-exports a handler defined elsewhere:
    //   import { myHandler } from "./handlers.js";
    //   export { myHandler as GET };
    //
    // In this case getFunctions() and getVariableDeclarations() won't find GET.
    // We detect export specifiers that alias to an HTTP method name.
    for (const exportDecl of file.getExportDeclarations()) {
        for (const specifier of exportDecl.getNamedExports()) {
            const exportedName = specifier.getAliasNode()?.getText()
                ?? specifier.getName();
            if (!HTTP_METHOD_EXPORTS.has(exportedName))
                continue;
            // The local name is what was imported — use it to find the original node
            const localName = specifier.getName();
            // Check if we already captured it above (direct export)
            const alreadyCaptured = nodes.some(n => n.name === exportedName);
            if (alreadyCaptured)
                continue;
            // We can't get line numbers reliably for re-exports, so use the
            // export declaration's position as a proxy
            nodes.push({
                id: makeId(filePath, exportedName),
                name: exportedName,
                type: "FUNCTION",
                filePath,
                startLine: exportDecl.getStartLineNumber(),
                endLine: exportDecl.getEndLineNumber(),
                rawCode: exportDecl.getText(),
                metadata: {
                    params: [],
                    calls: [],
                    callSites: [],
                    apiCalls: [],
                    isAsync: false,
                    hasErrorHandling: false,
                    throws: false,
                    lineCount: 1,
                    isHttpHandler: true,
                    httpMethod: exportedName,
                    // Record that this is a re-export so routeEdges can follow
                    // the chain to the actual implementation if needed
                    isReExport: true,
                    reExportedFrom: localName,
                },
            });
        }
    }
    return nodes;
}

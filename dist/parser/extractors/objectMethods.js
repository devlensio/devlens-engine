import { SyntaxKind } from "ts-morph";
import { detectFunctionDirective } from "../directives.js";
import { extractFunctionCalls, extractHookCalls, extractApiCalls, hasErrorHandling, extractThrowStatements, } from "./functions.js";
import { extractParams, extractReturnTypeAnnotation, extractBareTypeNames, extractReferencedInterfaces, } from "../typeUtils.js";
// Extracts function-valued properties of object literals as FUNCTION nodes.
//
// Many React/Next.js modules keep their logic inside an exported object literal
// (provider adapters, route tables, command maps, strategy/config objects). The
// other extractors (declarations, var-assigned arrows, components, hooks) never
// descend into object literals, so those functions had no node to anchor edges
// to — every CALLS / NEXTJS_API_CALL / READS_FROM edge silently dropped.
//
// The node `name` encodes the dotted access path (e.g.
// "providersConfig.zoro.streamingData"). index.ts builds the id as
// `${relativePath}::${name}`, so this yields the desired node identity for free.
function makeId(filePath, name) {
    return `${filePath}::${name}`;
}
// Unwraps `as const` / `as Foo` and parenthesized expressions, returning the
// underlying ObjectLiteralExpression node, or null if it isn't one.
function asObjectLiteral(node) {
    let n = node;
    while (n &&
        (n.getKind() === SyntaxKind.AsExpression ||
            n.getKind() === SyntaxKind.ParenthesizedExpression)) {
        n = n.getExpression?.();
    }
    return n && n.getKind() === SyntaxKind.ObjectLiteralExpression ? n : null;
}
// True for `async (...) => {}`, `async function () {}`, `async key() {}`.
function isAsyncFn(fnNode) {
    if (typeof fnNode.isAsync === "function")
        return fnNode.isAsync();
    return fnNode.getText().trimStart().startsWith("async");
}
// Builds a FUNCTION node from a function-like node + the span node that should
// own its line range / rawCode. The metadata shape mirrors functions.ts exactly
// so callEdges / apiFetchEdges treat these like any other FUNCTION node.
//   fnNode  — ArrowFunction | FunctionExpression | MethodDeclaration (params/body)
//   spanNode— the PropertyAssignment (`key: fn`) or the MethodDeclaration itself,
//             so the inner call's line falls inside [startLine, endLine].
function buildNode(file, dottedName, fnNode, spanNode, fileDirective) {
    const filePath = file.getFilePath();
    const typedParams = extractParams(fnNode);
    const calls = extractFunctionCalls(fnNode);
    const hookCalls = extractHookCalls(fnNode);
    const apiCalls = extractApiCalls(fnNode);
    const isAsync = isAsyncFn(fnNode);
    const hasErrors = hasErrorHandling(fnNode);
    const throws = extractThrowStatements(fnNode);
    const renderingBoundary = detectFunctionDirective(fnNode.getBody?.()) ?? fileDirective;
    const returnType = extractReturnTypeAnnotation(fnNode);
    const bareTypeNames = extractBareTypeNames([...typedParams.map((p) => p.type), returnType]);
    const referencedTypes = extractReferencedInterfaces(file, bareTypeNames);
    return {
        id: makeId(filePath, dottedName),
        name: dottedName,
        type: "FUNCTION",
        filePath,
        startLine: spanNode.getStartLineNumber(),
        endLine: spanNode.getEndLineNumber(),
        rawCode: spanNode.getText(),
        metadata: {
            params: typedParams.map((p) => p.name),
            parameters: typedParams,
            returnType,
            referencedTypes,
            calls,
            hookCalls,
            apiCalls,
            isAsync,
            hasErrorHandling: hasErrors,
            throws,
            lineCount: spanNode.getEndLineNumber() - spanNode.getStartLineNumber(),
            isHttpHandler: false,
            httpMethod: undefined,
            ...(renderingBoundary !== null && { renderingBoundary }),
        },
    };
}
// Recursively walks an object literal, emitting a node per function-valued
// property and descending into nested object literals to arbitrary depth.
function walkObject(file, objLiteral, prefix, fileDirective, out) {
    // getProperties() returns a union (PropertyAssignment | ShorthandPropertyAssignment
    // | SpreadAssignment | MethodDeclaration | Get/SetAccessor) — guard every getter.
    for (const prop of objLiteral.getProperties()) {
        const kind = prop.getKind();
        // Shorthand method:  streamingData(args) { ... }  (incl. async)
        if (kind === SyntaxKind.MethodDeclaration) {
            const name = prop.getName?.();
            if (!name)
                continue;
            out.push(buildNode(file, `${prefix}.${name}`, prop, prop, fileDirective));
            continue;
        }
        // Everything else we handle needs a name + initializer.
        if (kind !== SyntaxKind.PropertyAssignment)
            continue; // skip spread/shorthand/get/set
        const name = prop.getName?.();
        const init = prop.getInitializer?.();
        if (!name || !init)
            continue;
        const ik = init.getKind();
        if (ik === SyntaxKind.ArrowFunction || ik === SyntaxKind.FunctionExpression) {
            // span = the PropertyAssignment so the range wraps `key: <fn>`.
            out.push(buildNode(file, `${prefix}.${name}`, init, prop, fileDirective));
            continue;
        }
        // Nested object → recurse (unwrap `as const` / parens).
        const nested = asObjectLiteral(init);
        if (nested) {
            walkObject(file, nested, `${prefix}.${name}`, fileDirective, out);
        }
    }
}
export function extractObjectMethods(file, fileDirective = null) {
    const out = [];
    // Roots: named object literals — `const x = { ... }` (incl. `as const`).
    for (const variable of file.getVariableDeclarations()) {
        const init = variable.getInitializer();
        if (!init)
            continue;
        const obj = asObjectLiteral(init);
        if (!obj)
            continue;
        walkObject(file, obj, variable.getName(), fileDirective, out);
    }
    // Root: `export default { ... }` — fall back to the "default" prefix.
    for (const assign of file.getExportAssignments()) {
        if (assign.isExportEquals?.())
            continue; // skip `export = ...`
        const expr = assign.getExpression?.();
        if (!expr)
            continue;
        const obj = asObjectLiteral(expr);
        if (!obj)
            continue;
        walkObject(file, obj, "default", fileDirective, out);
    }
    return out;
}

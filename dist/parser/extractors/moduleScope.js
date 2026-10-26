import { SyntaxKind } from "ts-morph";
import { classifyCall, createCallAccumulator, finishCalls, } from "./functions.js";
// ─── Module-scope call extraction ─────────────────────────────────────────────
//
// A FILE node represents the module itself. Calls executed at module scope
// (`const cleanup = startAll()`, `const app = express()`, top-level `if`
// blocks) belong to that FILE node, not to any child function. Entry files
// (main.ts, server.ts, workers.ts) do most of their work here, so without this
// pass the graph shows them importing things but never calling anything.
//
// Scope rule: a call is module scope iff its nearest function-like/class
// ancestor is absent. Everything nested in a function body, arrow initializer,
// class field, or static block belongs to that owner and is extracted by the
// regular per-declaration extractors.
const NON_MODULE_ANCESTORS = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.Constructor,
    SyntaxKind.GetAccessor,
    SyntaxKind.SetAccessor,
    SyntaxKind.ClassDeclaration,
    SyntaxKind.ClassExpression,
    SyntaxKind.ClassStaticBlockDeclaration,
]);
// Top-level statements that cannot contain module-scope calls. Skipping them
// before descending is the perf win: a 3k-line file of function declarations
// costs nothing here (correctness is still guaranteed by the ancestor guard).
const SKIP_TOP_LEVEL = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.ClassDeclaration,
    SyntaxKind.InterfaceDeclaration,
    SyntaxKind.TypeAliasDeclaration,
    SyntaxKind.EnumDeclaration,
    SyntaxKind.ModuleDeclaration,
    SyntaxKind.ImportDeclaration,
    SyntaxKind.ImportEqualsDeclaration,
    SyntaxKind.ExportDeclaration,
]);
/**
 * Collect every call executed at module scope, classified exactly like calls
 * inside a function (same builtin filtering, hook/api tracking, call sites).
 * Returns EMPTY data for files with no module-scope calls.
 */
export function extractModuleScopeCalls(file) {
    const acc = createCallAccumulator();
    for (const stmt of file.getStatements()) {
        if (SKIP_TOP_LEVEL.has(stmt.getKind()))
            continue;
        for (const call of stmt.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (isOwnedByDeclaration(call))
                continue;
            // Dynamic import() is a CallExpression whose callee is ImportKeyword —
            // not a function call; recording it as `import(...)` is pure noise.
            if (call.getExpression().getKind() === SyntaxKind.ImportKeyword)
                continue;
            // IIFE: the callee is an inline function expression, so the "name" would
            // be the whole function body text. Its body is already excluded by the
            // ancestor rule; the call itself carries no resolvable name.
            if (isIifeCallee(call.getExpression()))
                continue;
            classifyCall(call, acc);
        }
    }
    return finishCalls(acc);
}
function isOwnedByDeclaration(call) {
    return Boolean(call.getFirstAncestor((ancestor) => NON_MODULE_ANCESTORS.has(ancestor.getKind())));
}
// `(async () => { ... })()` / `(function () { ... })()` — unwrap parentheses
// and detect a function-expression callee.
function isIifeCallee(callee) {
    let expr = callee;
    while (expr.getKind() === SyntaxKind.ParenthesizedExpression) {
        expr = expr.getExpression();
    }
    return (expr.getKind() === SyntaxKind.ArrowFunction ||
        expr.getKind() === SyntaxKind.FunctionExpression);
}

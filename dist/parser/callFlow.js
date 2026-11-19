import { SyntaxKind } from "ts-morph";
// callOrder/v1. See docs/CALL_ORDER.md. Everything here is metadata only: the
// set of recorded call sites is decided by the caller's walk, never by this file.
const FUNCTION_LIKE = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.Constructor,
    SyntaxKind.GetAccessor,
    SyntaxKind.SetAccessor,
    SyntaxKind.ClassDeclaration,
    SyntaxKind.ClassExpression,
]);
const LOOP_KINDS = new Set([
    SyntaxKind.ForStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
]);
const TIMER_APIS = new Set(["setTimeout", "setInterval"]);
const MICROTASK_APIS = new Set(["queueMicrotask", "setImmediate", "nextTick"]);
const EVENT_APIS = new Set([
    "addEventListener", "on", "once", "addListener", "prependListener", "subscribe",
]);
const POST_RENDER_APIS = new Set([
    "useEffect", "useLayoutEffect", "useInsertionEffect",
]);
const PROMISE_APIS = new Set(["then", "catch", "finally"]);
const ITERATION_APIS = new Set([
    "map", "forEach", "filter", "reduce", "reduceRight", "some", "every", "find",
    "findIndex", "findLast", "flatMap", "sort", "toSorted",
]);
const EXECUTOR_APIS = new Set(["submit", "execute"]);
const PARALLEL_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
function unwrapParens(node) {
    let n = node;
    while (n && n.getKind() === SyntaxKind.ParenthesizedExpression) {
        n = n.getExpression();
    }
    return n;
}
export function isIifeCallee(callee) {
    const expr = unwrapParens(callee);
    if (!expr)
        return false;
    return (expr.getKind() === SyntaxKind.ArrowFunction ||
        expr.getKind() === SyntaxKind.FunctionExpression);
}
function calleeText(call) {
    const expression = call.getExpression?.();
    return expression ? expression.getText() : "";
}
function memberName(text) {
    const dot = text.lastIndexOf(".");
    return dot === -1 ? text : text.slice(dot + 1);
}
// Nearest enclosing call expression, ignoring any that sit beyond a function
// boundary: arguments of a callback belong to the callback, not to the call that
// received it.
function enclosingCallWithinFrame(call, boundary) {
    let child = call;
    let parent = call.getParent();
    while (parent && parent !== boundary) {
        if (FUNCTION_LIKE.has(parent.getKind()))
            return undefined;
        if (parent.getKind() === SyntaxKind.CallExpression ||
            parent.getKind() === SyntaxKind.NewExpression) {
            return parent;
        }
        child = parent;
        parent = parent.getParent();
    }
    return undefined;
}
function nearestEnclosingFunction(call, boundary) {
    let parent = call.getParent();
    while (parent && parent !== boundary) {
        if (parent.getKind() === SyntaxKind.FunctionDeclaration ||
            parent.getKind() === SyntaxKind.FunctionExpression ||
            parent.getKind() === SyntaxKind.ArrowFunction ||
            parent.getKind() === SyntaxKind.MethodDeclaration) {
            return parent;
        }
        parent = parent.getParent();
    }
    return undefined;
}
function isInsideJsxHandler(call, boundary) {
    let parent = call.getParent();
    while (parent && parent !== boundary) {
        if (parent.getKind() === SyntaxKind.JsxExpression) {
            const attribute = parent.getParent();
            if (attribute && attribute.getKind() === SyntaxKind.JsxAttribute) {
                const holder = attribute.getParent();
                if (holder &&
                    (holder.getKind() === SyntaxKind.JsxOpeningElement ||
                        holder.getKind() === SyntaxKind.JsxSelfClosingElement)) {
                    return true;
                }
            }
        }
        parent = parent.getParent();
    }
    return false;
}
function computeScope(call, owner, isFileOwner) {
    if (isFileOwner)
        return "module";
    if (isInsideJsxHandler(call, owner))
        return "handler";
    const fn = nearestEnclosingFunction(call, owner);
    if (!fn)
        return "inline";
    if (fn.getKind() === SyntaxKind.FunctionDeclaration)
        return "nested";
    const parent = unwrapParens(fn.getParent());
    if (!parent)
        return "callback";
    if (parent.getKind() === SyntaxKind.VariableDeclaration)
        return "nested";
    if (parent.getKind() === SyntaxKind.PropertyAssignment)
        return "nested";
    if (parent.getKind() === SyntaxKind.JsxExpression)
        return "handler";
    return "callback";
}
// The call that receives `fn` as an argument, looking through arrays so
// Promise.all([...]) members are found too.
function callReceiving(fn) {
    let node = unwrapParens(fn.getParent());
    while (node) {
        if (node.getKind() === SyntaxKind.CallExpression ||
            node.getKind() === SyntaxKind.NewExpression) {
            return node;
        }
        if (node.getKind() === SyntaxKind.ArrayLiteralExpression ||
            node.getKind() === SyntaxKind.ParenthesizedExpression ||
            node.getKind() === SyntaxKind.SpreadElement) {
            node = unwrapParens(node.getParent());
            continue;
        }
        return undefined;
    }
    return undefined;
}
function computeDefer(call, owner) {
    const result = {};
    const fn = nearestEnclosingFunction(call, owner);
    if (fn) {
        const receiver = callReceiving(fn);
        if (receiver) {
            const text = calleeText(receiver);
            const member = memberName(text);
            const root = text.split(".")[0];
            if (TIMER_APIS.has(text) || TIMER_APIS.has(member)) {
                result.defer = "timer";
                result.deferDetail = text;
            }
            else if (MICROTASK_APIS.has(text) || MICROTASK_APIS.has(member)) {
                result.defer = "microtask";
                result.deferDetail = text;
            }
            else if (POST_RENDER_APIS.has(text)) {
                result.defer = "postRender";
                result.deferDetail = text;
            }
            else if (PROMISE_APIS.has(member) || text === "new Promise") {
                result.defer = "promise";
                result.deferDetail = text;
            }
            else if (EVENT_APIS.has(member) && root !== "Promise") {
                result.defer = "event";
                result.deferDetail = text;
            }
            else if (ITERATION_APIS.has(member)) {
                result.repeat = true;
                result.deferDetail = text;
            }
            else if (EXECUTOR_APIS.has(member)) {
                result.conc = true;
                result.deferDetail = text;
            }
            else if (root === "Promise" && PARALLEL_COMBINATORS.has(member)) {
                result.conc = true;
                result.deferDetail = text;
            }
            // An unrecognised callback argument is NOT a detachment claim. Most helpers that
            // take a callback call it synchronously (runText, withRetry, map-like wrappers),
            // so the honest record is scope "callback" with no defer. The "unknown" value is
            // reserved for a position known to be detached whose scheduler cannot be named.
        }
    }
    // Promise.all([a(), b()]) members run in parallel even though they are not
    // callbacks. Walk to the call that owns the array literal.
    let parent = call.getParent();
    while (parent && parent !== owner) {
        if (FUNCTION_LIKE.has(parent.getKind()))
            break;
        if (parent.getKind() === SyntaxKind.ArrayLiteralExpression &&
            parent.getParent() &&
            parent.getParent().getKind() === SyntaxKind.CallExpression) {
            const ownerCall = parent.getParent();
            const text = calleeText(ownerCall);
            if (text.startsWith("Promise.") && PARALLEL_COMBINATORS.has(memberName(text))) {
                result.conc = true;
                result.deferDetail = text;
            }
        }
        parent = parent.getParent();
    }
    return result;
}
function computeMaybeAndRepeat(call, owner) {
    const result = {};
    let child = call;
    let parent = call.getParent();
    while (parent && parent !== owner) {
        if (FUNCTION_LIKE.has(parent.getKind()))
            break;
        const kind = parent.getKind();
        if (kind === SyntaxKind.TryStatement) {
            const finallyBlock = parent.getFinallyBlock?.();
            if (finallyBlock && child === finallyBlock)
                result.defer = "onReturn";
        }
        if (kind === SyntaxKind.IfStatement) {
            const thenStatement = parent.getThenStatement?.();
            const elseStatement = parent.getElseStatement?.();
            if (child === thenStatement || child === elseStatement)
                result.maybe = true;
        }
        if (kind === SyntaxKind.ConditionalExpression) {
            const whenTrue = parent.getWhenTrue?.();
            const whenFalse = parent.getWhenFalse?.();
            if (child === whenTrue || child === whenFalse)
                result.maybe = true;
        }
        if (kind === SyntaxKind.BinaryExpression) {
            const operator = parent.getOperatorToken?.()?.getKind?.();
            const right = parent.getRight?.();
            const conditional = operator === SyntaxKind.AmpersandAmpersandToken ||
                operator === SyntaxKind.BarBarToken ||
                operator === SyntaxKind.QuestionQuestionToken;
            if (conditional && child === right)
                result.maybe = true;
        }
        if (kind === SyntaxKind.CaseClause || kind === SyntaxKind.DefaultClause || kind === SyntaxKind.CatchClause) {
            result.maybe = true;
        }
        if (LOOP_KINDS.has(kind)) {
            const body = parent.getStatement?.() ?? parent.getBody?.();
            if (body && child === body)
                result.repeat = true;
        }
        child = parent;
        parent = parent.getParent();
    }
    return result;
}
function jsxAttributeName(call, boundary) {
    let parent = call.getParent();
    while (parent && parent !== boundary) {
        if (parent.getKind() === SyntaxKind.JsxExpression) {
            const attribute = parent.getParent();
            if (attribute && attribute.getKind() === SyntaxKind.JsxAttribute) {
                return attribute.getNameNode?.()?.getText?.();
            }
        }
        parent = parent.getParent();
    }
    return undefined;
}
function isAwaited(call) {
    const parent = call.getParent();
    return Boolean(parent && parent.getKind() === SyntaxKind.AwaitExpression);
}
export function annotateCall(call, owner, isFileOwner, ordinals) {
    const annotations = {
        col: call.getStart() - call.getStartLinePos(),
        scope: computeScope(call, owner, isFileOwner),
    };
    const enclosing = enclosingCallWithinFrame(call, owner);
    if (enclosing) {
        const order = ordinals.get(enclosing);
        if (order !== undefined)
            annotations.nested = order;
    }
    if (isAwaited(call))
        annotations.awaited = true;
    Object.assign(annotations, computeDefer(call, owner));
    Object.assign(annotations, computeMaybeAndRepeat(call, owner));
    // A JSX attribute handler is triggered by the user, never by the render pass.
    if (annotations.scope === "handler" && !annotations.defer) {
        annotations.defer = "event";
        const attribute = jsxAttributeName(call, owner);
        if (attribute)
            annotations.deferDetail = `on${attribute.replace(/^on/, "")}`;
    }
    return annotations;
}

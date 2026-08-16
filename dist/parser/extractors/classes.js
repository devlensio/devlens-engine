// Extracts classes and their methods as CLASS / METHOD nodes.
//
// Previously, `class Foo {}` declarations (and React class components like
// `class Dashboard extends React.Component`) were completely invisible to the
// graph — the components extractor only sees functions, and the functions
// extractor skips anything that isn't a function declaration or arrow.
//
// Conventions:
//   - CLASS node id/name:        `Foo`            (file-scoped, like functions)
//   - METHOD node id/name:       `Foo.bar`        (dotted — matches the Go
//     extractor's `methodNodeID` and the objectMethods extractor, so
//     `nodesByName` resolves `Foo.bar(...)` calls with zero extra plumbing)
//   - `this.bar()` inside a method is rewritten to `Foo.bar(...)` at extraction
//     time ONLY when `bar` is a method of the class (property access like
//     `this.obj.bar()` is left alone). `super.x()` is never rewritten.
//
// Out of scope (deliberate): INTERFACE / ENUM / STRUCT nodes for JS/TS.
import { SyntaxKind } from "ts-morph";
import { detectFunctionDirective } from "../directives.js";
import { extractFunctionCalls, extractHookCalls, extractApiCalls, hasErrorHandling, extractThrowStatements, } from "./functions.js";
import { extractParams, extractReturnTypeAnnotation, extractBareTypeNames, extractReferencedInterfaces, } from "../typeUtils.js";
// React lifecycle methods (incl. render) — flagged so consumers can tell
// framework-registered callbacks apart from ordinary methods.
const REACT_LIFECYCLE = new Set([
    "render",
    "componentDidMount",
    "componentDidUpdate",
    "componentWillUnmount",
    "shouldComponentUpdate",
    "getDerivedStateFromProps",
    "getSnapshotBeforeUpdate",
    "componentWillMount",
    "componentWillReceiveProps",
]);
function makeId(filePath, name) {
    return `${filePath}::${name}`;
}
// `React.Component<Props, State>` → `React.Component`; `Base<T>` → `Base`.
// Used for extends-resolution (the detector only cares about the base name).
export function stripGenerics(typeText) {
    const lt = typeText.indexOf("<");
    return (lt === -1 ? typeText : typeText.slice(0, lt)).trim();
}
// True when the extends expression is a React component base
// (React.Component / React.PureComponent / Component / PureComponent).
function isReactBase(extendsType) {
    const base = stripGenerics(extendsType);
    return /^(?:React\.)?(?:Pure)?Component$/.test(base);
}
// Pulls `Props` and `State` out of `React.Component<Props, State>` /
// `Component<Props>` (top-level comma split — nested generics tolerated).
function parseComponentGenerics(extendsType) {
    const lt = extendsType.indexOf("<");
    const gt = extendsType.lastIndexOf(">");
    if (lt === -1 || gt === -1 || gt < lt)
        return {};
    const args = extendsType.slice(lt + 1, gt).split(",").map((a) => a.trim()).filter(Boolean);
    if (args.length === 0)
        return {};
    const out = { propsType: args[0] };
    if (args.length > 1)
        out.stateType = args[1];
    return out;
}
// Rewrites `this.foo(...)` call texts to `<ClassName>.foo(...)` so they match
// the dotted METHOD node names in nodesByName. Only rewrites when the first
// segment after `this.` is an actual method of the class — `this.obj.bar()`
// (property access) and `super.x()` stay untouched. A leading `#` on the
// method segment (private identifier `this.#foo()`) is stripped to match the
// node name.
function rewriteThisCalls(calls, className, methodNames) {
    return calls.map((call) => {
        if (!call.startsWith("this."))
            return call;
        const rest = call.slice("this.".length);
        const firstSegment = rest.split(".")[0].replace(/^#/, "");
        if (!methodNames.has(firstSegment))
            return call;
        return `${className}.${rest.replace(/^#/, "")}`;
    });
}
function extractDecoratorNames(cls) {
    if (typeof cls.getDecorators !== "function")
        return [];
    return cls.getDecorators().map((d) => (typeof d.getName === "function" ? d.getName() : d.getText()));
}
function isPrivateMethod(method, name) {
    if (name.startsWith("#"))
        return true;
    return method.getModifiers().some((m) => m.getKind() === SyntaxKind.PrivateKeyword);
}
// Builds a METHOD node from any function-shaped class member.
// methodNameSet — all method-ish names of the owning class, used by the
// `this.` rewrite to distinguish methods from field/property access.
function buildMethodNode(file, className, methodName, method, methodNameSet, fileDirective) {
    const filePath = file.getFilePath();
    const dotted = `${className}.${methodName}`;
    const typedParams = extractParams(method);
    const calls = extractFunctionCalls(method);
    const hookCalls = extractHookCalls(method);
    const apiCalls = extractApiCalls(method);
    const isAsync = typeof method.isAsync === "function" && method.isAsync();
    const hasErrors = hasErrorHandling(method);
    const throws = extractThrowStatements(method);
    const renderingBoundary = detectFunctionDirective(method.getBody?.()) ?? fileDirective;
    const returnType = extractReturnTypeAnnotation(method);
    const bareTypeNames = extractBareTypeNames([...typedParams.map((p) => p.type), returnType]);
    const referencedTypes = extractReferencedInterfaces(file, bareTypeNames);
    return {
        id: makeId(filePath, dotted),
        name: dotted,
        type: "METHOD",
        filePath,
        startLine: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
        rawCode: method.getText(),
        metadata: {
            className,
            params: typedParams.map((p) => p.name),
            parameters: typedParams,
            returnType,
            referencedTypes,
            calls: rewriteThisCalls(calls, className, methodNameSet),
            hookCalls,
            apiCalls,
            isAsync,
            isStatic: typeof method.isStatic === "function" ? method.isStatic() : false,
            isPrivate: isPrivateMethod(method, methodName),
            isAbstract: typeof method.isAbstract === "function" ? method.isAbstract() : false,
            isConstructor: methodName === "constructor",
            isAccessor: undefined,
            isReactLifecycle: REACT_LIFECYCLE.has(methodName),
            hasErrorHandling: hasErrors,
            throws,
            lineCount: method.getEndLineNumber() - method.getStartLineNumber(),
            ...(renderingBoundary !== null && { renderingBoundary }),
        },
    };
}
// All method-ish names of a class declaration (methods + constructor +
// accessors) — used by the `this.` rewrite to distinguish methods from fields.
function collectMethodNames(cls) {
    const names = [];
    for (const m of cls.getMethods?.() ?? []) {
        const n = m.getName?.();
        if (typeof n === "string")
            names.push(n.startsWith("#") ? n.slice(1) : n);
    }
    for (const c of cls.getConstructors?.() ?? [])
        names.push("constructor");
    for (const a of [...(cls.getGetAccessors?.() ?? []), ...(cls.getSetAccessors?.() ?? [])]) {
        const n = a.getName?.();
        if (typeof n === "string")
            names.push(n);
    }
    return names;
}
export function extractClasses(file, fileDirective = null) {
    const nodes = [];
    const filePath = file.getFilePath();
    for (const cls of file.getClasses()) {
        const name = cls.getName();
        // Anonymous default-export classes (`export default class {}`) have no
        // name to build an id from — skipped (documented).
        if (!name)
            continue;
        const extendsClause = cls.getExtends();
        const extendsType = extendsClause ? extendsClause.getText() : undefined;
        const implementsTypes = cls.getImplements().map((t) => t.getExpression().getText());
        const decorators = extractDecoratorNames(cls);
        const isReactComponent = extendsType ? isReactBase(extendsType) : false;
        const componentGenerics = isReactComponent && extendsType ? parseComponentGenerics(extendsType) : {};
        const methodNames = collectMethodNames(cls);
        const propertyNames = [...(cls.getProperties?.() ?? []), ...(cls.getStaticProperties?.() ?? [])]
            .map((p) => p.getName?.())
            .filter((n) => typeof n === "string");
        const constructors = cls.getConstructors?.() ?? [];
        const constructorParams = constructors[0]
            ? constructors[0].getParameters().map((p) => p.getName())
            : [];
        const isExported = typeof cls.isExported === "function" ? cls.isExported() : false;
        nodes.push({
            id: makeId(filePath, name),
            name,
            type: "CLASS",
            filePath,
            startLine: cls.getStartLineNumber(),
            endLine: cls.getEndLineNumber(),
            rawCode: cls.getText(),
            metadata: {
                extendsType,
                implementsTypes,
                decorators,
                isAbstract: typeof cls.isAbstract === "function" ? cls.isAbstract() : false,
                isExported,
                exportType: cls.isDefaultExport() ? "default" : isExported ? "named" : "none",
                isReactComponent,
                ...componentGenerics,
                typeParams: cls.getTypeParameters().map((tp) => tp.getName()),
                methodNames,
                propertyNames,
                constructorParams,
                lineCount: cls.getEndLineNumber() - cls.getStartLineNumber(),
            },
        });
        // ─── METHOD nodes ────────────────────────────────────────────────────
        const methodNameSet = new Set(methodNames);
        for (const m of cls.getMethods()) {
            let methodName = m.getName();
            if (typeof methodName !== "string" || methodName === "")
                continue; // computed names
            const isHashPrivate = methodName.startsWith("#");
            if (isHashPrivate)
                methodName = methodName.slice(1);
            const node = buildMethodNode(file, name, methodName, m, methodNameSet, fileDirective);
            if (isHashPrivate)
                node.metadata.isPrivate = true;
            nodes.push(node);
        }
        for (const c of cls.getConstructors()) {
            nodes.push(buildMethodNode(file, name, "constructor", c, methodNameSet, fileDirective));
        }
        for (const acc of cls.getGetAccessors()) {
            const accName = acc.getName();
            if (typeof accName !== "string")
                continue;
            const node = buildMethodNode(file, name, accName, acc, methodNameSet, fileDirective);
            node.metadata.isAccessor = "get";
            nodes.push(node);
        }
        for (const acc of cls.getSetAccessors()) {
            const accName = acc.getName();
            if (typeof accName !== "string")
                continue;
            const node = buildMethodNode(file, name, accName, acc, methodNameSet, fileDirective);
            node.metadata.isAccessor = "set";
            nodes.push(node);
        }
    }
    return nodes;
}

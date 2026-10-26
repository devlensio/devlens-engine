// Declaration → nodeId resolution (shared by the exports map and the
// import/export binding table).
//
// Node ids are `relativePath::name`, but two constructs break the naive
// concatenation:
//   1. OVERLOADS — `parser/overloads.ts` rewrites colliding ids to
//      `path::name#arity` / `path::name#arity#sig8`, so a declaration cannot be
//      mapped by name alone. The node index is keyed by the BASE id
//      (`path::name`) and holds every suffixed node; the overload with the
//      matching parameter signature wins.
//   2. ALIASING — the name a caller writes is not always the name a declaration
//      has. That is the caller's problem (see `graph/edges/callEdges.ts`); this
//      module always reports the ORIGIN declaration's id.
//
// Everything here works on ts-morph declaration nodes, so it must run while a
// Project is alive — i.e. inside `parseRepo()` (exports map) or
// `detectImportEdges()` (export bindings). Both call it through this single
// implementation so overloaded ids are generated in exactly one place.
import path from "path";
export function buildNodeIndex(nodes) {
    const index = new Map();
    for (const node of nodes) {
        const base = `${node.filePath}::${node.name}`;
        if (!index.has(base))
            index.set(base, []);
        index.get(base).push(node);
    }
    return index;
}
/** Repo-relative path of a declaration's source file, posix separators. */
export function relativePathOf(decl, repoPath) {
    return path.relative(repoPath, decl.getSourceFile().getFilePath()).replace(/\\/g, "/");
}
/**
 * Name of the declaration behind an exported name.
 * Prefers the declaration's own `getName()` (functions, classes, variables) and
 * falls back to the symbol name. Returns undefined for anonymous declarations —
 * those have no node and are therefore not linkable.
 */
export function declarationName(decl) {
    const getName = decl.getName;
    if (typeof getName === "function") {
        try {
            const own = getName.call(decl);
            if (typeof own === "string" && own.length > 0)
                return own;
        }
        catch {
            // fall through to symbol
        }
    }
    const sym = decl.getSymbol()?.getName();
    if (sym && sym !== "default" && !sym.startsWith("__"))
        return sym;
    return undefined;
}
/**
 * Map an exported declaration to the node it produced.
 * `base` is the collection key (useful for ambiguity detection: two different
 * bases under one exported name means the name denotes more than one symbol).
 */
export function resolveDeclarationToNode(decl, repoPath, nodeIndex) {
    const name = declarationName(decl);
    if (!name)
        return undefined;
    const base = `${relativePathOf(decl, repoPath)}::${name}`;
    const candidates = nodeIndex.get(base);
    if (!candidates || candidates.length === 0)
        return undefined;
    if (candidates.length === 1)
        return { id: candidates[0].id, base };
    const match = matchOverloadedNode(decl, candidates);
    return match ? { id: match.id, base } : undefined;
}
function matchOverloadedNode(decl, candidates) {
    const paramTypes = declarationParamTypes(decl);
    if (paramTypes === undefined)
        return undefined;
    const declKey = signatureKeyFromTypes(paramTypes);
    const matches = candidates.filter((node) => {
        const params = node.metadata?.parameters;
        if (!Array.isArray(params))
            return false;
        return (signatureKeyFromNodeParams(params) === declKey);
    });
    return matches.length >= 1 ? matches[0] : undefined;
}
function declarationParamTypes(decl) {
    const anyDecl = decl;
    if (typeof anyDecl.getParameters !== "function")
        return undefined;
    try {
        const params = anyDecl.getParameters();
        if (!Array.isArray(params))
            return undefined;
        return params.map((p) => {
            const t = p.getTypeNode?.()?.getText() ?? "unknown";
            if (p.isRest?.())
                return `...${t}`;
            if (p.isOptional?.())
                return `${t}?`;
            return t;
        });
    }
    catch {
        return undefined;
    }
}
function signatureKeyFromTypes(types) {
    return `(${types.join(",")})`;
}
function signatureKeyFromNodeParams(params) {
    return `(${params
        .map((p) => {
        const t = typeof p?.type === "string" && p.type.length > 0 ? p.type : "unknown";
        if (p?.isRest)
            return `...${t}`;
        if (p?.isOptional)
            return `${t}?`;
        return t;
    })
        .join(",")})`;
}

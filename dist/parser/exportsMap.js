// Exports Map builder — the flattened export surface of the repo, shipped in
// the graph artifact for future cross-repo linking (see docs/EXPORTS_MAP.md).
//
// Architecture notes:
//   - Must live in the parser because binding resolution needs the ts-morph
//     Project created inside parseRepo(); a second Project would double parse
//     cost. parseRepo() calls buildExportsMap() after the node loop, so the
//     map is validated against the FINAL node list (only surviving, deduped,
//     overload-suffixed ids can appear as values).
//   - Values are ALWAYS arrays of proper nodeIds — never bare names. The
//     cloud joins against them in one hash lookup; no second resolution step.
//   - Overloads: multiple nodes sharing one base id (path::name) are an
//     overload group — emitted as a plain array. Distinct base ids under one
//     exported name are a TRUE ambiguity — also flagged in ambiguousNames.
//   - TS resolves `export *` conflicts by EXCLUDING the name from the module's
//     exports (same as the JS spec), so star re-exports need no special code.
//   - Anything without a node representation (plain consts, interfaces,
//     type aliases, anonymous defaults, namespace re-exports) is OMITTED —
//     never fabricate an id that won't exist in the nodes array.
//   - package.json "exports" conditions: v1 resolves one condition per subpath
//     (import → default → require); "types"-only subpaths are skipped; wildcard
//     patterns are skipped. Entry targets pointing into dist/build are mapped
//     back to src/ so ids stay in the same coordinate system as the nodes.
//   - Failures never break analysis: any error yields an absent map.
import path from "path";
import fs from "fs";
const ENTRY_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const INDEX_NAMES = ["index.ts", "index.tsx", "index.js", "index.jsx"];
export function buildExportsMap(project, repoPath, nodes) {
    try {
        const pkgPath = path.join(repoPath, "package.json");
        if (!fs.existsSync(pkgPath))
            return undefined;
        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        }
        catch {
            return undefined;
        }
        const entries = resolveEntryPoints(pkg, repoPath, project);
        if (entries.length === 0)
            return undefined;
        const nodeIndex = buildNodeIndex(nodes);
        const starCache = new Map();
        const exports = {};
        const ambiguousNames = {};
        for (const entry of entries) {
            let decls;
            try {
                decls = entry.file.getExportedDeclarations();
            }
            catch {
                continue;
            }
            const explicitNames = explicitExportNames(entry.file);
            const entryPath = entry.file.getFilePath();
            const stars = starContributors(entry.file, starCache);
            const perPath = {};
            const ambiguous = [];
            for (const [name, declList] of decls) {
                const isExplicit = explicitNames.has(name) || declList.some((d) => d.getSourceFile().getFilePath() === entryPath);
                if (!isExplicit) {
                    const contributors = stars.get(name);
                    if (contributors && contributors.size > 1) {
                        ambiguous.push(name);
                        continue;
                    }
                }
                const resolved = [];
                for (const decl of declList) {
                    const hit = resolveDeclarationToNode(decl, repoPath, nodeIndex);
                    if (hit)
                        resolved.push(hit);
                }
                const ids = [...new Set(resolved.map((r) => r.id))].sort();
                if (ids.length === 0)
                    continue;
                const bases = [...new Set(resolved.map((r) => r.base))];
                if (bases.length > 1)
                    ambiguous.push(name);
                perPath[name] = ids;
            }
            if (Object.keys(perPath).length > 0)
                exports[entry.subpath] = perPath;
            if (ambiguous.length > 0)
                ambiguousNames[entry.subpath] = ambiguous;
        }
        if (Object.keys(exports).length === 0)
            return undefined;
        return { exports, ambiguousNames };
    }
    catch {
        return undefined;
    }
}
function explicitExportNames(sf) {
    const names = new Set();
    for (const ed of sf.getExportDeclarations()) {
        for (const spec of ed.getNamedExports())
            names.add(spec.getName());
    }
    return names;
}
function starContributors(sf, cache) {
    const key = sf.getFilePath();
    const cached = cache.get(key);
    if (cached)
        return cached;
    const result = new Map();
    const seen = new Set([key]);
    const stack = [sf];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const ed of current.getExportDeclarations()) {
            if (ed.getNamedExports().length > 0)
                continue;
            const target = ed.getModuleSpecifierSourceFile();
            if (!target || seen.has(target.getFilePath()))
                continue;
            seen.add(target.getFilePath());
            const targetPath = target.getFilePath();
            let targetDecls;
            try {
                targetDecls = target.getExportedDeclarations();
            }
            catch {
                continue;
            }
            for (const [name, declList] of targetDecls) {
                const isLocal = declList.some((d) => d.getSourceFile().getFilePath() === targetPath);
                if (isLocal) {
                    if (!result.has(name))
                        result.set(name, new Set());
                    result.get(name).add(targetPath);
                }
                else {
                    const deeper = starContributors(target, cache);
                    const contributors = deeper.get(name);
                    if (contributors) {
                        if (!result.has(name))
                            result.set(name, new Set());
                        for (const f of contributors)
                            result.get(name).add(f);
                    }
                }
            }
            stack.push(target);
        }
    }
    cache.set(key, result);
    return result;
}
function buildNodeIndex(nodes) {
    const index = new Map();
    for (const node of nodes) {
        const base = `${node.filePath}::${node.name}`;
        if (!index.has(base))
            index.set(base, []);
        index.get(base).push(node);
    }
    return index;
}
function resolveEntryPoints(pkg, repoPath, project) {
    const entries = [];
    if (pkg.exports !== undefined) {
        const normalized = normalizeExportsField(pkg.exports);
        for (const [subpath, target] of normalized) {
            const file = resolveTargetFile(repoPath, target, project);
            if (file)
                entries.push({ subpath, file });
        }
        return entries;
    }
    const fallback = pkg.main ?? pkg.module;
    if (fallback) {
        const file = resolveTargetFile(repoPath, fallback, project);
        if (file)
            entries.push({ subpath: ".", file });
    }
    else {
        for (const candidate of INDEX_NAMES.map((n) => path.join("src", n)).concat(INDEX_NAMES)) {
            const file = resolveTargetFile(repoPath, candidate, project);
            if (file) {
                entries.push({ subpath: ".", file });
                break;
            }
        }
    }
    return entries;
}
function normalizeExportsField(field) {
    const out = [];
    if (typeof field === "string") {
        out.push([".", field]);
        return out;
    }
    if (typeof field !== "object" || field === null)
        return out;
    for (const [subpath, value] of Object.entries(field)) {
        if (subpath.includes("*"))
            continue;
        if (typeof value === "string") {
            out.push([subpath, value]);
            continue;
        }
        if (typeof value !== "object" || value === null)
            continue;
        const conditions = value;
        const chosen = (typeof conditions.import === "string" && conditions.import) ||
            (typeof conditions.default === "string" && conditions.default) ||
            (typeof conditions.require === "string" && conditions.require);
        if (typeof chosen === "string" && chosen)
            out.push([subpath, chosen]);
    }
    return out;
}
function resolveTargetFile(repoPath, target, project) {
    if (typeof target !== "string" || !target)
        return undefined;
    let rel = target.replace(/^\.\//, "").split(/[?#]/)[0];
    if (rel.endsWith(".d.ts"))
        return undefined;
    const candidates = [rel];
    const distMatch = rel.match(/^(dist|build)(\/|$)/);
    if (distMatch) {
        candidates.push("src" + rel.slice(distMatch[1].length));
    }
    for (const candidate of candidates) {
        const stem = candidate.replace(/\.[^.]+$/, "");
        const tries = new Set([candidate]);
        for (const ext of ENTRY_EXTENSIONS)
            tries.add(stem + ext);
        for (const idx of INDEX_NAMES)
            tries.add(path.posix.join(candidate, idx));
        for (const tryPath of tries) {
            if (tryPath.endsWith(".d.ts"))
                continue;
            const abs = path.resolve(repoPath, tryPath);
            if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory())
                continue;
            const sf = project.getSourceFile(abs);
            if (sf)
                return sf;
        }
    }
    return undefined;
}
function resolveDeclarationToNode(decl, repoPath, nodeIndex) {
    const name = declarationName(decl);
    if (!name)
        return undefined;
    const relPath = path.relative(repoPath, decl.getSourceFile().getFilePath()).replace(/\\/g, "/");
    const base = `${relPath}::${name}`;
    const candidates = nodeIndex.get(base);
    if (!candidates || candidates.length === 0)
        return undefined;
    if (candidates.length === 1)
        return { id: candidates[0].id, base };
    const match = matchOverloadedNode(decl, candidates);
    return match ? { id: match.id, base } : undefined;
}
function declarationName(decl) {
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
function matchOverloadedNode(decl, candidates) {
    const paramTypes = declarationParamTypes(decl);
    if (paramTypes === undefined)
        return undefined;
    const declKey = signatureKeyFromTypes(paramTypes);
    const matches = candidates.filter((node) => {
        const params = node.metadata?.parameters;
        if (!Array.isArray(params))
            return false;
        return signatureKeyFromNodeParams(params) === declKey;
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
export function validateExportsMap(map, nodeIds) {
    const dangling = [];
    for (const perPath of Object.values(map.exports)) {
        for (const ids of Object.values(perPath)) {
            for (const id of ids) {
                if (!nodeIds.has(id))
                    dangling.push(id);
            }
        }
    }
    return [...new Set(dangling)];
}
export function exportsMapStats(map) {
    let names = 0;
    let ambiguous = 0;
    for (const perPath of Object.values(map.exports))
        names += Object.keys(perPath).length;
    for (const list of Object.values(map.ambiguousNames))
        ambiguous += list.length;
    return { subpaths: Object.keys(map.exports).length, names, ambiguous };
}

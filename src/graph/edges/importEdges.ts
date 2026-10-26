import path from "path";
import fs from "fs";
import type { CodeEdge, CodeNode } from "../../types.js";
import type { LookupMaps, ImportTarget } from "../buildLookup.js";
import { nodesFromLookup } from "../buildLookup.js";
import { extractPackageName } from "../thirdPartyLibs.js";
import { buildNodeIndex, resolveDeclarationToNode } from "../../parser/declarationIds.js";
import { Project, type ImportDeclaration } from "ts-morph";

// Aliases we consider as local imports
const LOCAL_PREFIXES = ["./", "../", "@/", "~/", "#/"];

// Check if an import is local (not third party)
export function isLocalImport(importPath: string) {
    return LOCAL_PREFIXES.some(prefix => importPath.startsWith(prefix));
}

//Get config file path - tsconfig first, jsconfig as fallback
function getConfigPath(repoPath: string): string | undefined {
    const tsconfig = path.join(repoPath, "tsconfig.json");
    const jsconfig = path.join(repoPath, "jsconfig.json");
    if (fs.existsSync(tsconfig)) return tsconfig;
    if (fs.existsSync(jsconfig)) return jsconfig;
    return undefined;
}


// Recursively walk directory and add files to project
// Same approach as parser — reliable on Windows
function addFilesRecursively(dir: string, project: Project): void {
    const IGNORE_DIRS = [
        "node_modules", "dist", "build",
        ".next", "coverage", ".git",
    ];

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (IGNORE_DIRS.includes(entry.name)) continue;
            addFilesRecursively(fullPath, project);
        } else if (entry.isFile()) {
            if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
            if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
            if (/\.d\.ts$/.test(entry.name)) continue;
            project.addSourceFileAtPath(fullPath);
        }
    }
}

export interface ImportEdgeResult {
    edges: CodeEdge[];
    // Dynamically-created per-method THIRD_PARTY nodes (one per unique named import).
    // Collected here so the pipeline can add them to allNodes before rendering.
    thirdPartyMethodNodes: CodeNode[];
}

export function detectImportEdges(lookupMp: LookupMaps, repoPath: string): ImportEdgeResult {
    const edges: CodeEdge[] = [];
    const createdEdges = new Set<string>();

    // Dedup method nodes across all files — same named import in multiple files
    // produces only ONE node (e.g. a single [npm]/react::useState node).
    const methodNodesMap = new Map<string, CodeNode>();

    const configPath = getConfigPath(repoPath);
    const project = configPath
      ? new Project({ tsConfigFilePath: configPath, skipAddingFilesFromTsConfig: true })
      : new Project({
            compilerOptions: {
                allowJs: true,
                checkJs: false,
                jsx: 4,
                strict: false,
            },
            skipAddingFilesFromTsConfig: true,
        });

    addFilesRecursively(repoPath, project);

    for (const file of project.getSourceFiles()) {
        const absFilePath = file.getFilePath();
        const sourceRelative = path.relative(repoPath, absFilePath).replace(/\\/g, "/");
        const sourceFileNode = lookupMp.fileNodesByPath.get(sourceRelative);
        if (!sourceFileNode) continue;

        const importDeclarations = file.getImportDeclarations();

        for (const importDecl of importDeclarations) {
            const moduleSpecifier = importDecl.getModuleSpecifierValue();

            if (!isLocalImport(moduleSpecifier)) {
                // ─── Third-party import ───────────────────────────────────
                const pkgName        = extractPackageName(moduleSpecifier);
                const thirdPartyNode = lookupMp.thirdPartyNodesByName.get(pkgName);

                if (thirdPartyNode) {
                    const fileAliasMap = lookupMp.thirdPartyImportAliases.get(sourceRelative) ?? new Map<string, string>();

                    // ── Named imports → one method node per imported name ──────
                    // e.g. import { useState, useEffect } from 'react'
                    //   → nodes [npm]/react::useState, [npm]/react::useEffect
                    //   → fileAliasMap: "useState" → "[npm]/react::useState"
                    for (const specifier of importDecl.getNamedImports()) {
                        const localAlias   = specifier.getAliasNode()?.getText() ?? specifier.getName();
                        const importedName = specifier.getName();

                        const methodNodeId = `[npm]/${pkgName}::${importedName}`;

                        if (!methodNodesMap.has(methodNodeId)) {
                            methodNodesMap.set(methodNodeId, {
                                id:        methodNodeId,
                                name:      `${pkgName}.${importedName}`,
                                type:      "THIRD_PARTY",
                                filePath:  `[npm]/${pkgName}`,
                                startLine: 0,
                                endLine:   0,
                                rawCode:   undefined,
                                codeHash:  undefined,
                                metadata: {
                                    isThirdParty:    true,
                                    packageVersion:  thirdPartyNode.metadata.packageVersion,
                                    category:        thirdPartyNode.metadata.category,
                                    parentPackageId: thirdPartyNode.id,
                                    methodName:      importedName,
                                },
                            });
                        }

                        // Map the local alias to the method node so callEdges can resolve it
                        fileAliasMap.set(localAlias, methodNodeId);

                        // IMPORTS edge: source file → method node
                        const edgeKey = `${sourceFileNode.id}→${methodNodeId}:IMPORTS`;
                        if (!createdEdges.has(edgeKey)) {
                            createdEdges.add(edgeKey);
                            edges.push({
                                from: sourceFileNode.id,
                                to:   methodNodeId,
                                type: "IMPORTS",
                                metadata: { importPath: moduleSpecifier, isThirdParty: true, importedName },
                            });
                        }
                    }

                    // ── Default import → package node ─────────────────────────
                    // e.g. import axios from 'axios'
                    //   → fileAliasMap: "axios" → "[npm]/axios"
                    //   Method nodes for member-access calls (axios.get) are created
                    //   lazily in callEdges.ts when the actual calls are encountered.
                    const defaultImport = importDecl.getDefaultImport();
                    if (defaultImport) {
                        fileAliasMap.set(defaultImport.getText(), thirdPartyNode.id);

                        const edgeKey = `${sourceFileNode.id}→${thirdPartyNode.id}:IMPORTS`;
                        if (!createdEdges.has(edgeKey)) {
                            createdEdges.add(edgeKey);
                            edges.push({
                                from: sourceFileNode.id,
                                to:   thirdPartyNode.id,
                                type: "IMPORTS",
                                metadata: { importPath: moduleSpecifier, isThirdParty: true },
                            });
                        }
                    }

                    // ── Namespace import → package node ───────────────────────
                    // e.g. import * as ReactQuery from '@tanstack/react-query'
                    //   → fileAliasMap: "ReactQuery" → "[npm]/@tanstack/react-query"
                    const namespaceImport = importDecl.getNamespaceImport();
                    if (namespaceImport) {
                        fileAliasMap.set(namespaceImport.getText(), thirdPartyNode.id);

                        const edgeKey = `${sourceFileNode.id}→${thirdPartyNode.id}:IMPORTS`;
                        if (!createdEdges.has(edgeKey)) {
                            createdEdges.add(edgeKey);
                            edges.push({
                                from: sourceFileNode.id,
                                to:   thirdPartyNode.id,
                                type: "IMPORTS",
                                metadata: { importPath: moduleSpecifier, isThirdParty: true },
                            });
                        }
                    }

                    lookupMp.thirdPartyImportAliases.set(sourceRelative, fileAliasMap);
                }
                continue; // always skip local-resolution path for non-local imports
            }

            // ─── Local named-import symbol map ────────────────────────────
            // Records localAlias → importedName so callEdges can resolve
            // `US.get()` when `import { UserService as US } from "./services"`
            // (the dotted METHOD node is named `UserService.get`).
            // Tier-3 fallback only — the binding-aware maps below carry the
            // resolved file and drive tier-2 resolution.
            const localAliases = lookupMp.localImportSymbols.get(sourceRelative) ?? new Map<string, string>();
            for (const specifier of importDecl.getNamedImports()) {
                const localAlias = specifier.getAliasNode()?.getText() ?? specifier.getName();
                localAliases.set(localAlias, specifier.getName());
            }
            if (localAliases.size > 0) {
                lookupMp.localImportSymbols.set(sourceRelative, localAliases);
            }

            // ─── Resolve the imported file path ───────────────────────────
            let resolvedPath: string | undefined;

            // First try ts-morph automatic resolution
            // Works when tsconfig/jsconfig exists
            const resolvedFile = importDecl.getModuleSpecifierSourceFile();
            if (resolvedFile) {
                resolvedPath = resolvedFile.getFilePath();
            } else {
                // Fallback — manually resolve relative and alias paths
                // Used when no tsconfig exists (e.g. in tests)
                const currentDir = path.dirname(absFilePath);
                let basePath = moduleSpecifier;

                // Handle @/ ~/ #/ aliases → resolve to src/
                if (
                    moduleSpecifier.startsWith("@/") ||
                    moduleSpecifier.startsWith("~/") ||
                    moduleSpecifier.startsWith("#/")
                ) {
                    basePath = path.join(repoPath, "src", moduleSpecifier.slice(2));
                } else {
                    // Relative import — resolve from current file's directory
                    basePath = path.join(currentDir, moduleSpecifier);
                }

                // Try all possible extensions and index file patterns
                const candidates = [
                    basePath,
                    basePath + ".ts",
                    basePath + ".tsx",
                    basePath + ".js",
                    basePath + ".jsx",
                    path.join(basePath, "index.ts"),
                    path.join(basePath, "index.tsx"),
                    path.join(basePath, "index.js"),
                    path.join(basePath, "index.jsx"),
                ];

                resolvedPath = candidates.find((c) => fs.existsSync(c));
            }

            if (!resolvedPath) continue;

            const targetRelative = path.relative(repoPath, resolvedPath).replace(/\\/g, "/");
            const targetFileNode = lookupMp.fileNodesByPath.get(targetRelative);
            if (!targetFileNode) continue;

            // ─── Binding-aware import targets (drives tier-2 resolution) ──
            // Recorded BEFORE the file-pair dedupe below: two import
            // declarations from the same module (or an aliased second name)
            // would otherwise lose their alias entries.
            recordImportTargets(lookupMp, sourceRelative, targetRelative, importDecl);

            const edgeKey = `${sourceFileNode.id}→${targetFileNode.id}`;
            if (createdEdges.has(edgeKey)) continue;
            createdEdges.add(edgeKey);

            edges.push({
                from: sourceFileNode.id,
                to: targetFileNode.id,
                type: "IMPORTS",
                metadata: { importPath: moduleSpecifier },
            });
        }
    }

    // ─── Export surface per module (one pass, reuses this Project) ────────
    // TypeScript's checker already follows `export … from`, `export *`,
    // defaults and path mappings, so a 20-hop re-export chain collapses into a
    // single (file, name) → origin nodeId entry below.
    buildExportSurface(lookupMp, project, repoPath);

    return { edges, thirdPartyMethodNodes: [...methodNodesMap.values()] };
}

/** local name → resolved module + exported name, for every import kind. */
function recordImportTargets(
    lookupMp: LookupMaps,
    sourceRelative: string,
    targetRelative: string,
    importDecl: ImportDeclaration,
): void {
    const targets = lookupMp.importTargets.get(sourceRelative) ?? new Map<string, ImportTarget>();

    for (const spec of importDecl.getNamedImports()) {
        const localName = spec.getAliasNode()?.getText() ?? spec.getName();
        targets.set(localName, {
            targetFile: targetRelative,
            importedName: spec.getName(),
            kind: "named",
        });
    }

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
        targets.set(defaultImport.getText(), {
            targetFile: targetRelative,
            importedName: "default",
            kind: "default",
        });
    }

    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) {
        targets.set(namespaceImport.getText(), {
            targetFile: targetRelative,
            importedName: "*",
            kind: "namespace",
        });
    }

    if (targets.size > 0) lookupMp.importTargets.set(sourceRelative, targets);
}

/**
 * Build the per-module export surface.
 *
 * `exportBindings[file][exportedName] = [origin nodeIds]` — the resolution
 * table. `getExportedDeclarations()` returns the ORIGIN declaration of every
 * exported name (re-exports, `export *`, barrels and defaults already followed
 * by the checker), and `resolveDeclarationToNode` maps it to a node id using
 * the shared overload-aware scheme — so `path::name#arity` ids are produced in
 * exactly one place.
 *
 * `reexportLinks` / `reexportGlobs` record the hops themselves. They are NOT
 * used for resolution (the chain is already collapsed); they exist so callers
 * can show "how did this name get here" without inventing graph edges.
 */
function buildExportSurface(lookupMp: LookupMaps, project: Project, repoPath: string): void {
    const nodeIndex = buildNodeIndex(nodesFromLookup(lookupMp));
    if (nodeIndex.size === 0) return;

    for (const file of project.getSourceFiles()) {
        const rel = path.relative(repoPath, file.getFilePath()).replace(/\\/g, "/");

        // ── resolution table ─────────────────────────────────────────────
        try {
            const bindings = new Map<string, string[]>();
            for (const [exportedName, declarations] of file.getExportedDeclarations()) {
                const ids: string[] = [];
                for (const declaration of declarations) {
                    const hit = resolveDeclarationToNode(declaration, repoPath, nodeIndex);
                    if (hit) ids.push(hit.id);
                }
                const unique = [...new Set(ids)];
                if (unique.length > 0) bindings.set(exportedName, unique);
            }
            if (bindings.size > 0) lookupMp.exportBindings.set(rel, bindings);
        } catch {
            // One unparseable file must not break edge detection — its imports
            // simply fall through to the name-based tier.
        }

        // ── provenance hops (display only) ───────────────────────────────
        try {
            const links = new Map<string, { targetFile: string; targetName: string }>();
            const globs: string[] = [];

            for (const exportDecl of file.getExportDeclarations()) {
                const target = exportDecl.getModuleSpecifierSourceFile();
                const targetRel = target
                    ? path.relative(repoPath, target.getFilePath()).replace(/\\/g, "/")
                    : rel; // `export { a as b }` with no `from` — a local binding hop

                const namespaceExport = exportDecl.getNamespaceExport();
                if (namespaceExport) {
                    if (!target) continue;
                    links.set(namespaceExport.getName(), { targetFile: targetRel, targetName: "*" });
                    continue;
                }

                const named = exportDecl.getNamedExports();
                if (named.length === 0) {
                    if (!target) continue;
                    // `export * from "./x"` — exported names mirror the target
                    globs.push(targetRel);
                    continue;
                }
                for (const spec of named) {
                    const exportedName = spec.getAliasNode()?.getText() ?? spec.getName();
                    links.set(exportedName, { targetFile: targetRel, targetName: spec.getName() });
                }
            }

            if (links.size > 0) lookupMp.reexportLinks.set(rel, links);
            if (globs.length > 0) lookupMp.reexportGlobs.set(rel, globs);
        } catch {
            // provenance is best-effort
        }
    }
}

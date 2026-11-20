import fs from "fs";
import path from "path";
import { Project, SyntaxKind } from "ts-morph";
import { closestByPath } from "./utils.js";
// Recursively walk directory and add files to project
// Same approach as parser — reliable on Windows
function addFilesRecursively(dir, project) {
    const IGNORE_DIRS = [
        "node_modules", "dist", "build",
        ".next", "coverage", ".git",
    ];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (IGNORE_DIRS.includes(entry.name))
                continue;
            addFilesRecursively(fullPath, project);
        }
        else if (entry.isFile()) {
            if (!/\.(ts|tsx|js|jsx)$/.test(entry.name))
                continue;
            if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name))
                continue;
            if (/\.d\.ts$/.test(entry.name))
                continue;
            project.addSourceFileAtPath(fullPath);
        }
    }
}
const SITE_LINE_TOLERANCE = 2;
function nearestSite(sites, line) {
    let best;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const site of sites) {
        const gap = Math.abs(site.line - line);
        if (gap < bestGap) {
            best = site;
            bestGap = gap;
        }
        if (gap === 0)
            return site;
    }
    return bestGap <= SITE_LINE_TOLERANCE ? best : undefined;
}
export function detectPropEdges(nodes, lookupMp, repoPath) {
    const edges = [];
    // Track created edges for deduplication
    // Key: "fromId→toId" — value: index in edges array
    // So we can update renderCount on duplicates
    const edgeIndex = new Map();
    const project = new Project({
        compilerOptions: {
            allowJs: true,
            checkJs: false,
            jsx: 4,
            strict: false,
        },
        skipAddingFilesFromTsConfig: true,
    });
    addFilesRecursively(repoPath, project);
    const componentNodes = nodes.filter(n => n.type === "COMPONENT");
    for (const component of componentNodes) {
        const absPath = path.resolve(repoPath, component.filePath).replace(/\\/g, "/");
        const sourceFile = project.getSourceFile(absPath);
        if (!sourceFile)
            continue;
        // Find all JSX elements in the file
        const jsxOpeningElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
        const jsxSelfClosingElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
        // Filter to only JSX within this component's line range (meaning which lies between this component's startLine and endLine)
        // Sorted by source position: JSX document order is render order for the
        // element tree the component returns.
        const allJsxElements = [...jsxOpeningElements, ...jsxSelfClosingElements]
            .filter(el => {
            const line = el.getStartLineNumber();
            return line >= component.startLine && line <= component.endLine;
        })
            .sort((a, b) => a.getStart() - b.getStart());
        const renderSites = component.metadata.renderSites ?? [];
        const renderEntries = new Map();
        for (const jsxElement of allJsxElements) {
            const tagName = jsxElement.getTagNameNode().getText();
            // Skip HTML native elements — they start with lowercase
            if (/^[a-z]/.test(tagName))
                continue;
            // ── Context.Provider detection ─────────────────────────────────
            // <AuthContext.Provider value={...}> signals this component
            // provides that context to its subtree → WRITES_TO edge.
            if (tagName.endsWith(".Provider")) {
                const contextName = tagName.slice(0, -".Provider".length);
                const ctxStore = lookupMp.storeNodes.find(n => n.name === contextName && n.metadata.storeType === "context");
                if (ctxStore) {
                    edges.push({
                        from: component.id,
                        to: ctxStore.id,
                        type: "WRITES_TO",
                        metadata: { isContextProvider: true },
                    });
                }
                continue; // not a renderable component node — skip normal lookup
            }
            const targetNodes = lookupMp.nodesByName.get(tagName);
            if (!targetNodes || targetNodes.length === 0)
                continue; // this means that this is not a component we extracted
            //Extract prop names passed to the component
            const attributes = jsxElement.getAttributes();
            const props = [];
            for (const attr of attributes) {
                // Regular prop: user={currentUser} or disabled
                // Spread prop: {...props} — we skip these
                if (attr.getKind() === SyntaxKind.JsxAttribute) {
                    const propName = attr.getFirstChild()?.getText();
                    if (propName)
                        props.push(propName);
                }
            }
            // When multiple components share the same name, pick the one
            // physically closest to the rendering file to avoid false edges.
            const targetNode = targetNodes.length === 1
                ? targetNodes[0]
                : closestByPath(targetNodes, component.filePath);
            if (targetNode.id === component.id)
                continue; //skip self referencing
            if (renderSites.length > 0) {
                const site = nearestSite(renderSites, jsxElement.getStartLineNumber());
                const existing = renderEntries.get(targetNode.id);
                if (existing) {
                    existing.renderCount = (existing.renderCount ?? 1) + 1;
                }
                else if (site) {
                    renderEntries.set(targetNode.id, {
                        kind: "render",
                        name: targetNode.name,
                        nodeId: targetNode.id,
                        firstOrder: site.order,
                        line: site.line,
                        depth: site.depth,
                        renderCount: 1,
                        ...(site.conditional && { conditional: true }),
                        ...(site.repeat && { repeat: true }),
                        ...(props.length > 0 && { props }),
                    });
                }
            }
            const edgeKey = `${component.id}→${targetNode.id}`;
            if (edgeIndex.has(edgeKey)) {
                // Edge already exists — update renderCount
                const idx = edgeIndex.get(edgeKey);
                const existing = edges[idx];
                const currentCount = existing.metadata?.renderCount ?? 1;
                edges[idx] = {
                    ...existing,
                    metadata: {
                        ...existing.metadata,
                        renderCount: currentCount + 1,
                    },
                };
            }
            else {
                // create new edge
                const newEdge = {
                    from: component.id,
                    to: targetNode.id,
                    type: "PROP_PASS",
                    metadata: {
                        props,
                        renderCount: 1,
                    }
                };
                edgeIndex.set(edgeKey, edges.length);
                edges.push(newEdge);
            }
        }
        delete component.metadata.renderSites;
        if (renderEntries.size > 0) {
            const existing = (component.metadata.resolvedCalls ?? []);
            const merged = [...existing];
            for (const entry of renderEntries.values()) {
                if (!merged.some((e) => e.nodeId === entry.nodeId))
                    merged.push(entry);
            }
            merged.sort((a, b) => (a.firstOrder ?? Number.MAX_SAFE_INTEGER) - (b.firstOrder ?? Number.MAX_SAFE_INTEGER));
            component.metadata.resolvedCalls = merged;
        }
    }
    return edges;
}

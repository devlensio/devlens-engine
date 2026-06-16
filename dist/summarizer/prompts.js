// Call once before the batch loop.
export function buildEdgeIndex(edges) {
    const outgoing = new Map();
    const incoming = new Map();
    const getOrCreate = (map, nodeId, edgeType) => {
        if (!map.has(nodeId))
            map.set(nodeId, new Map());
        const inner = map.get(nodeId);
        if (!inner.has(edgeType))
            inner.set(edgeType, []);
        return inner.get(edgeType);
    };
    for (const edge of edges) {
        getOrCreate(outgoing, edge.from, edge.type).push(edge.to);
        getOrCreate(incoming, edge.to, edge.type).push(edge.from);
    }
    return { outgoing, incoming };
}
// Call once before the batch loop.
export function buildRouteIndex(routes) {
    const byFilePath = new Map();
    for (const route of routes) {
        byFilePath.set(route.filePath, route);
    }
    return { byFilePath };
}
// ─── System Prompt ────────────────────────────────────────────────────────────
//
// Built once per summarization run — same for every node.
// Fingerprint gives the LLM project-level context for better business summaries.
const BASE_SYSTEM_PROMPT = `You are a senior software engineer analyzing a codebase.
Your job is to summarize a single code node based on its source code and context.

Respond ONLY in this exact XML format — no preamble, no explanation outside the tags:

<technical>
HTML content describing what this code does: its inputs, outputs, side effects, and key logic.
</technical>
<business>
HTML content describing what problem this solves in the product and what feature or domain it belongs to.
</business>
<security_severity>none|low|medium|high</security_severity>
<security_summary>
HTML content describing the vulnerability (if severity is not none): what data is at risk and how it could be exploited.
Leave empty if severity is none.
</security_summary>

## Formatting rules for content inside the XML tags
Use HTML markup — the output is rendered in a browser tooltip, sidebar panel, and detail panel. Follow these conventions:

- Inline code, function names, variable names, parameter names, file paths:
    <code>functionName()</code>  or  <code>someVariable</code>
- Multi-line code blocks (more than one line of code):
    <pre><code>const x = 1;\nreturn x;</code></pre>
- Key points / bullet lists (preferred for 3+ items):
    <ul><li>First point.</li><li>Second point.</li></ul>
- Numbered steps (only when order matters):
    <ol><li>Step one.</li><li>Step two.</li></ol>
- Bold for important terms or labels: <strong>important</strong>
- No <h1>/<h2> headings — use <strong> inline labels instead.
- No inline styles. No <div> wrappers. No Markdown (no **, no backticks, no #).
- Write in plain prose sentences; use lists only when there are three or more distinct items.
- Keep paragraphs short — summaries are displayed in compact UI containers (200-300px wide).
- Avoid long paragraphs; break complex ideas into <ul> lists for scanability.

## Security summary guidelines
The security_summary is displayed in a compact sidebar and a detail panel. Follow these rules:
- Lead with the specific vulnerability type (e.g. "SQL injection", "XSS", "exposed secret").
- Use <ul> lists when describing multiple risks or attack vectors.
- Mention the affected data or resource (e.g. "user credentials", "database contents").
- Keep it under 3 sentences for scanability.
- Example: <ul><li><strong>SQL injection</strong>: User input in <code>query</code> is passed directly to <code>db.execute()</code> without parameterization.</li><li>Attackers can extract or modify database contents.</li></ul>

## Severity guide
  none   — no security concerns
  low    — minor issue, limited impact (e.g. verbose error messages)
  medium — potential vulnerability, needs attention (e.g. missing input validation)
  high   — serious vulnerability, could be exploited (e.g. SQL injection, exposed secrets, missing auth)`;
export function buildSystemPrompt(fingerprint) {
    const lines = [];
    lines.push(`Framework:     ${fingerprint.framework}`);
    lines.push(`Language:      ${fingerprint.language}`);
    lines.push(`Project type:  ${fingerprint.projectType}`);
    if (fingerprint.stateManagement.length > 0)
        lines.push(`State:         ${fingerprint.stateManagement.join(", ")}`);
    if (fingerprint.databases.length > 0)
        lines.push(`Databases:     ${fingerprint.databases.join(", ")}`);
    if (fingerprint.dataFetching.length > 0)
        lines.push(`Data fetching: ${fingerprint.dataFetching.join(", ")}`);
    return `${BASE_SYSTEM_PROMPT}\n\n## Project Context\n${lines.join("\n")}`;
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
export const EDGE_LABELS = {
    CALLS: "Calls",
    READS_FROM: "Reads from",
    WRITES_TO: "Writes to",
    IMPORTS: "Imports",
    PROP_PASS: "Passes props to",
    EMITS: "Emits event",
    LISTENS: "Listens to",
    WRAPPED_BY: "Wrapped by",
    GUARDS: "Guards",
    HANDLES: "Handles",
    TESTS: "Tests",
    USES: "Uses"
};
// Renders a dep summary line — uses technicalSummary if available, else just the name.
function depLine(depNode) {
    const summary = depNode.technicalSummary
        ? ` — ${depNode.technicalSummary.slice(0, 120)}`
        : "";
    return `  ${depNode.name} [${depNode.type}]${summary}`;
}
// ─── User Prompt Builder ──────────────────────────────────────────────────────
function buildUserPrompt(ctx) {
    const { node, allNodes, edgeIndex, routeIndex } = ctx;
    const parts = [];
    // ── Source code ───────────────────────────────────────────────
    parts.push(`## Node: ${node.name} [${node.type}]`);
    parts.push(`File: ${node.filePath}`);
    parts.push("");
    parts.push("### Source Code");
    parts.push("```");
    parts.push(node.rawCode ?? "(source not available)");
    parts.push("```");
    // ── Dependencies (outgoing edges) — O(1) lookup ───────────────
    const outgoing = edgeIndex.outgoing.get(node.id);
    if (outgoing && outgoing.size > 0) {
        const depLines = [];
        for (const [edgeType, targetIds] of outgoing) {
            const label = EDGE_LABELS[edgeType] ?? edgeType;
            for (const targetId of targetIds) {
                const depNode = allNodes.get(targetId);
                if (depNode)
                    depLines.push(`${label}:\n${depLine(depNode)}`);
            }
        }
        if (depLines.length > 0) {
            parts.push("");
            parts.push("### Dependencies");
            parts.push(depLines.join("\n"));
        }
    }
    // ── Used by (incoming edges) — O(1) lookup ────────────────────
    const incoming = edgeIndex.incoming.get(node.id);
    if (incoming && incoming.size > 0) {
        const usedByLines = [];
        for (const [edgeType, sourceIds] of incoming) {
            const label = EDGE_LABELS[edgeType] ?? edgeType;
            for (const sourceId of sourceIds) {
                const sourceNode = allNodes.get(sourceId);
                if (sourceNode)
                    usedByLines.push(`${label} by: ${sourceNode.name} [${sourceNode.type}]`);
            }
        }
        if (usedByLines.length > 0) {
            parts.push("");
            parts.push("### Used By");
            parts.push(usedByLines.join("\n"));
        }
    }
    // ── Route context — O(1) lookup ───────────────────────────────
    const route = routeIndex.byFilePath.get(node.filePath);
    if (route) {
        parts.push("");
        parts.push("### Route Context");
        if ("httpMethod" in route) {
            parts.push(`HTTP ${route.httpMethod} ${route.urlPath}`);
            if (route.params && route.params.length > 0)
                parts.push(`Dynamic params: ${route.params.join(", ")}`);
        }
        else {
            parts.push(`${route.type} — ${route.urlPath}`);
            if (route.isDynamic && route.params && route.params.length > 0)
                parts.push(`Dynamic params: ${route.params.join(", ")}`);
            if (route.httpMethods && route.httpMethods.length > 0)
                parts.push(`HTTP methods: ${route.httpMethods.join(", ")}`);
        }
    }
    return parts.join("\n");
}
// ─── Public API ───────────────────────────────────────────────────────────────
// Builds the full message array for a single node — O(degree) not O(n).
export function buildPrompt(ctx) {
    return [
        { role: "system", content: ctx.systemPrompt },
        { role: "user", content: buildUserPrompt(ctx) },
    ];
}
// Builds a grouped prompt for a cycle group.
// Used when cycleGroup.size <= MAX_GROUP_SUMMARY_SIZE.
export function buildCycleGroupPrompt(nodeIds, ctx) {
    const nodes = nodeIds.map(id => ctx.allNodes.get(id)).filter(Boolean);
    const userContent = nodes
        .map(node => buildUserPrompt({ ...ctx, node }))
        .join("\n\n---\n\n");
    const systemWithNote = ctx.systemPrompt + "\n\n" +
        `Note: The nodes above form a circular dependency group. ` +
        `Summarize each one, keeping their mutual relationship in mind. ` +
        `Repeat the XML block once per node, preceded by: <!-- node: {name} -->`;
    return [
        { role: "system", content: systemWithNote },
        { role: "user", content: userContent },
    ];
}

// This file detects the backend routes of the NEXTjs only
import { Project, SyntaxKind } from "ts-morph";
import path from "node:path";
import { extractUrlFromArg, normalizeUrl, urlPathtoRegex } from "./helpers/routeMatching.js";
const CALLER_CONFIG = {
    "fetch": { inferMethod: "from-options", defaultMethod: "GET" },
    "axios.get": { inferMethod: "fixed", method: "GET" },
    "axios.post": { inferMethod: "fixed", method: "POST" },
    "axios.put": { inferMethod: "fixed", method: "PUT" },
    "axios.delete": { inferMethod: "fixed", method: "DELETE" },
    "axios.patch": { inferMethod: "fixed", method: "PATCH" },
    // axios(...) called as a function. Default verb is GET (matching axios),
    // and the first arg may be either a URL string or a config object — both
    // handled in extractApiCallsFromFile.
    "axios": { inferMethod: "from-options", defaultMethod: "GET" },
    // useSWR(key, fetcher) / useSWRMutation(key, fetcher): the first arg IS the
    // key/URL, so URL extraction works. useQuery/useSuspenseQuery/useMutation
    // are intentionally omitted — their first arg is a query-key array or an
    // options object, never a URL. The real request they fire is the inner
    // fetch/axios call, which is captured on its own as a CallExpression.
    "useSWR": { inferMethod: "fixed", method: "GET" },
    "useSWRMutation": { inferMethod: "fixed", method: "UNKNOWN" },
};
// Groups Next.js API ROUTE nodes by HTTP method for efficient lookup.
// Each route node carries a concrete method, so it is indexed under that one
// method key. Callers with an UNKNOWN method (e.g. useSWRMutation) are handled
// on the query side in matchRouteEntries by scanning every method bucket.
function buildRouteIndex(nodes) {
    const index = new Map();
    const apiRouteNodes = nodes.filter(n => n.type === "ROUTE" &&
        n.metadata.routeKind === "nextjs" &&
        n.metadata.routeNodeType === "API_ROUTE" &&
        typeof n.metadata.httpMethod === "string" &&
        typeof n.metadata.urlPath === "string");
    for (const routeNode of apiRouteNodes) {
        const httpMethod = routeNode.metadata.httpMethod.toUpperCase();
        const urlPath = routeNode.metadata.urlPath;
        const isDynamic = routeNode.metadata.isDynamic;
        const entry = {
            routeNode, urlPath, httpMethod, isDynamic, urlRegex: urlPathtoRegex(urlPath),
        };
        if (!index.has(httpMethod))
            index.set(httpMethod, []);
        index.get(httpMethod).push(entry);
    }
    return index;
}
//  Route Matching 
// Matches a normalized URL + HTTP method against the route index.
// Rules:
//   1. Static routes (isDynamic=false) are matched first using === equality
//   2. Dynamic routes are only tried if no static match found
//   3. UNKNOWN method (useSWRMutation etc.) tries all entries across all methods
function matchRouteEntries(normalizedUrl, method, routeIndex) {
    // Gather candidate entries for this method
    const candidates = method === "UNKNOWN" ? [...routeIndex.values()].flat() : routeIndex.get(method) ?? [];
    if (candidates.length === 0)
        return [];
    //  Pass 1: static exact match
    const staticMatches = candidates.filter(e => !e.isDynamic && e.urlPath === normalizedUrl);
    if (staticMatches.length > 0)
        return staticMatches;
    //  Pass 2: dynamic regex match
    // normalizeUrl has already turned every interpolated segment into the
    // literal token ":dynamic", which the route regex's [^/]+ (or .+ for
    // catch-alls) matches directly — so testing the normalized URL is enough.
    // e.g. "/api/users/:dynamic" matches the regex for route "/api/users/:id".
    return candidates.filter(e => e.isDynamic && e.urlRegex.test(normalizedUrl));
}
// Scans EVERY call expression in a source file exactly once.
// For each call matching CALLER_CONFIG:
//   - infers the HTTP method
//   - extracts and resolves the URL argument
// It additionally scans for backend routes used as a resource URL:
//   - JSX src/href attributes — tag-agnostic, so it covers native elements
//     (<video src="/api/..">, <iframe src={url}>, <a href={`/api/${id}`}>)
//     AND third-party player components (<HlsPlayer src={url} />,
//     <ReactHlsPlayer src={...} />).
//   - object-literal src/href properties — config-object style usage where a
//     route is handed to a third-party player/function, e.g.
//     loadPlayer({ src: '/api/stream' }).
// The browser issues a GET for any such resource, so these are emitted as GET.
// The expensive AST traversal happens once per file here; callers then
// attribute the resulting calls to nodes by line range (see detectNextjsApiCallEdges).
// Note: useQuery/useMutation inner fetch/axios calls are captured naturally
// since they are also CallExpressions in the file.
function extractApiCallsFromFile(sourceFile, project) {
    const results = [];
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callerType = call.getExpression().getText();
        const config = CALLER_CONFIG[callerType];
        if (!config)
            continue;
        const args = call.getArguments();
        if (args.length === 0)
            continue;
        //  Infer HTTP method + extract URL
        let method;
        let urlResult;
        if (callerType === "axios" &&
            args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
            // axios({ url, method }) — both url and method live in the config object.
            // axios defaults to GET when no method is given.
            const cfg = args[0];
            const urlInit = cfg.getProperty("url")?.getInitializer?.();
            urlResult = urlInit ? extractUrlFromArg(urlInit, sourceFile, project) : null;
            method = "GET";
            const methodInit = cfg.getProperty("method")?.getInitializer?.();
            if (methodInit && methodInit.getKind() === SyntaxKind.StringLiteral) {
                method = methodInit.getLiteralText().toUpperCase();
            }
        }
        else if (config.inferMethod === "fixed") {
            method = config.method;
            urlResult = extractUrlFromArg(args[0], sourceFile, project);
        }
        else {
            method = config.defaultMethod;
            // fetch('/api', { method: 'POST' }) / axios('/api', { method }) — check 2nd arg
            if (args.length >= 2) {
                const optsArg = args[1];
                if (optsArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
                    const methodProp = optsArg.getProperty("method");
                    if (methodProp) {
                        const init = methodProp.getInitializer?.();
                        if (init && init.getKind() === SyntaxKind.StringLiteral) {
                            method = init.getLiteralText().toUpperCase();
                        }
                    }
                }
            }
            urlResult = extractUrlFromArg(args[0], sourceFile, project);
        }
        if (!urlResult)
            continue;
        results.push({
            startLine: call.getStartLineNumber(),
            call: {
                callerType,
                rawUrl: urlResult.rawUrl,
                resolvedUrl: urlResult.resolvedUrl,
                method,
            },
        });
    }
    // JSX src/href attributes — tag-agnostic, so native elements (video, iframe,
    // a) and third-party player components (HlsPlayer, ReactHlsPlayer, …) are all
    // covered. The browser fetches the resource with GET.
    for (const attr of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
        const attrName = attr.getNameNode().getText();
        if (attrName !== "src" && attrName !== "href")
            continue;
        const initializer = attr.getInitializer();
        if (!initializer)
            continue;
        // value is either a bare string (src="/api/x") or a JSX expression
        // container (src={url} / src={`/api/${id}`})
        let valueNode;
        const initKind = initializer.getKind();
        if (initKind === SyntaxKind.StringLiteral) {
            valueNode = initializer;
        }
        else if (initKind === SyntaxKind.JsxExpression) {
            valueNode = initializer.getExpression();
        }
        if (!valueNode)
            continue;
        const urlResult = extractUrlFromArg(valueNode, sourceFile, project);
        if (!urlResult)
            continue;
        results.push({
            startLine: attr.getStartLineNumber(),
            call: {
                callerType: `jsx-${attrName}`,
                rawUrl: urlResult.rawUrl,
                resolvedUrl: urlResult.resolvedUrl,
                method: "GET",
            },
        });
    }
    // Object-literal src/href properties — config-object style usage where a
    // backend route is passed to a third-party player/function, e.g.
    // loadPlayer({ src: '/api/stream' }). Same GET semantics.
    for (const prop of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        const name = prop.getName();
        if (name !== "src" && name !== "href")
            continue;
        const init = prop.getInitializer();
        if (!init)
            continue;
        const urlResult = extractUrlFromArg(init, sourceFile, project);
        if (!urlResult)
            continue;
        results.push({
            startLine: prop.getStartLineNumber(),
            call: {
                callerType: `prop-${name}`,
                rawUrl: urlResult.rawUrl,
                resolvedUrl: urlResult.resolvedUrl,
                method: "GET",
            },
        });
    }
    return results;
}
//MAIN FUNCTION 
export function detectNextjsApiCallEdges(nodes, repoPath) {
    const edges = [];
    const dedupSet = new Set();
    // Build route index — bail early if no Next.js API routes exist in this repo
    const routeIndex = buildRouteIndex(nodes);
    if (routeIndex.size === 0)
        return [];
    // One shared project instance — source files are added lazily per node
    // so we never load the entire repo into ts-morph upfront
    const project = new Project({
        compilerOptions: {
            allowJs: true,
            checkJs: false,
            strict: false,
        },
        skipAddingFilesFromTsConfig: true,
    });
    // Only scan nodes that:
    //   - are not ROUTE or THIRD_PARTY nodes themselves
    //   - have rawCode (we need the AST, not just metadata)
    const candidateNodes = nodes.filter(n => n.type !== "ROUTE" &&
        n.type !== "THIRD_PARTY" &&
        typeof n.rawCode === "string" &&
        n.rawCode.length > 0);
    // Group candidate nodes by absolute file path so each file is parsed and
    // its AST traversed exactly once — previously every node re-scanned the
    // entire file's call expressions (O(calls × nodes per file)).
    const nodesByFile = new Map();
    for (const node of candidateNodes) {
        const absolutePath = path.resolve(repoPath, node.filePath);
        if (!nodesByFile.has(absolutePath))
            nodesByFile.set(absolutePath, []);
        nodesByFile.get(absolutePath).push(node);
    }
    for (const [absolutePath, fileNodes] of nodesByFile) {
        // Reuse already-loaded file if present, otherwise add it lazily
        let sourceFile = project.getSourceFile(absolutePath);
        if (!sourceFile) {
            try {
                sourceFile = project.addSourceFileAtPath(absolutePath);
            }
            catch {
                continue; // file missing, non-parseable — skip silently
            }
        }
        // Scan the whole file's API calls once, then attribute by line range.
        const locatedCalls = extractApiCallsFromFile(sourceFile, project);
        if (locatedCalls.length === 0)
            continue;
        for (const located of locatedCalls) {
            // Attribute each call to the single innermost node whose line range
            // contains it. Nodes can nest (e.g. a component and an inner function
            // both span the call); without picking the smallest containing range a
            // call would be counted once per containing node, producing duplicate
            // edges with different `from` nodes.
            let owner = null;
            for (const node of fileNodes) {
                if (located.startLine < node.startLine || located.startLine > node.endLine)
                    continue;
                if (owner === null || (node.endLine - node.startLine) < (owner.endLine - owner.startLine)) {
                    owner = node;
                }
            }
            if (owner === null)
                continue;
            const call = located.call;
            const normalizedUrl = normalizeUrl(call.resolvedUrl);
            if (!normalizedUrl)
                continue;
            const matches = matchRouteEntries(normalizedUrl, call.method, routeIndex);
            if (matches.length === 0)
                continue;
            for (const match of matches) {
                // One edge per unique (caller node, route node, method) combination
                const dedupKey = `${owner.id}→${match.routeNode.id}:${call.method}`;
                if (dedupSet.has(dedupKey))
                    continue;
                dedupSet.add(dedupKey);
                edges.push({
                    from: owner.id,
                    to: match.routeNode.id,
                    type: "NEXTJS_API_CALL",
                    metadata: {
                        url: call.resolvedUrl,
                        rawUrl: call.rawUrl,
                        method: call.method,
                        callerType: call.callerType,
                        matchType: match.isDynamic ? "dynamic" : "exact",
                    },
                });
            }
        }
    }
    return edges;
}

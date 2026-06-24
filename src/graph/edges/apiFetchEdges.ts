// This file detects the backend routes of the NEXTjs only

import { Project, SourceFile, SyntaxKind } from "ts-morph";
import { CodeEdge, CodeNode } from "../../types.js";
import path from "node:path";

type CallerConfig = { inferMethod: "fixed", method: string }
    | { inferMethod: "from-options", defaultMethod: string };

interface ApiRouteEntry {
    routeNode: CodeNode;
    urlPath: string;
    httpMethod: string;
    isDynamic: boolean;
    urlRegex: RegExp;
}


const CALLER_CONFIG: Record<string, CallerConfig> = {
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

function urlPathtoRegex(urlPath: string): RegExp {
    const pattern = urlPath.split("/").map(segment => {
        if (segment.startsWith(":") && segment.endsWith("*")) return ".+";   // catch-all :slug*
        if (segment.startsWith(":")) return "[^/]+";     // dynamic :id
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");  // escape static segments
    }).join("\\/");
    return new RegExp(`^${pattern}$`);
}

// Groups Next.js API ROUTE nodes by HTTP method for efficient lookup.
// Each route node carries a concrete method, so it is indexed under that one
// method key. Callers with an UNKNOWN method (e.g. useSWRMutation) are handled
// on the query side in matchRouteEntries by scanning every method bucket.
function buildRouteIndex(nodes: CodeNode[]): Map<string, ApiRouteEntry[]> {
    const index = new Map<string, ApiRouteEntry[]>();

    const apiRouteNodes = nodes.filter(n => n.type === "ROUTE" &&
        n.metadata.routeKind === "nextjs" &&
        n.metadata.routeNodeType === "API_ROUTE" &&
        typeof n.metadata.httpMethod === "string" &&
        typeof n.metadata.urlPath === "string");

    for (const routeNode of apiRouteNodes) {
        const httpMethod = (routeNode.metadata.httpMethod as string).toUpperCase();
        const urlPath = routeNode.metadata.urlPath as string;
        const isDynamic = routeNode.metadata.isDynamic as boolean;

        const entry: ApiRouteEntry = {
            routeNode, urlPath, httpMethod, isDynamic, urlRegex: urlPathtoRegex(urlPath),
        }

        if (!index.has(httpMethod)) index.set(httpMethod, []);
        index.get(httpMethod)!.push(entry);

    }
    return index;
}

/*
Extracts string value from an initializer node.
Handles 3 cases:
  'string literal'           → returns value directly
  `no-substitution template` → returns value directly
  `template ${expr} literal` → preserves ${...} as-is so normalizeUrl handles it later
*/
function resolveVariableValue(initializer: any): string | null {
    const kind = initializer.getKind();
    if (kind === SyntaxKind.StringLiteral) {
        return initializer.getLiteralText();
    }
    if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        return initializer.getLiteralText();
    }
    if (kind === SyntaxKind.TemplateExpression) {
        const head = initializer.getHead().getLiteralText();
        const spans = initializer.getTemplateSpans().map((span: any) =>
            `\${${span.getExpression().getText()}}${span.getLiteral().getLiteralText()}`
        );
        return head + spans.join("");
    }
    return null;     // object, function, computed — can't resolve
}

/*
Resolves a variable name to its string value.
Strategy:
  1. Look in the same file
  2. Walk named imports → find the source file → look there
  Files not yet in the project are added lazily so we don't pre-load everything.
 */
function resolveUrlVariable(varName: string, sourceFile: SourceFile, project: Project): string | null {
    //case 1 -> Variable exists in same file
    const localDecl = sourceFile.getVariableDeclaration(varName);
    if (localDecl) {
        const init = localDecl.getInitializer();
        if (init) return resolveVariableValue(init);
    }

    //case 2 -> named imports
    for (const importDecl of sourceFile.getImportDeclarations()) {
        const match = importDecl.getNamedImports().find(n => n.getName() === varName);
        if (!match) continue;

        // Try to get the source file — it may not be in the project yet
        let importedFile = importDecl.getModuleSpecifierSourceFile();

        if (!importedFile) {
            // Lazily add the file to the project
            const specifier = importDecl.getModuleSpecifierValue();
            const currentDir = path.dirname(sourceFile.getFilePath());
            const base = path.resolve(currentDir, specifier);

            for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
                try {
                    importedFile = project.addSourceFileAtPath(base + ext);
                    break;
                } catch {
                    continue;
                }
            }
        }
        if (!importedFile) continue;

        const importedDecl = importedFile.getVariableDeclaration(varName);
        if (importedDecl) {
            const init = importedDecl.getInitializer();
            if (init) return resolveVariableValue(init);
        }
    }

    return null;
}


//  URL Normalization 

// Converts a raw URL string from the call site into a normalized form
// that can be compared against route index entries.
// Examples:
//   `/api/users/${id}`        → /api/users/:dynamic
//   `/api/users/${org}/${id}` → /api/users/:dynamic/:dynamic
//   /api/users?foo=bar        → /api/users
//   /api/users/               → /api/users
function normalizeUrl(rawUrl: string): string | null {
  // Skip external URLs
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return null;

  // Must start with /
  if (!rawUrl.startsWith("/")) return null;

  return rawUrl
    .split("?")[0]                            // strip query string
    .replace(/\$\{[^}]+\}/g, ":dynamic")     // ${anything} → :dynamic
    .replace(/\/+$/, "")                      // strip trailing slash
    || "/";                                   // fallback to root if empty
}

//  Route Matching 

// Matches a normalized URL + HTTP method against the route index.
// Rules:
//   1. Static routes (isDynamic=false) are matched first using === equality
//   2. Dynamic routes are only tried if no static match found
//   3. UNKNOWN method (useSWRMutation etc.) tries all entries across all methods
function matchRouteEntries(
  normalizedUrl: string,
  method:        string,
  routeIndex:    Map<string, ApiRouteEntry[]>,
): ApiRouteEntry[] {

  // Gather candidate entries for this method
  const candidates: ApiRouteEntry[] = method === "UNKNOWN" ? [...routeIndex.values()].flat(): routeIndex.get(method) ?? [];

  if (candidates.length === 0) return [];

  //  Pass 1: static exact match
  const staticMatches = candidates.filter(
    e => !e.isDynamic && e.urlPath === normalizedUrl
  );
  if (staticMatches.length > 0) return staticMatches;

  //  Pass 2: dynamic regex match
  // normalizeUrl has already turned every interpolated segment into the
  // literal token ":dynamic", which the route regex's [^/]+ (or .+ for
  // catch-alls) matches directly — so testing the normalized URL is enough.
  // e.g. "/api/users/:dynamic" matches the regex for route "/api/users/:id".
  return candidates.filter(e => e.isDynamic && e.urlRegex.test(normalizedUrl));
}




//  URL Argument Extraction 

// Shared helper — reconstructs a template literal preserving ${...} as-is
// so normalizeUrl can replace them with :dynamic later.
// Same logic as resolveVariableValue's TemplateExpression branch.
function reconstructTemplate(templateExpr: any): string {
  const head  = templateExpr.getHead().getLiteralText();
  const spans = templateExpr.getTemplateSpans().map((span: any) =>
    `\${${span.getExpression().getText()}}${span.getLiteral().getLiteralText()}`
  );
  return head + spans.join("");
}

// Extracts a URL string from a call argument.
// Handles 4 cases:
//   '/api/users'          → string literal      → return directly
//   `/api/users`          → no-sub template     → return directly
//   `/api/users/${id}`    → template expression → preserve ${...}
//   API_URL               → identifier          → resolve via resolveUrlVariable
// Returns null if the arg is an object / array / expression we can't resolve.
function extractUrlFromArg(
  arg:        any,
  sourceFile: SourceFile,
  project:    Project,
): { rawUrl: string; resolvedUrl: string } | null {
  const kind = arg.getKind();

  if (kind === SyntaxKind.StringLiteral ||
      kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const url = arg.getLiteralText();
    return { rawUrl: url, resolvedUrl: url };
  }

  if (kind === SyntaxKind.TemplateExpression) {
    const url = reconstructTemplate(arg);
    return { rawUrl: url, resolvedUrl: url };
  }

  if (kind === SyntaxKind.Identifier) {
    const varName  = arg.getText();
    const resolved = resolveUrlVariable(varName, sourceFile, project);
    if (!resolved) return null;
    return { rawUrl: varName, resolvedUrl: resolved };
  }

  return null;
}

//  Core Scanner 

export interface ApiFetchCall {
  callerType:  string;   // "fetch" | "axios.get" | "jsx-src" | "jsx-href" etc.
  rawUrl:      string;   // as written in code — variable name or raw string
  resolvedUrl: string;   // actual url string after variable resolution
  method:      string;   // "GET" | "POST" | ... | "UNKNOWN"
}

// A call extracted from a file, tagged with the line it starts on so it can
// later be attributed to the node whose line range contains it.
interface LocatedApiCall {
  startLine: number;
  call:      ApiFetchCall;
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
function extractApiCallsFromFile(
  sourceFile: SourceFile,
  project:    Project,
): LocatedApiCall[] {
  const results: LocatedApiCall[] = [];

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callerType = call.getExpression().getText();
    const config     = CALLER_CONFIG[callerType];
    if (!config) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    //  Infer HTTP method + extract URL
    let method: string;
    let urlResult: { rawUrl: string; resolvedUrl: string } | null;

    if (callerType === "axios" &&
        args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
      // axios({ url, method }) — both url and method live in the config object.
      // axios defaults to GET when no method is given.
      const cfg     = args[0] as any;
      const urlInit = cfg.getProperty("url")?.getInitializer?.();
      urlResult = urlInit ? extractUrlFromArg(urlInit, sourceFile, project) : null;

      method = "GET";
      const methodInit = cfg.getProperty("method")?.getInitializer?.();
      if (methodInit && methodInit.getKind() === SyntaxKind.StringLiteral) {
        method = (methodInit as any).getLiteralText().toUpperCase();
      }
    } else if (config.inferMethod === "fixed") {
      method    = config.method;
      urlResult = extractUrlFromArg(args[0], sourceFile, project);
    } else {
      method = config.defaultMethod;

      // fetch('/api', { method: 'POST' }) / axios('/api', { method }) — check 2nd arg
      if (args.length >= 2) {
        const optsArg = args[1];
        if (optsArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const methodProp = (optsArg as any).getProperty("method");
          if (methodProp) {
            const init = methodProp.getInitializer?.();
            if (init && init.getKind() === SyntaxKind.StringLiteral) {
              method = (init as any).getLiteralText().toUpperCase();
            }
          }
        }
      }

      urlResult = extractUrlFromArg(args[0], sourceFile, project);
    }

    if (!urlResult) continue;

    results.push({
      startLine: call.getStartLineNumber(),
      call: {
        callerType,
        rawUrl:      urlResult.rawUrl,
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
    if (attrName !== "src" && attrName !== "href") continue;

    const initializer = attr.getInitializer();
    if (!initializer) continue;

    // value is either a bare string (src="/api/x") or a JSX expression
    // container (src={url} / src={`/api/${id}`})
    let valueNode: any;
    const initKind = initializer.getKind();
    if (initKind === SyntaxKind.StringLiteral) {
      valueNode = initializer;
    } else if (initKind === SyntaxKind.JsxExpression) {
      valueNode = (initializer as any).getExpression();
    }
    if (!valueNode) continue;

    const urlResult = extractUrlFromArg(valueNode, sourceFile, project);
    if (!urlResult) continue;

    results.push({
      startLine: attr.getStartLineNumber(),
      call: {
        callerType:  `jsx-${attrName}`,
        rawUrl:      urlResult.rawUrl,
        resolvedUrl: urlResult.resolvedUrl,
        method:      "GET",
      },
    });
  }

  // Object-literal src/href properties — config-object style usage where a
  // backend route is passed to a third-party player/function, e.g.
  // loadPlayer({ src: '/api/stream' }). Same GET semantics.
  for (const prop of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = prop.getName();
    if (name !== "src" && name !== "href") continue;

    const init = prop.getInitializer();
    if (!init) continue;

    const urlResult = extractUrlFromArg(init, sourceFile, project);
    if (!urlResult) continue;

    results.push({
      startLine: prop.getStartLineNumber(),
      call: {
        callerType:  `prop-${name}`,
        rawUrl:      urlResult.rawUrl,
        resolvedUrl: urlResult.resolvedUrl,
        method:      "GET",
      },
    });
  }

  return results;
}

//MAIN FUNCTION 
export function detectNextjsApiCallEdges(
  nodes:    CodeNode[],
  repoPath: string,
): CodeEdge[] {
  const edges:    CodeEdge[] = [];
  const dedupSet  = new Set<string>();

  // Build route index — bail early if no Next.js API routes exist in this repo
  const routeIndex = buildRouteIndex(nodes);
  if (routeIndex.size === 0) return [];

  // One shared project instance — source files are added lazily per node
  // so we never load the entire repo into ts-morph upfront
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      strict:  false,
    },
    skipAddingFilesFromTsConfig: true,
  });

  // Only scan nodes that:
  //   - are not ROUTE or THIRD_PARTY nodes themselves
  //   - have rawCode (we need the AST, not just metadata)
  const candidateNodes = nodes.filter(
    n =>
      n.type !== "ROUTE"       &&
      n.type !== "THIRD_PARTY" &&
      typeof n.rawCode === "string" &&
      n.rawCode.length > 0
  );

  // Group candidate nodes by absolute file path so each file is parsed and
  // its AST traversed exactly once — previously every node re-scanned the
  // entire file's call expressions (O(calls × nodes per file)).
  const nodesByFile = new Map<string, CodeNode[]>();
  for (const node of candidateNodes) {
    const absolutePath = path.resolve(repoPath, node.filePath);
    if (!nodesByFile.has(absolutePath)) nodesByFile.set(absolutePath, []);
    nodesByFile.get(absolutePath)!.push(node);
  }

  for (const [absolutePath, fileNodes] of nodesByFile) {
    // Reuse already-loaded file if present, otherwise add it lazily
    let sourceFile = project.getSourceFile(absolutePath);
    if (!sourceFile) {
      try {
        sourceFile = project.addSourceFileAtPath(absolutePath);
      } catch {
        continue; // file missing, non-parseable — skip silently
      }
    }

    // Scan the whole file's API calls once, then attribute by line range.
    const locatedCalls = extractApiCallsFromFile(sourceFile, project);
    if (locatedCalls.length === 0) continue;

    for (const located of locatedCalls) {
      // Attribute each call to the single innermost node whose line range
      // contains it. Nodes can nest (e.g. a component and an inner function
      // both span the call); without picking the smallest containing range a
      // call would be counted once per containing node, producing duplicate
      // edges with different `from` nodes.
      let owner: CodeNode | null = null;
      for (const node of fileNodes) {
        if (located.startLine < node.startLine || located.startLine > node.endLine) continue;
        if (owner === null || (node.endLine - node.startLine) < (owner.endLine - owner.startLine)) {
          owner = node;
        }
      }
      if (owner === null) continue;

      const call          = located.call;
      const normalizedUrl = normalizeUrl(call.resolvedUrl);
      if (!normalizedUrl) continue;

      const matches = matchRouteEntries(normalizedUrl, call.method, routeIndex);
      if (matches.length === 0) continue;

      for (const match of matches) {
        // One edge per unique (caller node, route node, method) combination
        const dedupKey = `${owner.id}→${match.routeNode.id}:${call.method}`;
        if (dedupSet.has(dedupKey)) continue;
        dedupSet.add(dedupKey);

        edges.push({
          from: owner.id,
          to:   match.routeNode.id,
          type: "NEXTJS_API_CALL",
          metadata: {
            url:        call.resolvedUrl,
            rawUrl:     call.rawUrl,
            method:     call.method,
            callerType: call.callerType,
            matchType:  match.isDynamic ? "dynamic" : "exact",
          },
        });
      }
    }
  }

  return edges;
}
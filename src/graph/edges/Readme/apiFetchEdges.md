# apiFetchEdges.ts

This is the newest and most complex edge detector, so — like `stateEdges` — it gets its
own readme.

Detects `NEXTJS_API_CALL` edges from any node that makes an HTTP call
(`fetch`, `axios`, `useSWR`, …) to the **Next.js API route** that actually serves it.

```typescript
// app/components/UserCard.tsx
fetch(`/api/users/${id}`)        ──NEXTJS_API_CALL──▶  app/api/users/[id]/route.ts (GET)
axios.post("/api/orders", body)  ──NEXTJS_API_CALL──▶  app/api/orders/route.ts    (POST)
```

It only fires for repos that have Next.js API routes — if `buildRouteIndex` finds none,
the detector returns `[]` immediately.

---

## The problem it solves

A call site writes a *string* (`/api/users/${id}`); a route is a *file path*
(`app/api/users/[id]/route.ts`). To connect them we have to:

1. find every HTTP call in the code and figure out its URL + method,
2. normalize that URL into a comparable shape,
3. match it against an index of known routes — including dynamic segments.

Each step has edge cases (template literals, URL variables, `axios` config objects,
catch-all routes), which is what makes this file large.

---

## Recognised callers

`CALLER_CONFIG` is the allow-list of call expressions we treat as HTTP requests, and how
each infers its method:

| Caller | Method inference |
|--------|------------------|
| `fetch` | `from-options` — default `GET`, overridden by `{ method }` in the 2nd arg |
| `axios.get/post/put/delete/patch` | `fixed` — verb baked in |
| `axios(...)` | `from-options` — `GET`, or `{ url, method }` config object |
| `useSWR` | `fixed` `GET` |
| `useSWRMutation` | `fixed` `UNKNOWN` (method unknown → matched against all method buckets) |

`useQuery` / `useMutation` / `useSuspenseQuery` are **intentionally omitted** — their
first arg is a query-key array or options object, never a URL. The real request they fire
is the inner `fetch`/`axios` call, which is captured on its own as a `CallExpression`.

---

## Pipeline

```
buildRouteIndex(nodes)                 group API ROUTE nodes by HTTP method
  └─ empty? → return []                no routes → nothing to match

group candidate nodes by file          parse each file's AST exactly once

For each file:
  extractApiCallsFromFile()            find CALLER_CONFIG calls → {url, method, line}
  for each call:
    attribute to innermost node        smallest line-range node containing the call
    normalizeUrl(resolvedUrl)          → comparable path, or skip
    matchRouteEntries(url, method)     static-exact first, then dynamic regex
    dedup by (caller, route, method)   one edge per unique combination
```

### 1. URL extraction (`extractUrlFromArg`)
Handles four argument shapes:
- `'/api/users'` string literal → used directly
- `` `/api/users` `` no-substitution template → used directly
- `` `/api/users/${id}` `` template expression → `${...}` preserved for `normalizeUrl`
- `API_URL` identifier → resolved via `resolveUrlVariable`

`resolveUrlVariable` looks the variable up in the same file first, then walks named
imports to the source file (adding it to the project lazily). Objects, arrays and
computed expressions return `null` → the call is skipped.

### 2. URL normalization (`normalizeUrl`)
```
/api/users/${id}        → /api/users/:dynamic
/api/users/${o}/${id}   → /api/users/:dynamic/:dynamic
/api/users?foo=bar      → /api/users          (query stripped)
/api/users/             → /api/users          (trailing slash stripped)
https://x.com/api       → null                (external, skipped)
relative/path           → null                (must start with /)
```

### 3. Route matching (`matchRouteEntries`)
- **Pass 1 — static exact:** non-dynamic routes compared with `===`. Wins if found.
- **Pass 2 — dynamic regex:** dynamic routes' regexes test the normalized URL. The
  `:dynamic` token slots straight into the route regex's `[^/]+` (or `.+` for catch-alls
  built by `urlPathtoRegex`).
- **`UNKNOWN` method** (`useSWRMutation`): candidates are gathered across *all* method
  buckets instead of one.

---

## Why one AST pass per file

Each file is parsed once and its calls attributed to nodes **by line range**, rather than
re-scanning the file for every node. A call is assigned to the *innermost* node whose
`[startLine, endLine]` contains it (smallest range wins) — otherwise a call nested inside
both a component and an inner function would emit duplicate edges with different `from`
nodes. Source files are added to the shared ts-morph `Project` lazily, so the whole repo
is never loaded up front.

---

## Output

```typescript
{
  from: "app/components/UserCard.tsx::UserCard",
  to:   "app/api/users/[id]/route.ts::GET",
  type: "NEXTJS_API_CALL",
  metadata: {
    url:        "/api/users/${id}",   // resolved URL as analyzed
    rawUrl:     "/api/users/${id}",   // as written (variable name if it was a var)
    method:     "GET",
    callerType: "fetch",
    matchType:  "dynamic",            // "exact" | "dynamic"
  }
}
```

Edges are de-duplicated on `(callerNode, routeNode, method)`, so the same call repeated
in a component produces a single edge.

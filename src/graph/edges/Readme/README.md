# Edge Detectors

This folder holds every edge detector. Each detector takes the extracted `CodeNode[]`
(plus the `LookupMaps` and/or `repoPath`) and returns `CodeEdge[]` describing a typed
relationship between two nodes. The pipeline runs them all in `../index.ts` and merges
the results into one `allEdges` array.

Most detectors are self-explanatory from their source. The two that aren't —
because they carry the most logic — have their own deep-dive docs:

- [stateEdges.md](./stateEdges.md) — `READS_FROM` / `WRITES_TO` state-store detection across Zustand/Redux/Context/Recoil/Jotai.
- [apiFetchEdges.md](./apiFetchEdges.md) — `NEXTJS_API_CALL` matching of `fetch`/`axios`/`useSWR` call sites to Next.js API routes.

---

## All edge types at a glance

| File | Detector | Edge type(s) | From → To |
|------|----------|--------------|-----------|
| `callEdges.ts` | `detectCallEdges` | `CALLS`, `USES` | function/hook/component → local node or third-party node |
| `importEdges.ts` | `detectImportEdges` | `IMPORTS` | file node → file node or third-party package/method node |
| `hookEdges.ts` | `detectHookEdges` | `CALLS` *(isHookCall)* | component/hook/function → HOOK |
| `stateEdges.ts` | `detectStateEdges` | `READS_FROM`, `WRITES_TO` | component/hook → state store |
| `propEdges.ts` | `detectPropEdges` | `PROP_PASS`, `WRITES_TO` | component → rendered component / context store |
| `eventEdges.ts` | `detectEventEdges` | `EMITS`, `LISTENS` | function ↔ event ghost node |
| `routeEdge.ts` | `detectRouteEdges` | `HANDLES` | ROUTE → handler node |
| `guardEdges.ts` | `detectGuardEdges` | `GUARDS` | middleware node → guarded route path |
| `testEdges.ts` | `detectTestEdges` | `TESTS` | TEST/STORY file → production node |
| `apiFetchEdges.ts` | `detectNextjsApiCallEdges` | `NEXTJS_API_CALL` | caller node → Next.js API ROUTE |

`utils.ts` is shared, not a detector — it exposes `closestByPath`, the tie-breaker that
picks the candidate whose file path shares the most leading segments with a reference
path (used when several nodes share a name).

---

## Run order matters

`detectImportEdges` **must** run before `detectCallEdges`. Beyond producing `IMPORTS`
edges it populates `lookupMp.thirdPartyImportAliases` as a side effect (local alias →
third-party node id, per file). `detectCallEdges` reads that map to resolve third-party
`CALLS` edges, so the ordering in `../index.ts` is load-bearing — don't reorder them.

The remaining detectors are independent and can run in any order.

---

## Detector notes

### callEdges.ts → `CALLS` / `USES`
Walks `metadata.calls` / `metadata.uses` on function/hook/component nodes. `calls`
produces `CALLS`; `uses` produces `USES` (JSX referencing an external function). For
third-party member access like `axios.get` it lazily mints a per-method `THIRD_PARTY`
node (`[npm]/axios::get`) and returns those in `newThirdPartyNodes`. Local hook-to-hook
calls are intentionally skipped here — `hookEdges.ts` owns those.

### importEdges.ts → `IMPORTS`
Walks every file's import declarations via ts-morph. Local imports become file→file
`IMPORTS` edges. Third-party named imports each get their own method node
(`[npm]/react::useState`); default/namespace imports point at the package node. Aliases
are recorded in `thirdPartyImportAliases` for `callEdges` to consume.

### hookEdges.ts → `CALLS` *(isHookCall: true)*
Connects components/hooks/functions to the custom `HOOK` nodes they call (names starting
with `use`). Reuses the `CALLS` type but tags `metadata.isHookCall` so it's
distinguishable from a plain function call. Exists because `callEdges` deliberately skips
hook names.

### stateEdges.ts → `READS_FROM` / `WRITES_TO`
The most involved state detector — see [stateEdges.md](./stateEdges.md).

### propEdges.ts → `PROP_PASS` / `WRITES_TO`
Scans JSX inside each component's line range. Rendering `<Child foo={...}/>` yields a
`PROP_PASS` edge carrying the prop names and a `renderCount` (incremented on repeat
renders). `<Ctx.Provider>` is special-cased to a `WRITES_TO` edge into the matching
context store.

### eventEdges.ts → `EMITS` / `LISTENS`
Detects `dispatchEvent(new CustomEvent(...))` / `.emit` (emitters) and
`addEventListener` / `.on` / `.once` (listeners). Because the two sides usually live in
different files, each event name gets a synthetic **ghost node** (`ghost::event:<name>`)
that both sides connect to: emitter → ghost (`EMITS`), ghost → listener (`LISTENS`).
Ghost nodes are returned alongside the edges so the pipeline can add them to the graph.

### routeEdge.ts → `HANDLES`
Links a `ROUTE` node to the code that handles it. Resolution differs per route kind:
backend routes resolve by `handlerName` (inline handler id first, then same-file, then
by-name); Next.js API routes match the same-file node flagged `isHttpHandler` for the
method; Next.js pages/layouts resolve to the file's default export. Unresolved routes are
left edge-less on purpose (useful for "unconnected entry point" analysis).

### guardEdges.ts → `GUARDS`
Security-relevant. For Next.js it parses `export const config = { matcher: [...] }` in
`middleware.ts` and links the middleware node to every route whose path the matcher
covers. For Express/Fastify/Koa it parses `app.use(...)` / `router.use(...)` calls,
extracting the optional path prefix and middleware name, then guards matching backend
routes. Which branches run is gated on the project `fingerprint`.

### testEdges.ts → `TESTS`
For each `TEST` / `STORY` file node, resolves its local named imports back to the
production component/function/hook nodes they import and emits a `TESTS` edge. Skips
third-party imports and test-importing-test cases.

### apiFetchEdges.ts → `NEXTJS_API_CALL`
The newest and most complex detector — see [apiFetchEdges.md](./apiFetchEdges.md).

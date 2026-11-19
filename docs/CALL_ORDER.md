# Call order (`callOrder/v1`)

Status: **spec frozen — implementation in progress.**
Scope: all five extractors (TypeScript/JavaScript inline, Python, Java, Go, Rust).

This document is the contract. The extractors, the edge detectors, both MCP servers
and the UIs all read it. If an implementation and this document disagree, the
implementation is wrong.

---

## 1. Why

The graph already answers *"what does `run()` call?"*. It cannot answer *"which call
happens first?"* — three independent things erased that information:

1. `metadata.calls` is a de-duplicated `string[]` with no position.
2. `metadata.callSites` is de-duplicated by `(name, argCount, argTypes)`.
3. Edges are de-duplicated by `(from, to, type)`, so N call sites to one target
   collapse into one edge.

This spec restores the order **without changing edge identity** (that identity is the
primary key of `commit_edges` and `edge_versions`).

### Non-goals

- No runtime trace, no performance claim, no "this will execute exactly in this order".
- No whole-program sequence (entry → A → B). Ordering is always **within one owner node**.
- No dynamic dispatch / DI / reflection / pub-sub / string-based routing resolution.
- No renumbering across a suspension or detachment point. Flags say what the number can
  and cannot mean; the number itself never pretends.

---

## 2. Definitions

### `order`

A **1-based, monotone lexical rank over every recorded call site of one owner node**
(`FUNCTION`, `HOOK`, `COMPONENT`, `METHOD`, `FILE`). Assigned in AST traversal order,
which for all five extractors is pre-order = source order.

- Hooks, third-party calls and unresolved calls all consume an ordinal. If
  `fetchA(); saveLocal(); fetchB()` numbers only the local callees the result is wrong.
- The same call site shape appearing twice gets **two records** and two ordinals.
- Comprehension of the number: *"call site #n of this node in source order"*.

### `nested`

When a call expression sits inside another call expression (`foo(bar())`), `bar.nested`
is `foo.order`. A consumer can then render `2.1` ("`bar` is evaluated first") or a flat
reading order, without the engine asserting runtime semantics.

### `scope`

| value | meaning | `order` still assigned |
|---|---|---|
| `inline` | runs in the frame body (render body, normal execution) | yes |
| `callback` | inside a callback/closure passed to a call (timer, promise, hook, iteration combinator) | yes |
| `handler` | inside a JSX attribute expression (`onClick={…}`) or another externally-triggered registration | yes |
| `nested` | inside a function declared inside the body (that has no node of its own) | yes |
| `module` | `FILE` node: executed at module load | yes |

`order` is assigned to all of them; `scope` decides which are on the straight-line path.
Consumers that want a clean sequence filter `scope === "inline"`.

### `awaited`

The call expression is the operand of `await` (TS/JS, Python, Rust). The frame suspends
on it; later ordinals resume after it settles.

### `defer` — *when* the call runs relative to the frame

| value | meaning |
|---|---|
| `timer` | macrotask: `setTimeout`, `setInterval`, `loop.call_later`, `time.AfterFunc`, `threading.Timer`, `ScheduledExecutorService.schedule*` |
| `promise` | continuation: `.then/.catch/.finally`, `new Promise(exec)`, `CompletableFuture.*Async`/`thenApply*`, `asyncio.create_task`/`ensure_future`/`gather` members, `tokio::spawn` |
| `microtask` | `queueMicrotask`, `process.nextTick`, `setImmediate` |
| `event` | externally triggered, possibly never, possibly many times: `addEventListener`/`.on`/`.once`, JSX handlers, signal handlers |
| `postRender` | framework commit-phase lifecycle: `useEffect`, `useLayoutEffect`, `useInsertionEffect`, Vue `onMounted`/`watchEffect`, Svelte `onMount`, Angular `ngAfterViewInit`, `@PostConstruct` |
| `onReturn` | at frame exit, **LIFO**: Go `defer`, `finally` blocks, Rust `Drop` |
| `unknown` | reserved: a position known to be detached whose scheduler cannot be named. A plain callback argument is NOT this: most helpers call it synchronously, so it stays `scope: callback` with no `defer` |

Absent `defer` = **no evidence of detachment**, *not* a guarantee of inline execution.

### `conc` — *can* it run at the same time

Dispatched to another thread/task/goroutine: `new Thread`, `ExecutorService.submit|execute`,
`parallelStream`, Go `go` statement, `thread::spawn`, `tokio::spawn`, `rayon`, `asyncio.to_thread`,
`run_in_executor`, and the members of `Promise.all`/`asyncio.gather` (invocation order is
lexical, completion order is not).

`conc` is orthogonal to `defer`: `go f()` is **not deferred** (it starts now) but **is**
concurrent.

### `repeat`

May execute 0..N times: inside a loop body, or inside a synchronous iteration callback
(`map/forEach/filter/reduce/some/every/find/sort/flatMap`, Python comprehensions,
Java `for`/`stream().forEach`, Go `range` body, Rust iterator closures).

### `maybe`

May execute 0 times: inside `if`/`else`, ternary, `&&`/`||`/`??` short-circuit,
`switch` case, `catch` block, optional chain.

### `earlyExit`

The call's result can abort the remaining calls in the block. v1: Rust `?` on the call
only (`Expr::Try`). Calls inside a `try` body are **not** `maybe` — they do run; it is the
calls *after* a throwing statement that may not.

### `deferDetail`

Free-form provenance for the scheduler symbol (`"tokio::spawn"`, `"ExecutorService.submit"`,
`"useEffect"`). Absorbs library-specific growth so the `defer` enum stays small.

### `kind`

`"call"` (default) or `"hook"`. Hooks are recorded in the flow (needed for
`useSWR`/`useQuery` ordering and React's Rules of Hooks) but are **excluded** from
`metadata.calls`, exactly as today.

---

## 3. Data shapes

All fields are **optional**. A graph analyzed by an older engine simply lacks them and
every consumer must fall back to today's behaviour.

### 3.1 Caller node metadata (the truth)

```ts
metadata.callSites: CallSite[]      // one record per occurrence, ordered by `order`
metadata.calls: string[]            // UNCHANGED shape and set; now ordered; kind==="call" only
metadata.resolvedCalls: ResolvedCall[]
```

```ts
interface CallSite {
  name: string;
  argCount: number;
  argTypes?: string[];
  hasSpread?: boolean;
  // callOrder/v1
  kind?: "call" | "hook";
  order?: number;
  line?: number;
  col?: number;
  nested?: number;
  scope?: "inline" | "callback" | "handler" | "nested" | "module";
  awaited?: boolean;
  defer?: "timer" | "promise" | "microtask" | "event" | "postRender" | "onReturn" | "unknown";
  deferDetail?: string;
  conc?: boolean;
  repeat?: boolean;
  maybe?: boolean;
  earlyExit?: boolean;
}

interface ResolvedCall {
  name: string;          // DECLARATION name the edge points at
  nodeId: string;
  firstOrder?: number;   // order of the first occurrence that resolved here
  line?: number;         // line of that occurrence
  // markers of that first occurrence (booleans only when true)
  defer?: DeferKind; deferDetail?: string; awaited?: boolean;
  conc?: boolean; repeat?: boolean; maybe?: boolean;
  orders?: number[];     // every position that reached this target, only when > 1
}

This shape is identical in all five extractors: the TypeScript detector and the
`calls.*` resolvers of Python, Go, Java and Rust all write the same fields.
```

`resolvedCalls` is de-duplicated by `nodeId` (as today); the complete per-occurrence truth
is `callSites`.

### 3.2 Edge metadata (structure only, no ordering)

**Edges never carry ordering.** An edge set is a set `(from, to, type)`; a call order is a
sequence over occurrences. The two have different cardinality (`a(); b(); a();` is three
occurrences but two edges), so the sequence lives on the node and the edge stays structural.

```ts
edges[]: (from, to, type) + provenance metadata (calledName, matchedBy, route fields)
nodes[].metadata.resolvedCalls[]: firstOrder, line, orders?   ← the only ordering source
```

The TS detector used to also write `firstCallOrder` / `callOrder` (and `firstRenderOrder` /
`renderOrders` on `PROP_PASS`) as a convenience mirror. Nothing read it, it duplicated the
node copy, and it was a second source of truth for the same number, so it was removed. A
guard test in `callOrder.test.ts` fails if it is ever reintroduced.

Deriving order for any edge is one map build per graph, in memory:

```ts
calleeOrder: Map<callerId, Map<targetId, { order, line, orders? }>>   // from resolvedCalls
```

---

## 4. Detection rules (per language)

Rule of thumb: **the set of call sites must not change** — only metadata is added.
Anything that is not a call site today must not become one.

### 4.1 Not call sites (must stay out)

| construct | TS/JS | Java | note |
|---|---|---|---|
| `new X()` | `NewExpression` | `ObjectCreationExpr` | excluded today, excluded in v1 |
| IIFE `(function(){…})()` | callee is an inline function | n/a | exclude the wrapper call |
| `tag\`…\`` | `TaggedTemplateExpression` | n/a | |
| decorators / annotations | `@dec` | `@Ann` | |
| method references | n/a | `Foo::bar` | |
| macros | n/a | n/a | Rust `println!()` is not `Expr::Call` |

Python `Foo()` and Go `Foo()`, Rust `Foo::new()` **are** ordinary calls and are already
recorded today — keep them.

### 4.2 Flag detection

| flag | TS/JS | Python | Java | Go | Rust |
|---|---|---|---|---|---|
| `awaited` | `AwaitExpression` parent | `ast.Await` | — | — | `Expr::Await` |
| `defer:timer` | `setTimeout/setInterval` | `loop.call_later/call_at`, `threading.Timer` | `Timer`, `schedule*` | `time.AfterFunc`, `time.Tick` | `tokio::time::*` |
| `defer:promise` | `.then/.catch/.finally`, `new Promise(exec)` | `create_task`, `ensure_future`, `gather` | `CompletableFuture.*` | — (channels are waits) | `tokio::spawn` |
| `defer:microtask` | `queueMicrotask`, `process.nextTick`, `setImmediate` | — | — | — | — |
| `defer:event` | `addEventListener/on/once`, JSX attrs | signal handlers | listeners | channel consumer | — |
| `defer:postRender` | `useEffect/useLayoutEffect/useInsertionEffect` | — | `@PostConstruct` | — | — |
| `defer:onReturn` | `finally` (cleanup call) | `finally` | `finally` | `defer` stmt | `Drop` |
| `conc` | `new Worker`, `Promise.all` members | `Thread`, executors, `to_thread`, `gather` | `new Thread`, `submit/execute`, `parallelStream`, `ForkJoinPool` | `go` stmt | `thread::spawn`, `tokio::spawn`, `rayon` |
| `repeat` | loop ancestors; sync iteration callbacks | loops, comprehensions | loops, `stream().forEach` | `range` body | loops, iterator closures |
| `maybe` | `if/else`, `?:`, `&&/||/??`, `case`, `catch`, `?.` | `if/else`, `IfExp`, `and/or`, `except` | `if/else`, `?:`, `catch` | `if/else/switch` | `if/else/match` |
| `earlyExit` | — | — | — | — | `?` (`Expr::Try`) |

### 4.3 Scope detection

- `callback`: nearest enclosing function-like that is **not** the owner and is passed as
  an argument (or is a lambda/closure expression being registered).
- `handler`: TS/JS only — ancestor chain contains a `JsxAttribute`/`JsxExpression` inside a
  `JsxOpeningElement`/`JsxSelfClosingElement` attribute (not children).
- `nested`: nearest enclosing function-like that is a declaration or a variable
  initializer inside the owner.
- `module`: owner is a `FILE` node.
- `inline`: none of the above.

---

## 5. Invariants (build-breaking)

1. **Edge key set is unchanged.** For every fixture repo, `{(from,to,type)}` must be
   identical to the previous engine version. Only `metadata` may grow.
2. **`metadata.calls` set is unchanged** (its *order* may improve). One documented
   exception: an IIFE wrapper `(() => {…})()` is no longer recorded as a call name.
   It was never resolvable and produced no edge (`moduleScope` already excluded it, so
   the two code paths disagreed). Verified edge-neutral, see §9.
3. `order` values per node are contiguous `1..N`, unique, and monotone with `(line, col)`.
4. `nested`, when present, is an existing `order` of the same node and `< order`.
5. `resolvedCalls[i].firstOrder` equals the smallest `callSites[].order` with that `nodeId`.
6. no edge metadata carries an ordering key (`firstCallOrder`, `callOrder`,
   `firstRenderOrder`, `renderOrders`)
7. Nothing touches `rawCode`, scoring, summarisation or embeddings.

---

## 6. Conformance matrix (tests must cover these)

Shared semantics; per-language applicability noted. Every extractor test asserts the
`order` sequence, not just presence.

**Ordering**
1. sequential `a(); b(); c()` → 1,2,3
2. same target twice `a(); b(); a()` → 3 records, orders 1,2,3
3. same name, different arity `f(1); f(1,2)` → 2 records
4. nested `foo(bar())` → `foo.order < bar.order`, `bar.nested === foo.order`
5. deep nesting `a(b(c()))` → chain of `nested`
6. no calls → empty `callSites`
7. self-recursion `f() { f() }` → 1 record
8. calls inside `if`/`for`/`try` blocks stay in lexical order
9. two statements on one line → distinct `col`, orders 1,2
10. multi-line call arguments → order follows source position
11. default parameter calls `f(x = g())` → recorded, `scope: inline` (TS/Py)
12. IIFE body calls are recorded; the IIFE wrapper itself is not a site (TS)
13. optional chain `a?.b()` is a call (TS)

**Hooks**
14. hook recorded with `kind:"hook"`, absent from `metadata.calls`
15. hooks interleaved with plain calls keep one sequence

**Scope**
16. component render body → `inline`
17. JSX `onClick={() => f()}` → `handler` + `defer:"event"`
18. `useEffect(() => f())` → `callback` + `defer:"postRender"`
19. inner `function h(){ f() }` → `nested`
20. `items.map(x => f(x))` → `callback` + `repeat`
21. module-scope call on a `FILE` node → `scope:"module"`

**Async**
22. `await f()` → `awaited`
23. `setTimeout(() => f(), 0)` → `timer` + `callback`
24. `p.then(() => f())` → `promise`
25. `queueMicrotask(() => f())` → `microtask`
26. `addEventListener('x', () => f())` → `event`
27. `Promise.all([a(), b()])` → both `conc`
28. `if (x) f()` → `maybe`; `for (…) f()` → `repeat`
29. Go `defer f()` → `onReturn`; `go f()` → `conc`
30. Rust `f()?` → `earlyExit`; `x.await` → `awaited`
31. Python `asyncio.create_task(f())` → `promise`+`conc`; `Thread(target=f)` → `conc`
32. Java `CompletableFuture.supplyAsync(f)` → `promise`+`conc`; `executor.submit(f)` → `conc`

**Invariants**
33. `metadata.calls` set equals the pre-change reference per fixture
34. edge key set equals the pre-change reference per fixture
35. `order` contiguity/uniqueness/monotonicity
36. `resolvedCalls.firstOrder` = min matching `callSites.order`
37. edge metadata carries no ordering keys, for any edge type

**Cross-language parity**
38. one equivalent program in all five languages → identical `order` sequence over the
    language-neutral subset (sequential, duplicate target, nested, branch, loop, await)

---

## 7. Storage & deploy

- **Node metadata is the single source of truth.** It is keyed by
  `(graph_id, node_id, code_hash)` in the cloud, so ordering is per-commit-correct for free.
- **OSS**: nothing to do — `storage.getGraph()` already returns full node + edge metadata
  in one JSON payload.
- **Cloud**: two edits, **no migration, no new column**:
  1. `graphPersistHelpers.edgeVersionFields` strips `firstCallOrder` / `callOrder` /
     `firstRenderOrder` / `renderOrders` before staging. The engine no longer emits them, so
     this is now ingress sanitation for graphs pushed by pinned older CLIs rather than a
     load-bearing step. It must stay while older engines are in circulation, because
     `edge_versions` is last-write-wins per graph and a drifting ordinal would churn `row_sha`.
  2. `getLightNodeVersionsByCommit` adds `nv.metadata->'resolvedCalls' as call_order`
     (a slice, not the whole blob).
- Consumers assemble in a single pass: for each edge, look up the caller's
  `resolvedCalls` by `nodeId`. O(N + E), no index required.
- Old graphs (analysed before this engine) have no `order`; every consumer renders exactly
  as today. `decideCommitGate` re-analyses on the engine-version bump, which populates it.

---

## 8. Version marker

`callOrder/v1`. A graph carries the feature when `callSites[0].order` is defined.

---

## 9. Per-language gaps (v1)

These are deliberate. Every one of them is pre-existing graph behaviour that
callOrder does not change.

| Language | Gap | Reason |
|---|---|---|
| Python | default-parameter calls (`def f(x = g())`) are not call sites | `_walk_scope` never walked the signature; adding them would grow the call-site set and emit new edges |
| Python | calls inside nested `def`/`lambda` are not call sites | same: those regions are skipped by the scope rule |
| Python | `scope` reaches only `inline` and `module`; `defer:unknown` is unreachable | every Python callback site is inside a skipped lambda/nested def (follows from the two rows above) |
| Java / Go / Rust / Python | still emit `defer:"unknown"` for an unclassifiable callback argument | matches the pre-v1 behaviour those extractors shipped with; TS dropped that fallback because ~20% of resolved calls were falsely marked detached. v2 aligns them |
| Rust | no `handler`/`module` scope values | no JSX, and FILE nodes carry no call sites |
| Java | no `awaited`/`earlyExit` | no `await`/`?` in the language |
| JS/TS | `new X()` is not a call site | `NewExpression`, excluded before and after v1 |
| JS/TS | macro-like tagged templates are not call sites | not `CallExpression` |

No edge carries an ordering key, for any edge type. Third-party callees are nodes too, so
their ordinal is written into the caller's `resolvedCalls` like any other target.

---

## 10. Verification record (v1)

Run against the pre-callOrder engine (70e6fc5) and the current branch, same corpora.
Edge key set and `metadata.calls` set must match; only `callSites` may grow.

| Language | Corpus | Edges | Edge key hash | calls hash | callSites old → new |
|---|---|---|---|---|---|
| TS/JS | DevLens OSS | 1647 | identical | 1 node (IIFE wrapper, §5.2) | 3824 → 7233 |
| Go | chi | 926 | identical | identical | 899 → 1145 |
| Java | spring-petclinic | 152 | identical | identical | 186 → 216 |
| Rust | axum | 967 | identical | identical | 6328 → 7131 |
| Python | flask | 404 | identical | identical | 1097 → 1252 |

Test suites: 609 engine tests pass (`bun test`), including per-language conformance
(`*‑callorder.test.ts`), edge projection (`callOrder.test.ts`), and the five-language
parity fixture (`order-parity.test.ts`).

### Cost, measured on DevLens OSS (1139 nodes, 1647 edges, 7233 call sites)

| | before | after | delta |
|---|---|---|---|
| analysis wall time (warm) | 5425 ms | 5612 ms | +3.5% |
| `callSites` records | 3824 | 7233 | occurrence-level |
| serialized node metadata | 1014 KB | 1949 KB | +92% |
| serialized nodes payload | 2497 KB | 3432 KB | +37% |

Known reduction levers if the cloud ingest shows pressure (none applied in v1): omit
`kind` when `"call"` and `scope` when `"inline"` (both have documented defaults), and
omit empty `argTypes`. Together they cut roughly a fifth of the growth at the cost of a
shape change consumers would have to default on.

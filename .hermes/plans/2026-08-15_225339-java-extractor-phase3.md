# Phase 3 — Java Extractor for DevLens Engine

**Date:** 2026-08-15 · **Branch:** devlens-expand · **Status:** DRAFT (awaiting Shivang's verification)
**Pattern source:** devlens-extractor-playbook (proven on Python Phase 2 — complete, 3 real repos verified)

---

## 1. Goal

Build `extractors/java/` — a native Java extractor that reads a repo over stdin (`{"repoPath", "options"}`) and emits the full DevLens graph over stdout: **fingerprint + nodes + edges + routes + stats + errors**. The orchestrator registry entry already exists (`src/extractors/index.ts:26` → `java -jar devlens_java_extractor.jar`) — Phase 1 wired it, we just build the jar it points to. Java is the **hardest of the 4 languages** (type-solver setup + biggest framework surface), so the plan is deliberately stepwise with verification after every step.

## 2. Current state (verified this session)

| Item | State |
|---|---|
| Registry | ✅ `java` entry exists in `src/extractors/index.ts` (command `java`, args `-jar devlens_java_extractor.jar`) |
| `extractors/java/` | ❌ doesn't exist — greenfield |
| JDK | ✅ OpenJDK 21 (Temurin) at `/home/shivang/jdk-21.0.11+10`, `java`/`javac` on PATH |
| Maven / Gradle | ❌ NOT installed (`mvn`/`gradle` not found) |
| Engine tests | 324 passing, build clean (Python phase didn't regress anything) |

**⚠️ Integration finding:** `runner.ts:64` spawns subprocesses with `cwd: input.repoPath` (the analyzed repo). Python works because the module is **installed** in the venv (importable from any cwd). A jar has no "install" — `java -jar devlens_java_extractor.jar` with cwd=repoPath will fail. **Phase 3 needs one tiny engine tweak:** resolve the jar to an absolute path in the registry (3 lines, exact code below). This is the only engine change Java needs.

## 3. Key design decisions

1. **Build tool: fat JAR via `build.sh`, no Maven/Gradle.** Maven/Gradle aren't installed; installing Maven adds a system dep for one project. Instead: `build.sh` downloads 3 jars from Maven Central (javaparser-core, javaparser-symbol-solver-core, gson — JavaParser is the de-facto standard, SonarQube/SpotBugs use it), compiles `src/` with `javac --release 17`, and merges everything into ONE `devlens_java_extractor.jar` (fat jar). Result: `java -jar` works standalone, same "single artifact" pattern as the Go/Rust static binaries. Works headless in the Cloud Docker image too. *(Alternative if he prefers standard tooling: `dnf install maven` + proper pom.xml — say the word.)*
2. **JSON: Gson** (tiny ~280KB jar, the pragmatic choice; hand-rolling JSON is error-prone).
3. **TypeSolver (V1 — skip dependency-jar resolution):** `CombinedTypeSolver(ReflectionTypeSolver(), JavaParserTypeSolver(src/main/java), JavaParserTypeSolver(src/test/java))`. Reflection covers JDK types; JavaParser covers project sources. Spring/external classes stay **unresolved** (`Optional.empty()`) — route detection is annotation-driven (name-based on the AST, same tier as Python decorators), so this is fine for V1. Full classpath resolution (Maven dependency:build-classpath) = V2.
4. **Third-party id: `[mvn]/<package-prefix>`** — e.g. `[mvn]/org.springframework`, `[mvn]/com.fasterxml.jackson`; member form `[mvn]/org.springframework::RestTemplate`. This mirrors Python's `[pip]/<top-level-name>` (node key = import name, not distribution name). JDK packages (`java.*`, `javax.*`, `jdk.*`, `sun.*`, `com.sun.*`, `org.w3c.*`, `org.xml.*`) are skipped like stdlib. *(Playbook table says `[mvn]/g:a` — flagging the deviation: g:a keys would force import→artifact resolution at every import, which needs the classpath we're deliberately skipping. Package-prefix is consistent with the Python pattern. Open for Shivang's call.)*
5. **Edge set (V1): the same 8 as Python** — IMPORTS, CALLS, EXTENDS, IMPLEMENTS, HANDLES (route→handler), TESTS, READS_FROM, WRITES_TO. Java gets EXTENDS/IMPLEMENTS **for free** (explicit keywords — no ABC/Protocol heuristics like Python). THROWS (`throws IOException`) is cheap to emit as metadata + edges to project classes → **stretch goal**, include only if time permits.

## 3A. Shipping inside devlensio (npm package) — the packaging model

**Current reality (verified):** `package.json` ships ONLY `dist/**/*` (files whitelist). Neither the Python extractor nor anything else ships today — the tarball is JS-only. Shivang's requirement: **everything ships through devlensio**.

**Unified model — every subprocess extractor ships as a prebuilt artifact INSIDE the devlensio tarball.** The registry resolves each artifact's absolute path from the installed package location via `new URL("../../extractors/<lang>/…", import.meta.url)` — this resolves identically in the repo (`src/extractors/` → `../../`) and in `node_modules` (`dist/extractors/` → `../../`), because the tarball preserves the `dist/` + `extractors/` relative layout. The only external requirement is the language RUNTIME on PATH (same class of requirement as Node for the JS engine).

| Lang | Artifact in tarball | Built by | Runtime dep |
|---|---|---|---|
| JS/TS | `dist/` (existing) | tsc | Node |
| Python | `extractors/python/` source (venv created at setup — existing pattern) | pip install | Python 3.11+ |
| **Java** | **`extractors/java/devlens_java_extractor.jar` (fat jar, self-contained)** | **`prepack` script → `build.sh`** | **JVM 17+ on PATH** |
| Go | `extractors/go/<platform>` static binaries | CI cross-compile at publish | none |
| Rust | `extractors/rust/<platform>` static binaries | CI cross-compile at publish | none |

**Java packaging specifics:**
1. `package.json` `files` += `"extractors/java/**"` → tarball carries `src/` + `build.sh` + the jar.
2. `scripts.prepack` += `bash extractors/java/build.sh` → jar built FRESH at publish time (`npm pack`/`npm publish` run prepack; CI has network for the Maven Central downloads). The jar and `lib/` stay gitignored — zero repo bloat. Local dev runs `build.sh` manually; Cloud Docker runs it at image build. Three contexts, one artifact path.
3. Runtime guard: registry `existsSync`s the jar before spawning and returns a friendly error if missing; `Main.java` errors gracefully if run without a JVM ("Java 17+ runtime required").
4. **Verification (Step 10):** `npm pack --dry-run` → assert jar in tarball; simulated install (`npm i <tarball>` into /tmp) → run `analyzePipeline` from the installed copy.

**Python note (out of Java scope):** the venv creation stays an explicit setup step for now; a future packaging pass can add a `postinstall` that builds `extractors/python/.venv`. Same artifact-in-tarball model, deferred.

**Side note:** package.json description ("TypeScript/JavaScript/Reactjs/Nextjs repositories") is stale once multi-lang ships — update description + version bump (0.6.2 → 0.7.0) at the first multi-language release.

## 4. Package layout (mirrors Python, split by responsibility — his rule)

```
extractors/java/
├── build.sh                        # download jars → javac → fat jar
├── devlens_java_extractor.jar      # build artifact (gitignored)
├── lib/                            # downloaded deps (gitignored)
└── src/devlens/extractor/
    ├── Main.java                   # stdin JSON → stdout JSON; entry point
    ├── Contract.java               # code_hash(), node/edge builders (camelCase keys!), Stats, Fingerprint
    ├── Fingerprint.java            # pom.xml (javax.xml DOM — JDK built-in) + build.gradle (regex) → framework/projectType/databases/rawDependencies
    ├── SourceWalker.java           # prune IGNORE_DIRS (target/, .git/, build/, node_modules/), collect .java files, detect source roots
    ├── Parser.java                 # parse-time FACT collection: CompilationUnit → ParsedFile (types, methods, fields, calls, annotations, imports)
    ├── LookupMaps.java             # ONE shared index: nodes_by_name, nodes_by_file, node_by_id, file_nodes_by_path, symbol_maps, module_map
    ├── ThirdParty.java             # [mvn]/... registry + allowed gating + RUNTIME/DEVTOOL sets (mirror third_party.py)
    ├── TypeSolverFactory.java      # CombinedTypeSolver setup (reflection + source roots)
    └── edges/
        ├── Imports.java            # IMPORTS edges + symbol maps (alias → node id) + [mvn] nodes
        ├── Calls.java              # CALLS ladder (symbol-solver first, name-based fallback)
        ├── Inheritance.java        # EXTENDS / IMPLEMENTS (explicit keywords)
        ├── Routes.java             # Spring annotations → ROUTE nodes + HANDLES edges
        ├── OrmEdges.java           # JPA @Entity + Spring Data repositories → READS_FROM/WRITES_TO
        ├── Tests.java              # JUnit test detection → TESTS edges (test files = LEAF nodes)
        └── Enrich.java             # semantic metadata (isModel, isController, isRepository…)
```

## 5. Contract rules carried over (non-negotiable)

- Extractor emits **ALL edges itself** — no `detectEdges()`/`routesToCodeNodes()` on the subprocess path (verified in runner.ts).
- camelCase keys; `codeHash = sha256(rawCode).hexdigest()[:16]` (Contract.java mirrors contract.py).
- FILE id `file::rel/path/User.java` · CLASS `rel/path/User.java::User` · METHOD `rel/path/User.java::User.getName` · constructor `User.<init>` (metadata.constructor=true) · inner class `Outer.Inner` · ROUTE `rel::GET /api/users/{id}`.
- `rawCode` on every CLASS/INTERFACE/ENUM/METHOD node (summarizer input).
- Deterministic output: sort everything; same repo → byte-identical JSON.
- Test files = leaf nodes (children → `metadata.testCases` only).
- Accept BOTH `includeThirdPartyLibs` (engine truth) and `includedThirdPartyLibs` (docs spelling). Absent/empty → ZERO third-party nodes (gate, not default-on).

## 6. Step-by-step plan (each step independently testable)

### Step 0 — Engine tweak (3 lines, he applies)
In `src/extractors/index.ts`, replace the java entry's args with an absolute jar path:
```ts
java: {
    language: "java",
    command: "java",
    args: ["-jar", new URL("../../extractors/java/devlens_java_extractor.jar", import.meta.url).pathname],
    parseResult: defaultParseResult,
},
```
(`src/extractors/` + `../../` = engine root; works from both `src/` (bun dev) and `dist/` (build).) Verify: `bun run build` + `bun run test` still green.

### Step 1 — Scaffold + build.sh + contract
- `build.sh`: curl javaparser-core + javaparser-symbol-solver-core + gson (pin 3.26.x / 2.11.x) → `javac --release 17 -cp lib/* src/**/*.java` → unzip jars into classes dir → `jar cfe devlens_java_extractor.jar devlens.extractor.Main -C classes .`
- `Main.java` + `Contract.java` + `Json.java`: read stdin JSON → `ExtractorResult` shape → write stdout JSON.
- **Smoke test (the python ritual):** run from `/tmp` with an input FILE (never `echo | java`, and never from the package dir): `echo '{"repoPath":"/tmp/emptyrepo","options":{}}' > /tmp/in.json && java -jar devlens_java_extractor.jar < /tmp/in.json` → expect `{"fingerprint":{...},"nodes":[],"edges":[],"routes":[],"stats":{...},"errors":[]}`.
- ✅ **Verify:** contract round-trip, exit 0, no stderr.

### Step 2 — fingerprint.py → Fingerprint.java
- `pom.xml` via `javax.xml.parsers.DocumentBuilder` (JDK stdlib, never execute — same security rule as setup.py): project g:a:v, `<dependencies>` (g:a:v), `<parent>`, plugins (spring-boot-maven-plugin → framework `spring-boot`), `java.version`.
- `build.gradle`/`.kts`: regex-lite for `implementation 'g:a:v'` + plugins block (documented LOW fidelity — Gradle DSL isn't structured data; prefer pom when both exist).
- `databases[]`: driver artifacts (postgresql/h2/mysql/mariadb/mongodb) + spring-boot-starter-data-jpa → union-safe list. `rawDependencies`: `g:a → version`, sorted.
- ✅ **Verify:** fixture with a minimal pom → spring-boot + postgres detected; plain-Java fixture → `unknown`.

### Step 3 — SourceWalker + Parser (parse-time facts)
- Walk `.java` files, prune at the frontier (`target/`, `.git/`, `build/`, `out/`, `node_modules/`). Detect source roots: `src/main/java`, `src/test/java` (fallback: repo root).
- Per file → `ParsedFile`: package name, imports, top-level + nested types (class/interface/enum/**record**), each type → fields (name+type+annotations), methods (name, constructor flag, static/abstract, params, return type, annotations, throws list, body CALLS via visitor), rawCode + line ranges. TypeSolver attached via `StaticJavaParser.setSymbolSolver(...)`.
- Calls collected at parse time into `metadata.calls` strings (e.g. `userService.getUser`, `repository.save`) — the contract compliance + LLM context layer.
- **Scope rule:** collect calls inside method bodies only, never descend into nested type declarations when attributing to the outer method.
- ✅ **Verify:** fixture counts — N classes, M methods, calls present in metadata, test files flagged.

### Step 4 — Imports.java + ThirdParty.java
- Package→dir resolution: `com.foo.bar.Baz` → `com/foo/bar/Baz.java` under a source root (mirror of Python's sys.path simulation, incl. src-layout entries).
- Import kinds: single type (`import com.foo.Bar`), **wildcard** (`import com.foo.*` — expand to actually-used types via symbol solver; unresolved → skip, documented), **static** (`import static com.foo.Constants.PI` → resolve to containing class).
- JDK imports → no node, no edge. External non-JDK → `[mvn]/<prefix>` nodes via ThirdParty registry (gated). Project imports → IMPORTS edge FILE → FILE.
- symbol_maps: per-file `{alias → target node id}` — THE bridge for Calls/Routes/Tests (same as Python).
- ✅ **Verify:** fixture — expected IMPORTS edge count, `[mvn]` nodes appear ONLY when gated, wildcard behavior.

### Step 5 — Calls.java (the resolution ladder)
1. `MethodCallExpr.resolveInvokedMethod()` via symbol solver → declared in project source → CALLS edge to that METHOD node (map package+class+method → node id).
2. Resolved to JDK (ReflectionTypeSolver) → skip (builtin tier).
3. Unresolved (external, no jars) → lazy `[mvn]/pkg::method` node if permitted (python's chain rule).
4. Name-based fallback: receiver type / plain name → LookupMaps (nodes_by_name → closest_by_path → symbol-map refinement) — python's proven ladder.
5. Write `metadata.resolvedCalls` back. Edges deduped at assembly.
- ✅ **Verify:** fixture — service→repo, controller→service edges land; count asserted; 0 duplicate edges.

### Step 6 — Routes.java (Spring Boot)
- Class-level: `@RestController`/`@Controller` + `@RequestMapping("/api")` → base path. Method-level: `@GetMapping`/`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping`/`@RequestMapping(method=…)`.
- Compose class+method paths; `@PathVariable` → params metadata. ROUTE node `rel::GET /api/users/{id}` + HANDLES edge → handler METHOD node.
- V1 scope: Spring MVC annotations only. JAX-RS (`@Path`), `@FeignClient`, WebFlux functional routes → V2 (documented in html doc).
- ✅ **Verify:** fixture — route count + composed paths asserted; petclinic later.

### Step 7 — OrmEdges.java (JPA — highest fidelity of all languages per playbook)
- Model detection: `@Entity`/`@Table`/`@MappedSuperclass` (or extends a base annotated class) → CLASS `isModel=true`, `modelType=jpa`, `fields[]` from fields/`@Column`.
- Spring Data repositories: interface `extends JpaRepository<Entity, ID>` / `CrudRepository` / `MongoRepository` → `linkedModel` from the generic arg; CRUD method-name grammar (`findBy*`, `save`, `deleteBy*`, `countBy*`) → R/W classification.
- Edges: consumer method (service/controller) calling `repo.save(x)` → WRITES_TO entity CLASS; `repo.findById(...)` → READS_FROM entity CLASS. Direction consumer→store (mirrors stateEdges.ts + python orm_edges). EntityManager `persist/merge/remove` → WRITES_TO, `find/createQuery` → READS_FROM (basic).
- ✅ **Verify:** fixture — model detection, repo linkage, R/W edge count; instance-level resolution documented as heuristic where needed.

### Step 8 — Inheritance.java + Tests.java + Enrich.java
- `implements Foo, Bar` → IMPLEMENTS (always); `extends Baz` → EXTENDS (always; interface extends interface → EXTENDS). Local targets only — never dangling (unresolved external base → skip or gated `[mvn]` EXTENDS like python).
- Tests: `src/test/java` + `*Test.java`/`*Tests.java` naming + JUnit annotations → TEST node (leaf), `metadata.testCases` populated; TESTS edge TEST → production CLASS via imports/symbol maps.
- Enrich: `isController` (rest controller), `isRepository`, `isModel` (from step 7), `isService` (`@Service`), `isSchema` (DTO records/`@RequestBody` classes — keep cheap).
- **Memo-isolation rule (python incident):** each marker scan gets its own memo map.
- ✅ **Verify:** fixture — EXTENDS/IMPLEMENTS/TESTS counts; 0 dangling inheritance targets.

### Step 9 — Integration: extractor pipeline (mirror extractor.py order)
parse → lookup → imports (+[mvn] nodes) → calls → routes → orm → inheritance → tests → enrich → **dedupe edges at assembly** → deterministic sort → result. `errors[]` non-fatal (parse failures per file, like python's `except A, B:` handling).
- ✅ **Verify:** full fixture runs; route/handles/node counts; byte-identical output on repeat run.

### Step 10 — Engine e2e + real repos (THE ritual)
- Fixtures (new): `/tmp/javafixture` (Maven Spring Boot: controller/service/repository/entity/JUnit test + pom), `/tmp/javafixture-plain` (plain Java + JUnit, no framework).
- Real repos (clone --depth 1): `/tmp/realjavaspring` = **spring-projects/spring-petclinic** (canonical Spring Boot demo: controllers, services, JPA repos, entities, tests — ideal cross-check) + `/tmp/realjavagradle` = a Gradle-based Spring Boot sample + `/tmp/realjavaplain` = plain-Java library.
- e2e script `/tmp/e2e.java-analyze.ts`: `analyzePipeline(repo, false, { includedThirdPartyLibs: [...] })` — **THREE args** (python incident #4) — then cross-check against source: routes vs `grep @GetMapping`, entities vs `grep @Entity`, HANDLES targets exist (0 broken), 0 duplicate edges, node/edge counts sane.
- **Packaging check:** `npm pack --dry-run` → jar present in tarball; `npm i <tarball>` into /tmp → `analyzePipeline` works from the installed copy (registry path resolution under node_modules).
- Coverage audit (one-shot /tmp script — his stance: estimate, not a project tool): nodes ~100%, routes ~100%, imports ~100%, calls ~45-50% parity tier (unresolvable without dep jars — expected, documented; symbol solver still beats pure syntax). Isolated-node census 15-30%, all explainable.
- Engine: `bun run test` (324) + `bun run build` green, zero JS/TS regression.

### Step 11 — Docs + tracker
- `DevLens docs/devlens langauges ext/java_graph_detection.html` (layman terms; mirror `python_graph_detection.html`: file structure, what each class detects, node/edge meanings in Java terms, how to run).
- `expansion-tracker/progress.html` phase-3 tables + new phase-3 page; skill gains `references/phase-3-progress.md` (resume state + incidents).

## 7. Files touched

| File | Action |
|---|---|
| `src/extractors/index.ts` | Step 0: absolute jar path in java entry (3 lines) + existsSync guard |
| `extractors/java/` (all) | NEW — everything in §4 |
| `package.json` | `files` += `"extractors/java/**"`; `scripts.prepack` += `bash extractors/java/build.sh` (jar built at publish); description/version bump at first multi-lang release |
| `.gitignore` (engine) | add `extractors/java/lib/` + `extractors/java/devlens_java_extractor.jar` (build artifacts — prepack rebuilds them) |
| `expansion-tracker/` | docs (gitignored by design) |
| `DevLens docs/devlens langauges ext/` | java_graph_detection.html |

## 8. Risks / tradeoffs / open questions

1. **No classpath resolution (V1)** → Spring framework types unresolved; route detection is annotation-name-based (same tier as Python decorators — fine), CALLS to external libs only via `[mvn]` lazy nodes. Full `dependency:build-classpath` = V2.
2. **Lombok** (`@Data`, `@Builder`) — generated methods invisible in AST; documented in html doc, no workaround in V1.
3. **Gradle fingerprint is regex-based** — documented low fidelity; pom preferred.
4. **Big repos** — JavaParser is slower than Python's ast; IGNORE pruning + per-file parsing keeps petclinic-scale (few hundred files) fast. Fine for V1.
5. **Records/sealed types (17+)** — JavaParser handles; records → CLASS with `metadata.isRecord=true`.

**Locked decisions (Shivang deferred — resolved by me, 2026-08-15):**
- **Q1 (build):** fat-jar via `build.sh` + prepack. No Maven install. Maven remains the fallback only if build.sh ever fights CI.
- **Q2 (third-party key):** `[mvn]/<package-prefix>` — consistent with `[pip]/pkg`; no import→artifact mapping needed without classpath resolution.
- **Q3 (THROWS):** defer to V2 — V1 keeps the 8-edge parity with Python; `throws` list captured in method metadata so THROWS is a cheap later add.
- **Q4 (real repos):** spring-petclinic primary + one Gradle Spring Boot sample + one plain-Java library.

**Open questions for Shivang: none blocking — plan approved to proceed.**

## 9. Timeline

~4 work sessions (each with verification): **S1** scaffold+fingerprint+parser → **S2** imports+calls → **S3** routes+orm+inheritance+tests → **S4** integration+real-repo verification+docs. Python took ~1 day; Java is bigger (type solver + Spring surface) — expect 2-3 days total with AI assistance.

## 10. Collaboration mode (as before)

I deliver **concept + complete copy-paste code** per file in one message; Shivang writes the code (or says "go ahead" and I implement directly + test). Verify after every step (fixture counts, smoke runs, engine tests). Never overfit to one repo — every fix maps to documented Java/Spring behavior, validated on ≥2 real repos.

// Python extractor — callOrder/v1 conformance, run under `bun test`.
//
// Black-box like python-extractor.test.ts: ONE subprocess run of the venv
// extractor over a throwaway fixture repo written to os.tmpdir, then assertions
// on the ordering/flag contract of docs/CALL_ORDER.md §6. The fixtures live
// inline so the code under assertion and the expectations stay in one file.
//
// Skipped automatically when the python venv isn't bootstrapped.

import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const VENV_PYTHON = path.resolve(
  import.meta.dir, "../../../extractors/python/.venv/bin/python"
);
const pythonAvailable = fs.existsSync(VENV_PYTHON);

// ─── Fixtures ───────────────────────────────────────────────────────────

const FIXTURES: Record<string, string> = {
  // Ordering / identity cases.
  "order.py": `
def a(*args, **kwargs):
    return args


def b(value=None):
    return value


def c():
    return 3


def sequential():
    a()
    b(1)
    c()


def duplicate():
    a()
    b(2)
    a()


def same_name_different_arity():
    b(1)
    b(1, 2)


def nested_call():
    a(b(10))


def deep_nesting():
    a(b(c()))


def no_calls():
    return 0


def with_default(v=b(99)):
    return b(v)
`,
  // Flag cases: branches, loops, try/except/finally, comprehensions, async,
  // schedulers.
  "flow.py": `
import asyncio
import threading


def work():
    return 1


def other(item):
    return True


def make(items):
    return items


def branchy(flag):
    if flag:
        work()
    else:
        work()


def short_circuit(flag):
    return flag and work()


def loopy(items):
    for item in items:
        work()
    while other(items):
        work()


def guarded():
    try:
        work()
    except ValueError:
        work()
    finally:
        work()


def comprehension(items):
    return [work() for item in items if other(item)]


def dict_comprehension(items):
    return {item: work() for item in items}


def eager_iterable(items):
    return [work() for item in make(items)]


async def awaiting():
    await work()


async def gathered():
    await asyncio.gather(work(), other(1))


def scheduled():
    asyncio.create_task(work())


def threaded():
    threading.Thread(target=work)


def timed():
    threading.Timer(5, work)
    loop.call_later(1.0, work)


def inlined():
    return work()
`,
  // Scope cases: hooks, nested def/lambda bodies, methods, module scope.
  "scope.py": `
def use_thing():
    return 1


def render():
    return 2


def work():
    return 3


def widget():
    use_thing()
    render()


def outer_with_inner():
    work()

    def inner():
        work()

    return inner


def with_lambda():
    work()
    fn = lambda: work()
    return fn


class Service:
    def load(self):
        return 1

    def render(self, item):
        return item

    def handle(self, items):
        self.load()

        def inner():
            self.load()

        return [self.render(item) for item in items]


top_level = bootstrap()
use_widget()
`,
};

function runExtractor(repoPath: string) {
  const res = spawnSync(
    VENV_PYTHON, ["-m", "devlens_extractors_python"],
    {
      input: JSON.stringify({ repoPath, options: {} }),
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    }
  );
  expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
  return JSON.parse(res.stdout);
}

let cached: any;
/** Build the fixture repo and run the extractor once for the whole suite. */
function analyze() {
  if (!cached) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-py-callorder-"));
    for (const [rel, source] of Object.entries(FIXTURES)) {
      fs.writeFileSync(path.join(dir, rel), source, "utf8");
    }
    cached = runExtractor(dir);
  }
  return cached;
}

function nodeOf(id: string) {
  const node = analyze().nodes.find((n: any) => n.id === id);
  expect(node, `node ${id}`).toBeDefined();
  return node;
}
function sitesOf(id: string): any[] {
  return nodeOf(id).metadata.callSites ?? [];
}
function ordersOf(id: string): number[] {
  return sitesOf(id).map((s: any) => s.order);
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!pythonAvailable)("python callOrder/v1 (docs/CALL_ORDER.md §6)", () => {
  // ── Ordering ─────────────────────────────────────────────────────────
  describe("ordering", () => {
    test("1. sequential a(); b(); c() → orders 1,2,3", () => {
      const sites = sitesOf("order.py::sequential");
      expect(sites.map((s: any) => s.name)).toEqual(["a", "b", "c"]);
      expect(sites.map((s: any) => s.order)).toEqual([1, 2, 3]);
      // ordinals grow with source position
      expect(sites[0].line).toBeLessThan(sites[1].line);
      expect(sites[1].line).toBeLessThan(sites[2].line);
      expect(nodeOf("order.py::sequential").metadata.calls).toEqual(["a", "b", "c"]);
    });

    test("2. same target twice a(); b(); a() → 3 records, orders 1,2,3", () => {
      const sites = sitesOf("order.py::duplicate");
      expect(sites.map((s: any) => s.name)).toEqual(["a", "b", "a"]);
      expect(sites.map((s: any) => s.order)).toEqual([1, 2, 3]);
      // metadata.calls stays a name-deduped set — only its order may improve
      expect(nodeOf("order.py::duplicate").metadata.calls).toEqual(["a", "b"]);
    });

    test("3. same name, different arity f(1); f(1,2) → 2 records", () => {
      const sites = sitesOf("order.py::same_name_different_arity");
      expect(sites.map((s: any) => s.name)).toEqual(["b", "b"]);
      expect(sites.map((s: any) => s.argCount)).toEqual([1, 2]);
      expect(sites.map((s: any) => s.order)).toEqual([1, 2]);
    });

    test("4. nested a(b(10)) → inner.nested is the outer order", () => {
      const [outer, inner] = sitesOf("order.py::nested_call");
      expect(outer.order).toBe(1);
      expect(inner.order).toBe(2);
      expect(outer.nested).toBeUndefined();
      expect(inner.nested).toBe(outer.order);
    });

    test("5. deep nesting a(b(c())) → chain of nested", () => {
      const sites = sitesOf("order.py::deep_nesting");
      expect(sites.map((s: any) => s.name)).toEqual(["a", "b", "c"]);
      expect(sites.map((s: any) => s.nested)).toEqual([undefined, 1, 2]);
    });

    test("6. no calls → empty callSites (FILE node carries none either)", () => {
      expect(sitesOf("order.py::no_calls")).toEqual([]);
      expect(nodeOf("order.py::no_calls").metadata.calls).toEqual([]);
      expect(nodeOf("file::order.py").metadata.callSites).toBeUndefined();
    });

    test("8. calls inside if/for/try stay in lexical order", () => {
      expect(ordersOf("flow.py::branchy")).toEqual([1, 2]);         // if / else
      expect(ordersOf("flow.py::loopy")).toEqual([1, 2, 3]);        // for body, while test+body
      expect(ordersOf("flow.py::guarded")).toEqual([1, 2, 3]);      // try / except / finally
    });

    test("11. default-arg calls are NOT call sites (frozen set — see report)", () => {
      // Conformance §6.11 wants `f(x = g())` recorded. Python defaults live on
      // the FunctionDef, not in the body, and extending the walk there would add
      // call sites + edges (forbidden by §5). Documented per-language gap.
      const sites = sitesOf("order.py::with_default");
      expect(sites.map((s: any) => s.name)).toEqual(["b"]);
      expect(sites.map((s: any) => s.scope)).toEqual(["inline"]);
      expect(nodeOf("order.py::with_default").metadata.calls).toEqual(["b"]);
    });

    test("35. per node: orders are contiguous, unique, monotone with (line, col)", () => {
      const candidates = analyze().nodes.filter(
        (n: any) => Array.isArray(n.metadata?.callSites) && n.metadata.callSites.length > 0
      );
      expect(candidates.length).toBeGreaterThan(0);
      for (const node of candidates) {
        const sites = node.metadata.callSites;
        expect(sites.map((s: any) => s.order), node.id).toEqual(
          sites.map((_: any, i: number) => i + 1)
        );
        const bySource = [...sites].sort((x: any, y: any) => x.line - y.line || x.col - y.col);
        expect(bySource.map((s: any) => s.order), node.id).toEqual(
          sites.map((s: any) => s.order)
        );
        for (const site of sites) {
          if (site.nested !== undefined) {
            // §5.4: an existing order of the same node, smaller than this one
            expect(sites.some((s: any) => s.order === site.nested)).toBe(true);
            expect(site.nested).toBeLessThan(site.order);
          }
        }
      }
    });
  });

  // ── Hooks ────────────────────────────────────────────────────────────
  describe("hooks (kind)", () => {
    test("14. hook keeps its ordinal but is absent from metadata.calls", () => {
      const sites = sitesOf("scope.py::widget");
      expect(sites.map((s: any) => [s.name, s.kind, s.order])).toEqual([
        ["use_thing", "hook", 1],
        ["render", "call", 2],
      ]);
      expect(nodeOf("scope.py::widget").metadata.calls).toEqual(["render"]);
    });

    test("14. module-level hook: kind hook, excluded from the FILE calls list", () => {
      const file = nodeOf("file::scope.py");
      expect(file.metadata.calls).toEqual(["bootstrap"]);
      expect(file.metadata.callSites.map((s: any) => [s.name, s.kind])).toEqual([
        ["bootstrap", "call"],
        ["use_widget", "hook"],
      ]);
    });
  });

  // ── Scope ────────────────────────────────────────────────────────────
  describe("scope", () => {
    test("19. nested def / lambda bodies are not call sites (frozen set — see report)", () => {
      // §6.19 wants scope:"nested" for `function h(){ f() }`. In Python a nested
      // def/lambda has no node of its own, so recording its calls would add call
      // sites and edges (§5.1/§5.2). Documented per-language gap.
      expect(sitesOf("scope.py::outer_with_inner")).toHaveLength(1);
      expect(sitesOf("scope.py::outer_with_inner")[0].scope).toBe("inline");
      expect(sitesOf("scope.py::with_lambda")).toHaveLength(1);
      expect(sitesOf("scope.py::with_lambda")[0].scope).toBe("inline");
      // …and the inner def produces no node, so nothing else owns those calls
      expect(analyze().nodes.some((n: any) => n.id === "scope.py::inner")).toBe(false);
    });

    test("nested def inside a method: only the method's own calls are recorded", () => {
      const sites = sitesOf("scope.py::Service.handle");
      expect(sites.map((s: any) => [s.name, s.order])).toEqual([
        ["self.load", 1],
        ["self.render", 2],
      ]);
      expect(sites[0].scope).toBe("inline");       // straight-line frame body
      expect(sites[1].scope).toBe("callback");     // comprehension callback
      expect(sites[1].repeat).toBe(true);
    });

    test("20. comprehension → scope callback + repeat", () => {
      const sites = sitesOf("flow.py::comprehension");
      expect(sites.map((s: any) => [s.name, s.scope, s.repeat === true])).toEqual([
        ["work", "callback", true],
        ["other", "callback", true],
      ]);
    });

    test("20. dict comprehension body is a callback too", () => {
      const [site] = sitesOf("flow.py::dict_comprehension");
      expect(site.name).toBe("work");
      expect(site.scope).toBe("callback");
      expect(site.repeat).toBe(true);
    });

    test("20. only the FIRST iterable of a comprehension runs in the frame", () => {
      const [element, iterable] = sitesOf("flow.py::eager_iterable");
      expect(element.name).toBe("work");
      expect(element.scope).toBe("callback");
      expect(iterable.name).toBe("make");
      expect(iterable.scope).toBe("inline");
      expect(iterable.repeat).toBeUndefined();
    });

    test("21. module-scope calls → scope module on the FILE node", () => {
      const sites = nodeOf("file::scope.py").metadata.callSites;
      expect(sites.map((s: any) => [s.name, s.scope, s.order])).toEqual([
        ["bootstrap", "module", 1],
        ["use_widget", "module", 2],
      ]);
    });
  });

  // ── Async / defer / conc ─────────────────────────────────────────────
  describe("async, defer and conc", () => {
    test("22. await f() → awaited", () => {
      const [site] = sitesOf("flow.py::awaiting");
      expect(site.name).toBe("work");
      expect(site.awaited).toBe(true);
      expect(site.defer).toBeUndefined();
    });

    test("await does not leak onto the awaited call's arguments", () => {
      const gather = sitesOf("flow.py::gathered")[0];
      expect(gather.name).toBe("asyncio.gather");
      expect(gather.awaited).toBe(true);
      const [member] = sitesOf("flow.py::gathered").slice(1);
      expect(member.nested).toBe(gather.order);
      expect(member.awaited).toBeUndefined();
    });

    test("25. microtask is not a Python defer kind (TS/JS only — §4.2)", () => {
      const all = analyze().nodes.flatMap((n: any) => n.metadata?.callSites ?? []);
      expect(all.some((s: any) => s.defer === "microtask")).toBe(false);
    });

    test("28. branch → maybe, loop body → repeat, short-circuit → maybe", () => {
      expect(sitesOf("flow.py::branchy").map((s: any) => s.maybe === true)).toEqual([true, true]);
      expect(sitesOf("flow.py::short_circuit")[0].maybe).toBe(true);
      const loopy = sitesOf("flow.py::loopy");
      expect(loopy.map((s: any) => [s.name, s.repeat === true])).toEqual([
        ["work", true],      // for body
        ["other", false],    // while test: evaluated once per iteration, not a body
        ["work", true],      // while body
      ]);
    });

    test("try body is not maybe, except body is, finally runs at frame exit", () => {
      const [inTry, inExcept, inFinally] = sitesOf("flow.py::guarded");
      expect(inTry.maybe).toBeUndefined();
      expect(inTry.defer).toBeUndefined();
      expect(inExcept.maybe).toBe(true);
      expect(inFinally.maybe).toBeUndefined();
      expect(inFinally.defer).toBe("onReturn");
      expect(inFinally.deferDetail).toBe("finally");
    });

    test("31. asyncio.create_task(f()) → promise + conc, members inherit it", () => {
      const [task, member] = sitesOf("flow.py::scheduled");
      expect([task.name, task.defer, task.conc]).toEqual(["asyncio.create_task", "promise", true]);
      expect([member.name, member.defer, member.conc]).toEqual(["work", "promise", true]);
      expect(member.deferDetail).toBe("asyncio.create_task");
      expect(member.nested).toBe(task.order);
    });

    test("31. Thread(target=f) → conc without defer", () => {
      const [site] = sitesOf("flow.py::threaded");
      expect(site.name).toBe("threading.Thread");
      expect(site.conc).toBe(true);
      expect(site.defer).toBeUndefined();
      expect(site.deferDetail).toBe("threading.Thread");
    });

    test("31. gather members are both promise and conc", () => {
      const [gather, first, second] = sitesOf("flow.py::gathered");
      expect(gather.conc).toBe(true);
      expect(first.conc).toBe(true);
      expect(first.defer).toBe("promise");
      expect(second.conc).toBe(true);
      expect(second.defer).toBe("promise");
      expect(second.deferDetail).toBe("asyncio.gather");
    });

    test("defer:timer for threading.Timer and loop.call_later", () => {
      const sites = sitesOf("flow.py::timed");
      expect(sites.map((s: any) => [s.name, s.defer])).toEqual([
        ["threading.Timer", "timer"],
        ["loop.call_later", "timer"],
      ]);
      expect(sites.map((s: any) => s.conc)).toEqual([undefined, undefined]);
    });

    test("plain call in the frame body carries no detachment evidence", () => {
      expect(sitesOf("flow.py::inlined")[0]).toEqual(
        expect.objectContaining({ name: "work", order: 1, scope: "inline", kind: "call" })
      );
      expect(sitesOf("flow.py::inlined")[0].defer).toBeUndefined();
      expect(sitesOf("flow.py::inlined")[0].conc).toBeUndefined();
      expect(sitesOf("flow.py::inlined")[0].maybe).toBeUndefined();
      expect(sitesOf("flow.py::inlined")[0].repeat).toBeUndefined();
    });
  });

  // ── Invariants ───────────────────────────────────────────────────────
  describe("invariants", () => {
    test("36. resolvedCalls carries firstOrder per target, deduped by nodeId", () => {
      const sites = sitesOf("order.py::duplicate");
      const resolved = nodeOf("order.py::duplicate").metadata.resolvedCalls;
      const ordersOf = (name: string) =>
        sites.filter((s: any) => s.name === name).map((s: any) => s.order).sort((x: number, y: number) => x - y);

      expect(resolved.map((r: any) => [r.name, r.nodeId])).toEqual([
        ["a", "order.py::a"],
        ["b", "order.py::b"],
      ]);
      for (const entry of resolved) {
        expect(entry.firstOrder).toBe(ordersOf(entry.name)[0]);
        expect(typeof entry.line).toBe("number");
      }
      // a() twice: the node carries both positions; b() once: no orders key.
      expect(resolved[0].orders).toEqual([1, 3]);
      expect(resolved[1].orders).toBeUndefined();
    });

    test("repeated call sites do not multiply CALLS edges (§5.1)", () => {
      const calls = analyze().edges.filter(
        (e: any) => e.type === "CALLS" && e.from === "order.py::duplicate"
      );
      // a() twice + b() once → 2 distinct (from,to,type) keys
      expect(calls.map((e: any) => e.to)).toEqual(["order.py::a", "order.py::b"]);
    });
  });
});

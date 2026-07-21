import fs from "fs";
import path from "path";
import os from "os";
import { analyzeFilesystem } from "./index.js";
import { ProjectFingerprint, RouteNode, BackendRouteNode, Framework } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createFakeRepo(structure: string[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-fs-test-"));

  for (const filePath of structure) {
    const fullPath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "// fake file");
  }

  return tmpDir;
}

function deleteFakeRepo(repoPath: string): void {
  fs.rmSync(repoPath, { recursive: true, force: true });
}

function makeFingerprint(
  framework: Framework,
  router: "app" | "pages" | "react-router" | "none"
): ProjectFingerprint {
  return {
    language: "typescript",
    projectType: "frontend",
    framework,
    router,
    stateManagement: ["context-only"],
    dataFetching: ["fetch"],
    databases: [],
    rawDependencies: {},
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("analyzeFilesystem", () => {

  // ─── Non Next.js projects ─────────────────────────────────────────────────

  it("should return empty array for plain React projects", () => {
    const repoPath = createFakeRepo(["src/App.tsx"]);
    const fingerprint = makeFingerprint("react", "react-router");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    expect(routes).toHaveLength(0);
    deleteFakeRepo(repoPath);
  });

  it("should return empty array for unknown projects", () => {
    const repoPath = createFakeRepo(["src/index.ts"]);
    const fingerprint = makeFingerprint("unknown", "none");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    expect(routes).toHaveLength(0);
    deleteFakeRepo(repoPath);
  });

  // ─── App Router ───────────────────────────────────────────────────────────

  it("should detect root page in app router", () => {
    const repoPath = createFakeRepo(["src/app/page.tsx"]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page).toBeDefined();
    expect(page?.urlPath).toBe("/");
    deleteFakeRepo(repoPath);
  });

  it("should detect nested page in app router", () => {
    const repoPath = createFakeRepo(["src/app/dashboard/page.tsx"]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page?.urlPath).toBe("/dashboard");
    deleteFakeRepo(repoPath);
  });

  it("should detect dynamic route in app router", () => {
    const repoPath = createFakeRepo(["src/app/users/[userId]/page.tsx"]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page?.isDynamic).toBe(true);
    expect(page?.params).toContain("userId");
    deleteFakeRepo(repoPath);
  });

  it("should detect catch all route in app router", () => {
    const repoPath = createFakeRepo(["src/app/docs/[...slug]/page.tsx"]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page?.isCatchAll).toBe(true);
    deleteFakeRepo(repoPath);
  });

  it("should detect route group and ignore it in url", () => {
    const repoPath = createFakeRepo(["src/app/(auth)/login/page.tsx"]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page?.urlPath).toBe("/login");
    expect(page?.isGroupRoute).toBe(true);
    deleteFakeRepo(repoPath);
  });

  it("should detect layout in app router", () => {
    const repoPath = createFakeRepo(["src/app/layout.tsx", "src/app/page.tsx"]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const layout = routes.find((r): r is RouteNode => r.type === "LAYOUT");
    expect(layout).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("should detect api route in app router", () => {
    const repoPath = createFakeRepo(["src/app/api/users/route.ts"]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const api = routes.find((r): r is RouteNode => r.type === "API_ROUTE");
    expect(api).toBeDefined();
    expect(api?.urlPath).toBe("/api/users");
    deleteFakeRepo(repoPath);
  });

  it("should detect middleware in app router project", () => {
    const repoPath = createFakeRepo([
      "src/app/page.tsx",
      "middleware.ts",
    ]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const middleware = routes.find((r): r is RouteNode => r.type === "MIDDLEWARE");
    expect(middleware).toBeDefined();
    expect(middleware?.isCatchAll).toBe(true);
    deleteFakeRepo(repoPath);
  });

  it("should detect layout path for a page", () => {
    const repoPath = createFakeRepo([
      "src/app/dashboard/layout.tsx",
      "src/app/dashboard/page.tsx",
    ]);
    const fingerprint = makeFingerprint("nextjs", "app");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page?.layoutPath).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  // ─── Pages Router ─────────────────────────────────────────────────────────

  it("should detect root page in pages router", () => {
    const repoPath = createFakeRepo(["src/pages/index.tsx"]);
    const fingerprint = makeFingerprint("nextjs", "pages");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page?.urlPath).toBe("/");
    deleteFakeRepo(repoPath);
  });

  it("should detect nested page in pages router", () => {
    const repoPath = createFakeRepo(["src/pages/dashboard/index.tsx"]);
    const fingerprint = makeFingerprint("nextjs", "pages");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page?.urlPath).toBe("/dashboard");
    deleteFakeRepo(repoPath);
  });

  it("should detect dynamic route in pages router", () => {
    const repoPath = createFakeRepo(["src/pages/users/[userId].tsx"]);
    const fingerprint = makeFingerprint("nextjs", "pages");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const page = routes.find((r): r is RouteNode => r.type === "PAGE");
    expect(page?.isDynamic).toBe(true);
    expect(page?.params).toContain("userId");
    deleteFakeRepo(repoPath);
  });

  it("should detect api route in pages router", () => {
    const repoPath = createFakeRepo(["src/pages/api/users.ts"]);
    const fingerprint = makeFingerprint("nextjs", "pages");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    const api = routes.find((r): r is RouteNode => r.type === "API_ROUTE");
    expect(api).toBeDefined();
    expect(api?.urlPath).toBe("/api/users");
    deleteFakeRepo(repoPath);
  });

  it("should skip special files in pages router", () => {
    const repoPath = createFakeRepo([
      "src/pages/_app.tsx",
      "src/pages/_document.tsx",
      "src/pages/index.tsx",
    ]);
    const fingerprint = makeFingerprint("nextjs", "pages");
    const routes = analyzeFilesystem(repoPath, fingerprint);
    // Only index.tsx should be detected, not _app or _document
    expect(routes).toHaveLength(1);
    deleteFakeRepo(repoPath);
  });

});

// ─── React Router ───────────────────────────────────────────────────────────────

describe("analyzeFilesystem — React Router", () => {

  // React Router routes live in code, so these fixtures need real file content
  // (the top-level createFakeRepo writes a placeholder comment instead).
  function createRepoWithFiles(files: Record<string, string>): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-rr-test-"));
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    return tmpDir;
  }

  const rrFingerprint = makeFingerprint("react", "react-router");

  it("detects a JSX <Route path> route", () => {
    const repoPath = createRepoWithFiles({
      "src/App.tsx": `
        import { Routes, Route } from "react-router-dom";
        export default function App() {
          return (
            <Routes>
              <Route path="/users" element={<Users />} />
            </Routes>
          );
        }
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    const route = routes.find((r): r is RouteNode => r.urlPath === "/users");
    expect(route).toBeDefined();
    expect(route?.type).toBe("REACT_ROUTER_ROUTE");
    deleteFakeRepo(repoPath);
  });

  it("detects a dynamic JSX <Route path> with params", () => {
    const repoPath = createRepoWithFiles({
      "src/App.tsx": `
        import { Route } from "react-router-dom";
        export default function App() {
          return <Route path="/users/:id" element={<User />} />;
        }
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    const route = routes.find((r): r is RouteNode => r.urlPath === "/users/:id");
    expect(route).toBeDefined();
    expect(route?.isDynamic).toBe(true);
    expect(route?.params).toContain("id");
    deleteFakeRepo(repoPath);
  });

  it("assembles nested paths from createBrowserRouter children", () => {
    const repoPath = createRepoWithFiles({
      "src/router.tsx": `
        import { createBrowserRouter } from "react-router-dom";
        export const router = createBrowserRouter([
          {
            path: "/dashboard",
            element: <Dashboard />,
            children: [
              { path: "settings", element: <Settings /> },
            ],
          },
        ]);
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    expect(routes.find((r): r is RouteNode => r.urlPath === "/dashboard")).toBeDefined();
    expect(routes.find((r): r is RouteNode => r.urlPath === "/dashboard/settings")).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("detects routes from a useRoutes config", () => {
    const repoPath = createRepoWithFiles({
      "src/Routes.tsx": `
        import { useRoutes } from "react-router-dom";
        export function AppRoutes() {
          return useRoutes([
            { path: "/about", element: <About /> },
          ]);
        }
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    expect(routes.find((r): r is RouteNode => r.urlPath === "/about")).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("detects a TanStack createFileRoute", () => {
    const repoPath = createRepoWithFiles({
      "src/routes/dashboard.tsx": `
        import { createFileRoute } from "@tanstack/react-router";
        export const Route = createFileRoute("/dashboard")({
          component: Dashboard,
        });
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    expect(routes.find((r): r is RouteNode => r.urlPath === "/dashboard")).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("converts a splat '*' route into a catch-all", () => {
    const repoPath = createRepoWithFiles({
      "src/App.tsx": `
        import { Route } from "react-router-dom";
        export default function App() {
          return <Route path="/files/*" element={<Files />} />;
        }
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    const route = routes.find((r): r is RouteNode => r.urlPath === "/files/:splat*");
    expect(route).toBeDefined();
    expect(route?.isCatchAll).toBe(true);
    deleteFakeRepo(repoPath);
  });

  // ─── rendersComponent capture ───────────────────────────────────────────

  it("captures the rendered component from element={<Home/>} (v6 JSX)", () => {
    const repoPath = createRepoWithFiles({
      "src/App.tsx": `
        import { Route } from "react-router-dom";
        export default function App() {
          return <Route path="/" element={<Home />} />;
        }
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    const route = routes.find((r): r is RouteNode => r.urlPath === "/");
    expect(route?.rendersComponent).toBe("Home");
    deleteFakeRepo(repoPath);
  });

  it("captures the rendered component from a v5 component={About} prop", () => {
    const repoPath = createRepoWithFiles({
      "src/App.tsx": `
        import { Route } from "react-router-dom";
        export default function App() {
          return <Route path="/about" component={About} />;
        }
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    const route = routes.find((r): r is RouteNode => r.urlPath === "/about");
    expect(route?.rendersComponent).toBe("About");
    deleteFakeRepo(repoPath);
  });

  it("captures the rendered component from a createBrowserRouter object (element)", () => {
    const repoPath = createRepoWithFiles({
      "src/router.tsx": `
        import { createBrowserRouter } from "react-router-dom";
        export const router = createBrowserRouter([
          { path: "/dashboard", element: <Dashboard /> },
        ]);
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    const route = routes.find((r): r is RouteNode => r.urlPath === "/dashboard");
    expect(route?.rendersComponent).toBe("Dashboard");
    deleteFakeRepo(repoPath);
  });

  it("captures the rendered component from a data-router Component property", () => {
    const repoPath = createRepoWithFiles({
      "src/router.tsx": `
        import { createBrowserRouter } from "react-router-dom";
        export const router = createBrowserRouter([
          { path: "/profile", Component: Profile },
        ]);
      `,
    });
    const routes = analyzeFilesystem(repoPath, rrFingerprint);
    const route = routes.find((r): r is RouteNode => r.urlPath === "/profile");
    expect(route?.rendersComponent).toBe("Profile");
    deleteFakeRepo(repoPath);
  });

});

// ─── Backend frameworks: Bun / Hono / Elysia / Express ───────────────────────────
//
// Covers three recognizers added for general backend route detection:
//   1. route-table (object-literal) — hand-rolled [{method,pattern,handler}] routers
//      (the OSS shape); framework-agnostic, fires in bun scan-all mode.
//   2. imperative app.METHOD(path, handler) — Express/Hono/Elysia shared shape.
//   3. Bun.serve fetch-handler — inline switch/if URL dispatch for bare-Bun apps.

describe("analyzeFilesystem — Backend (Bun/Hono/Elysia/Express)", () => {

  function createRepoWithFiles(files: Record<string, string>): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-be-test-"));
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    return tmpDir;
  }

  function backendFingerprint(framework: Framework): ProjectFingerprint {
    return makeFingerprint(framework, "none");
  }

  function findRoute(routes: (RouteNode | BackendRouteNode)[], method: string, urlPath: string): BackendRouteNode | undefined {
    return routes.find(
      (r): r is BackendRouteNode =>
        r.type === "BACKEND_ROUTE" && r.httpMethod === method && r.urlPath === urlPath
    );
  }

  // ─── Route-table (object-literal) recognizer ─────────────────────────────

  it("detects a route-table array (Bun.serve + hand-rolled router — the OSS shape)", () => {
    const repoPath = createRepoWithFiles({
      "src/server/router.ts": `
        import { handlePreScan, handleGetGraph, handleAnalyze } from "./handlers.js";
        interface Route { method: string; pattern: string; handler: (p: any, req: any) => any; }
        const ROUTES: Route[] = [
          { method: "GET",  pattern: "/api/health",   handler: () => Response.json({ status: "ok" }) },
          { method: "GET",  pattern: "/api/pre-scan", handler: (_p, req) => handlePreScan(req) },
          { method: "POST", pattern: "/api/analyze",  handler: (_p, req) => handleAnalyze(req) },
        ];
        export async function router(req: any) { return null; }
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    expect(routes.length).toBe(3);

    // Inline self-contained handler → inlineHandler populated (no handlerName).
    const health = findRoute(routes, "GET", "/api/health");
    expect(health).toBeDefined();
    expect(health?.handlerName).toBeUndefined();
    expect(health?.inlineHandler).toBeDefined();

    // Arrow delegating to a bare-name call → handlerName extracted.
    const preScan = findRoute(routes, "GET", "/api/pre-scan");
    expect(preScan?.handlerName).toBe("handlePreScan");
    expect(preScan?.inlineHandler).toBeUndefined();

    const analyze = findRoute(routes, "POST", "/api/analyze");
    expect(analyze?.handlerName).toBe("handleAnalyze");
  });

  it("resolves a bare-identifier route-table handler by name", () => {
    const repoPath = createRepoWithFiles({
      "src/server/router.ts": `
        import { createUser } from "./handlers.js";
        const ROUTES = [
          { method: "POST", path: "/users", handler: createUser },
        ];
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    const route = findRoute(routes, "POST", "/users");
    expect(route).toBeDefined();
    expect(route?.handlerName).toBe("createUser");
  });

  it("accepts path-property aliases (url / route) and method alias (verb)", () => {
    const repoPath = createRepoWithFiles({
      "src/server/router.ts": `
        const ROUTES = [
          { verb: "GET", url: "/a", handler: () => null },
          { method: "DELETE", route: "/b", handler: () => null },
        ];
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    expect(findRoute(routes, "GET", "/a")).toBeDefined();
    expect(findRoute(routes, "DELETE", "/b")).toBeDefined();
  });

  it("extracts dynamic params from a route-table pattern", () => {
    const repoPath = createRepoWithFiles({
      "src/server/router.ts": `
        const ROUTES = [
          { method: "GET", pattern: "/users/:userId/posts/:postId", handler: () => null },
        ];
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    const route = findRoute(routes, "GET", "/users/:userId/posts/:postId");
    expect(route?.isDynamic).toBe(true);
    expect(route?.params).toEqual(expect.arrayContaining(["userId", "postId"]));
  });

  it("does NOT fire the route-table recognizer on a React Router children array", () => {
    // React Router arrays use {path, element/component}, no `method` field.
    const repoPath = createRepoWithFiles({
      "src/router.tsx": `
        const routes = [
          { path: "/users", element: "<Users/>" },
          { path: "/about", component: About },
        ];
      `,
    });
    // Use the react-router fingerprint so this never reaches the backend branch.
    const routes = analyzeFilesystem(repoPath, makeFingerprint("react", "react-router"));
    // React Router fixtures above aren't createBrowserRouter/useRoutes calls,
    // so they produce no routes — but more importantly, no BACKEND_ROUTE.
    expect(routes.every((r) => r.type !== "BACKEND_ROUTE")).toBe(true);
    deleteFakeRepo(repoPath);
  });

  it("does NOT fire the route-table recognizer on an arbitrary config array", () => {
    const repoPath = createRepoWithFiles({
      "src/config.ts": `
        const CONFIG = [
          { name: "health", url: "/health" },
          { name: "status", method: "ping", target: "/status" },
        ];
      `,
    });
    // Even in bun scan-all mode: first element has no method+"/path" combo, so the
    // route-table gate rejects it and zero routes are emitted.
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    expect(routes.every((r) => r.type !== "BACKEND_ROUTE")).toBe(true);
    deleteFakeRepo(repoPath);
  });

  // ─── Imperative recognizer (Express/Hono/Elysia share this shape) ────────

  it("detects Hono routes via app.METHOD(path, handler)", () => {
    const repoPath = createRepoWithFiles({
      "src/server/index.ts": `
        import { Hono } from "hono";
        import { getUser, createUser } from "./handlers.js";
        const app = new Hono();
        app.get("/users/:id", getUser);
        app.post("/users", createUser);
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("hono"));
    expect(findRoute(routes, "GET", "/users/:id")?.handlerName).toBe("getUser");
    expect(findRoute(routes, "POST", "/users")?.handlerName).toBe("createUser");
    deleteFakeRepo(repoPath);
  });

  it("detects Elysia routes via the app.METHOD(path, handler) API", () => {
    const repoPath = createRepoWithFiles({
      "src/server/index.ts": `
        import { Elysia } from "elysia";
        import { echo } from "./handlers.js";
        const app = new Elysia();
        app.get("/", () => "hello");
        app.post("/echo", echo);
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("elysia"));
    const root = findRoute(routes, "GET", "/");
    expect(root).toBeDefined();
    expect(root?.inlineHandler).toBeDefined();      // self-contained arrow
    expect(findRoute(routes, "POST", "/echo")?.handlerName).toBe("echo");
    deleteFakeRepo(repoPath);
  });

  it("detects an inline arrow handler on an imperative route (Express)", () => {
    const repoPath = createRepoWithFiles({
      "src/server/index.ts": `
        import express from "express";
        const app = express();
        app.get("/ping", (req, res) => res.json({ ok: true }));
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("express"));
    const route = findRoute(routes, "GET", "/ping");
    expect(route).toBeDefined();
    expect(route?.inlineHandler).toBeDefined();
    expect(route?.handlerName).toBeUndefined();
    deleteFakeRepo(repoPath);
  });

  // ─── Bun.serve fetch-handler (inline switch / if dispatch) ────────────────

  it("extracts ANY routes from a Bun.serve switch(pathname)", () => {
    const repoPath = createRepoWithFiles({
      "src/server/index.ts": `
        Bun.serve({
          port: 3000,
          fetch(req) {
            const url = new URL(req.url);
            switch (url.pathname) {
              case "/api/health": return Response.json({ ok: true });
              case "/api/users":   return Response.json([]);
              default: return new Response("not found", { status: 404 });
            }
          }
        });
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    const health = findRoute(routes, "ANY", "/api/health");
    const users = findRoute(routes, "ANY", "/api/users");
    expect(health).toBeDefined();
    expect(users).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("extracts ANY routes from a Bun.serve if-chain on req.url", () => {
    const repoPath = createRepoWithFiles({
      "src/server/index.ts": `
        Bun.serve({
          fetch: (req) => {
            if (req.url === "/ping") return new Response("pong");
            if ("/health" === req.url) return Response.json({ ok: true });
            return new Response("404", { status: 404 });
          }
        });
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    expect(findRoute(routes, "ANY", "/ping")).toBeDefined();
    expect(findRoute(routes, "ANY", "/health")).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("does NOT misfire on unrelated string equality compares inside fetch", () => {
    const repoPath = createRepoWithFiles({
      "src/server/index.ts": `
        Bun.serve({
          fetch(req) {
            const status = process.env.STATUS === "/done" ? "ok" : "bad";
            if (req.url === "/real") return new Response("hit");
            return new Response(status, { status: 500 });
          }
        });
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    // Only the url-ish comparison should yield a route; the STATUS === "/done"
    // compare has a non-url left side, so it must be ignored.
    const backendRoutes = routes.filter(
      (r): r is BackendRouteNode => r.type === "BACKEND_ROUTE" && r.urlPath === "/done"
    );
    expect(backendRoutes).toHaveLength(0);
    expect(findRoute(routes, "ANY", "/real")).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  // ─── Regression ────────────────────────────────────────────────────────────

  it("does not double-emit a route when recognized by multiple shapes", () => {
    // A route-table entry and an imperative call for the same path+method must
    // dedup to one node (shared `seen` set across recognizers).
    const repoPath = createRepoWithFiles({
      "src/server/index.ts": `
        import { Hono } from "hono";
        import { getUser } from "./handlers.js";
        const app = new Hono();
        app.get("/users/:id", getUser);
        // Unrelated route table in the same file — different path, must still emit.
        const EXTRA = [
          { method: "GET", pattern: "/users/:id", handler: () => null },
        ];
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("hono"));
    const matches = routes.filter(
      (r): r is BackendRouteNode =>
        r.type === "BACKEND_ROUTE" && r.httpMethod === "GET" && r.urlPath === "/users/:id"
    );
    expect(matches).toHaveLength(1);
    deleteFakeRepo(repoPath);
  });

  it("handles a Bun.serve app whose fetch delegates to a named router (OSS index.ts)", () => {
    // The entry file calls router(req) — no if/switch inside fetch, so the
    // Bun.serve recognizer must emit ZERO duplicates; routes come from the table.
    const repoPath = createRepoWithFiles({
      "src/server/index.ts": `
        import { router } from "./router.js";
        Bun.serve({ port: 3000, fetch: async (req) =>-await router(req) });
      `,
      "src/server/router.ts": `
        const ROUTES = [
          { method: "GET", pattern: "/api/health", handler: () => null },
        ];
      `,
    });
    const routes = analyzeFilesystem(repoPath, backendFingerprint("bun"));
    // Only one route, from the route table; fetch delegation emits nothing.
    expect(routes.filter((r): r is BackendRouteNode => r.type === "BACKEND_ROUTE")).toHaveLength(1);
    expect(findRoute(routes, "GET", "/api/health")).toBeDefined();
    deleteFakeRepo(repoPath);
  });

});
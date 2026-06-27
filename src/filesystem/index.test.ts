import fs from "fs";
import path from "path";
import os from "os";
import { analyzeFilesystem } from "./index.js";
import { ProjectFingerprint, RouteNode } from "../types.js";

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
  framework: "nextjs" | "react" | "unknown",
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
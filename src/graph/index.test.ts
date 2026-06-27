import fs from "fs";
import path from "path";
import os from "os";
import { parseRepo } from "../parser/index.js";
import { buildLookupMaps } from "./buildLookup.js";
import { detectCallEdges } from "./edges/callEdges.js";
import { detectImportEdges } from "./edges/importEdges.js";
import { detectStateEdges } from "./edges/stateEdges.js";
import { detectPropEdges } from "./edges/propEdges.js";
import { detectEventEdges } from "./edges/eventEdges.js";
import { detectGuardEdges } from "./edges/guardEdges.js";
import { detectRouteEdges } from "./edges/routeEdge.js";
import { detectEdges } from "./index.js";
import { detectNavigationEdges } from "./edges/navigationEdges.js";
import { CodeNode, ProjectFingerprint } from "../types.js";

//  Helpers 

function createFakeRepo(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "devlens-graph-test-")
  );
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return tmpDir;
}

function deleteFakeRepo(repoPath: string): void {
  fs.rmSync(repoPath, { recursive: true, force: true });
}

function makeFingerprint(
  overrides: Partial<ProjectFingerprint> = {}
): ProjectFingerprint {
  return {
    language: "typescript",
    projectType: "frontend",
    framework: "nextjs",
    router: "app",
    stateManagement: ["zustand"],
    dataFetching: ["fetch"],
    databases: [],
    rawDependencies: {},
    ...overrides,
  };
}

// Debug helper — prints all nodes found by parser
// Useful when a test is failing and you want to see what was extracted
function debugNodes(repoPath: string) {
  const { nodes } = parseRepo(repoPath);
  console.log("=== DEBUG NODES ===");
  for (const n of nodes) {
    console.log(`  ${n.type} | ${n.name} | ${n.filePath}`);
  }
  return nodes;
}

//  CALLS edges 

describe("detectCallEdges", () => {

  it("should detect a direct function call", () => {
    const repoPath = createFakeRepo({
      "src/payment.ts": `
        export function processPayment() {
          validateCard();
          chargeCard();
        }
        export function validateCard() { return true; }
        export function chargeCard() { return true; }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const { edges } = detectCallEdges(nodes, lookup);

    const callsValidate = edges.find(
      (e) =>
        e.type === "CALLS" &&
        e.from.includes("processPayment") &&
        e.to.includes("validateCard")
    );
    const callsCharge = edges.find(
      (e) =>
        e.type === "CALLS" &&
        e.from.includes("processPayment") &&
        e.to.includes("chargeCard")
    );

    expect(callsValidate).toBeDefined();
    expect(callsCharge).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("should not create edges for external calls", () => {
    const repoPath = createFakeRepo({
      "src/api.ts": `
        export async function fetchData() {
          const res = await fetch('/api/data');
          console.log(res);
          return res.json();
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const { edges } = detectCallEdges(nodes, lookup);

    // fetch and console.log are external — no edges expected
    const externalEdge = edges.find(
      (e) => e.to.includes("fetch") || e.to.includes("console")
    );
    expect(externalEdge).toBeUndefined();
    deleteFakeRepo(repoPath);
  });

  it("should not create self referencing edges", () => {
    const repoPath = createFakeRepo({
      "src/utils.ts": `
        export function factorial(n: number): number {
          if (n <= 1) return 1;
          return n * factorial(n - 1);
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const { edges } = detectCallEdges(nodes, lookup);

    const selfEdge = edges.find((e) => e.from === e.to);
    expect(selfEdge).toBeUndefined();
    deleteFakeRepo(repoPath);
  });

});

//  IMPORTS edges 

describe("detectImportEdges", () => {

  it("should detect relative imports between files", () => {
    // Both files in same src/ folder so relative import resolves cleanly
    const repoPath = createFakeRepo({
      "src/CheckoutButton.tsx": `
        import { processPayment } from "./PaymentService.js";
        export function CheckoutButton() {
          return <button onClick={processPayment}>Pay</button>;
        }
      `,
      "src/PaymentService.ts": `
        export function processPayment() {
          return true;
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const { edges } = detectImportEdges(lookup, repoPath);

    const importEdge = edges.find(
      (e) =>
        e.type === "IMPORTS" &&
        e.from.includes("CheckoutButton") &&
        e.to.includes("PaymentService")
    );
    expect(importEdge).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("should not create edges for third party imports", () => {
    const repoPath = createFakeRepo({
      "src/Component.tsx": `
        import React from "react";
        import axios from "axios";
        export function Component() {
          return <div />;
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const { edges } = detectImportEdges(lookup, repoPath);

    const thirdPartyEdge = edges.find(
      (e) =>
        e.metadata?.importPath === "react" ||
        e.metadata?.importPath === "axios"
    );
    expect(thirdPartyEdge).toBeUndefined();
    deleteFakeRepo(repoPath);
  });

  it("should not create duplicate edges for multiple imports from same file", () => {
    // Both files in same folder — simple relative imports
    const repoPath = createFakeRepo({
      "src/Checkout.tsx": `
        import { processPayment } from "./PaymentService.js";
        import { validateCard } from "./PaymentService.js";
        export function Checkout() {
          return <div />;
        }
      `,
      "src/PaymentService.ts": `
        export function processPayment() { return true; }
        export function validateCard() { return true; }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const { edges } = detectImportEdges(lookup, repoPath);

    // Count edges from Checkout to processPayment — should be exactly 1
    const duplicateEdges = edges.filter(
      (e) =>
        e.type === "IMPORTS" &&
        e.from.includes("Checkout") &&
        e.to.includes("PaymentService")
    );
    expect(duplicateEdges.length).toBe(1);
    deleteFakeRepo(repoPath);
  });

});

//  STATE edges 

describe("detectStateEdges", () => {

  it("should detect zustand store usage in a component", () => {
    const repoPath = createFakeRepo({
      "src/store.ts": `
        const useCartStore = create((set) => ({
          items: [],
          addItem: (item) => set((state) => ({
            items: [...state.items, item]
          })),
        }));
      `,
      "src/CheckoutButton.tsx": `
        export function CheckoutButton() {
          const items = useCartStore(state => state.items);
          return <div>{items.length}</div>;
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const edges = detectStateEdges(nodes, lookup);

    const readsEdge = edges.find(
      (e) =>
        e.type === "READS_FROM" &&
        e.from.includes("CheckoutButton") &&
        e.to.includes("useCartStore")
    );
    expect(readsEdge).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("should detect redux useSelector as READS_FROM", () => {
    const repoPath = createFakeRepo({
      "src/cartSlice.ts": `
        const cartSlice = createSlice({
          name: 'cart',
          initialState: { items: [] },
          reducers: {
            addItem: (state, action) => {
              state.items.push(action.payload);
            },
          }
        });
      `,
      "src/CartPage.tsx": `
        export function CartPage() {
          const items = useSelector(state => state.cart.items);
          return <div>{items.length}</div>;
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const edges = detectStateEdges(nodes, lookup);

    const readsEdge = edges.find(
      (e) =>
        e.type === "READS_FROM" &&
        e.from.includes("CartPage") &&
        e.to.includes("cartSlice")
    );
    expect(readsEdge).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("should detect redux useDispatch as WRITES_TO", () => {
    const repoPath = createFakeRepo({
      "src/cartSlice.ts": `
        const cartSlice = createSlice({
          name: 'cart',
          initialState: { items: [] },
          reducers: {
            addItem: (state, action) => {
              state.items.push(action.payload);
            },
          }
        });
      `,
      "src/AddToCart.tsx": `
        export function AddToCart() {
          const dispatch = useDispatch();
          return <button onClick={() => dispatch(addItem())}>Add</button>;
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const edges = detectStateEdges(nodes, lookup);

    const writesEdge = edges.find(
      (e) =>
        e.type === "WRITES_TO" &&
        e.from.includes("AddToCart") &&
        e.to.includes("cartSlice")
    );
    expect(writesEdge).toBeDefined();
    deleteFakeRepo(repoPath);
  });

});

//  PROP_PASS edges 

describe("detectPropEdges", () => {

  it("should detect prop passing from parent to child", () => {
    const repoPath = createFakeRepo({
      "src/OrderSummary.tsx": `
        export function OrderSummary() {
          const item = { name: "Product" };
          return <CartItem item={item} />;
        }
      `,
      "src/CartItem.tsx": `
        export function CartItem({ item }) {
          return <div>{item.name}</div>;
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const edges = detectPropEdges(nodes, lookup, repoPath);

    const propEdge = edges.find(
      (e) =>
        e.type === "PROP_PASS" &&
        e.from.includes("OrderSummary") &&
        e.to.includes("CartItem")
    );
    expect(propEdge).toBeDefined();
    expect(propEdge?.metadata?.props).toContain("item");
    deleteFakeRepo(repoPath);
  });

  it("should track renderCount when same child rendered multiple times", () => {
    const repoPath = createFakeRepo({
      "src/ProductList.tsx": `
        export function ProductList() {
          return (
            <div>
              <ProductCard product={products[0]} />
              <ProductCard product={products[1]} />
              <ProductCard product={products[2]} />
            </div>
          );
        }
      `,
      "src/ProductCard.tsx": `
        export function ProductCard({ product }) {
          return <div>{product.name}</div>;
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);

    // Only pass ProductList node — not ProductCard
    // ProductCard doesn't render any JSX children so it won't
    // create any PROP_PASS edges anyway, but filtering here
    // ensures renderCount is only counted from ProductList's body
    const productListOnly = nodes.filter(
      (n) => n.name === "ProductList"
    );

    const lookup = buildLookupMaps(nodes); // full lookup so ProductCard is findable
    const edges = detectPropEdges(productListOnly, lookup, repoPath);

    const propEdge = edges.find(
      (e) =>
        e.type === "PROP_PASS" &&
        e.from.includes("ProductList") &&
        e.to.includes("ProductCard")
    );
    expect(propEdge?.metadata?.renderCount).toBe(3);
    deleteFakeRepo(repoPath);
  });

  it("should skip HTML native elements", () => {
    const repoPath = createFakeRepo({
      "src/Form.tsx": `
        export function Form() {
          return (
            <div>
              <input type="text" />
              <button>Submit</button>
            </div>
          );
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const edges = detectPropEdges(nodes, lookup, repoPath);

    const nativeEdge = edges.find(
      (e) =>
        e.to.includes("input") ||
        e.to.includes("button") ||
        e.to.includes("div")
    );
    expect(nativeEdge).toBeUndefined();
    deleteFakeRepo(repoPath);
  });

});

//  EVENT edges 

describe("detectEventEdges", () => {

  it("should detect custom event emitter and create ghost node", () => {
    const repoPath = createFakeRepo({
      "src/payment.ts": `
        export function processPayment() {
          window.dispatchEvent(new CustomEvent('payment-complete'));
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const result = detectEventEdges(lookup, repoPath);

    const emitEdge = result.edges.find(
      (e) =>
        e.type === "EMITS" &&
        e.from.includes("processPayment")
    );
    const ghostNode = result.ghostNodes.find(
      (n) => n.name === "event:payment-complete"
    );

    expect(emitEdge).toBeDefined();
    expect(ghostNode).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("should detect event listener", () => {
    const repoPath = createFakeRepo({
      "src/notifications.ts": `
        export function setupListeners() {
          window.addEventListener('payment-complete', showConfirmation);
        }
        export function showConfirmation() {
          console.log('Payment complete');
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const result = detectEventEdges(lookup, repoPath);

    const listenEdge = result.edges.find(
      (e) =>
        e.type === "LISTENS" &&
        e.to.includes("setupListeners")
    );
    expect(listenEdge).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("should reuse ghost node for same event name", () => {
    const repoPath = createFakeRepo({
      "src/payment.ts": `
        export function processPayment() {
          window.dispatchEvent(new CustomEvent('payment-complete'));
        }
        export function setupListeners() {
          window.addEventListener('payment-complete', handlePayment);
        }
        export function handlePayment() {}
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const result = detectEventEdges(lookup, repoPath);

    const ghostNodes = result.ghostNodes.filter(
      (n) => n.name === "event:payment-complete"
    );
    // Same event name → exactly one ghost node
    expect(ghostNodes.length).toBe(1);
    deleteFakeRepo(repoPath);
  });

});

//  GUARDS edges 

describe("detectGuardEdges", () => {

  it("should detect Next.js middleware guards", () => {
    const repoPath = createFakeRepo({
      "middleware.ts": `
        import { NextRequest, NextResponse } from "next/server";

        export function middleware(request: NextRequest) {
          return NextResponse.next();
        }

        export const config = {
          matcher: ['/dashboard/:path*', '/admin/:path*']
        };
      `,
      "app/dashboard/page.tsx": `
        export default function DashboardPage() {
          return <div>Dashboard</div>;
        }
      `,
      "app/admin/page.tsx": `
        export default function AdminPage() {
          return <div>Admin</div>;
        }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const fingerprint = makeFingerprint({ framework: "nextjs" });

    const routeNodes = [
      {
        type: "PAGE" as const,
        urlPath: "/dashboard",
        filePath: path.join(repoPath, "app/dashboard/page.tsx"),
        isDynamic: false,
        isCatchAll: false,
        isGroupRoute: false,
      },
      {
        type: "PAGE" as const,
        urlPath: "/admin",
        filePath: path.join(repoPath, "app/admin/page.tsx"),
        isDynamic: false,
        isCatchAll: false,
        isGroupRoute: false,
      },
    ];

    const edges = detectGuardEdges(nodes, lookup, routeNodes, repoPath, fingerprint);

    const guardsDashboard = edges.find(
      (e) => e.type === "GUARDS" && e.to === "/dashboard"
    );
    const guardsAdmin = edges.find(
      (e) => e.type === "GUARDS" && e.to === "/admin"
    );

    expect(guardsDashboard).toBeDefined();
    expect(guardsAdmin).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("should detect Express middleware guards", () => {
    const repoPath = createFakeRepo({
      "src/server.ts": `
        import express from 'express';
        const app = express();

        export function requireAdmin(req: any, res: any, next: any) {
          next();
        }

        app.use('/admin', requireAdmin);
        app.get('/admin/users', getUsers);
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const lookup = buildLookupMaps(nodes);
    const fingerprint = makeFingerprint({
      framework: "express",
      projectType: "backend",
      router: "none",
      stateManagement: [],
      dataFetching: [],
    });

    const routeNodes = [
      {
        type: "BACKEND_ROUTE" as const,
        urlPath: "/admin/users",
        filePath: path.join(repoPath, "src/server.ts"),
        httpMethod: "GET" as const,
        framework: "express" as const,
        isDynamic: false,
        handlerName: "getUsers",
        params: [],
      },
    ];

    const edges = detectGuardEdges(nodes, lookup, routeNodes, repoPath, fingerprint);

    const guardsAdmin = edges.find(
      (e) => e.type === "GUARDS" && e.to === "/admin/users"
    );
    expect(guardsAdmin).toBeDefined();
    deleteFakeRepo(repoPath);
  });

});

//  Full pipeline 

describe("detectEdges", () => {

  it("should return edges and ghost nodes from full pipeline", () => {
    const repoPath = createFakeRepo({
      "src/payment.ts": `
        export function processPayment() {
          validateCard();
        }
        export function validateCard() { return true; }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const fingerprint = makeFingerprint();
    const result = detectEdges(nodes, [], repoPath, fingerprint);

    expect(result.edges).toBeDefined();
    expect(result.ghostNodes).toBeDefined();
    expect(Array.isArray(result.edges)).toBe(true);
    expect(Array.isArray(result.ghostNodes)).toBe(true);
    deleteFakeRepo(repoPath);
  });

  it("should detect calls edges in full pipeline", () => {
    const repoPath = createFakeRepo({
      "src/payment.ts": `
        export function processPayment() {
          validateCard();
        }
        export function validateCard() { return true; }
      `,
    });

    const { nodes } = parseRepo(repoPath);
    const fingerprint = makeFingerprint();
    const result = detectEdges(nodes, [], repoPath, fingerprint);

    const callEdge = result.edges.find(
      (e) =>
        e.type === "CALLS" &&
        e.from.includes("processPayment") &&
        e.to.includes("validateCard")
    );
    expect(callEdge).toBeDefined();
    deleteFakeRepo(repoPath);
  });

});

//  NAVIGATES_TO edges 

describe("detectNavigationEdges", () => {

  // Synthesizes a navigable ROUTE CodeNode the way routesToCodeNodes would,
  // so detectNavigationEdges can build its route index from it.
  function makeRouteCodeNode(
    urlPath: string,
    opts: { isDynamic?: boolean; filePath?: string } = {}
  ): CodeNode {
    const filePath = opts.filePath ?? "src/router.tsx";
    return {
      id: `${filePath}::${urlPath}`,
      name: urlPath,
      type: "ROUTE",
      filePath,
      startLine: 1,
      endLine: 1,
      metadata: {
        urlPath,
        routeNodeType: "REACT_ROUTER_ROUTE",
        isDynamic: opts.isDynamic ?? false,
        framework: "react-router",
        routeKind: "react-router",
      },
    };
  }

  it("creates a NAVIGATES_TO edge for navigate('/dashboard')", () => {
    const repoPath = createFakeRepo({
      "src/Page.tsx": `
        import { useNavigate } from "react-router-dom";
        export function Page() {
          const navigate = useNavigate();
          function go() { navigate('/dashboard'); }
          return <button onClick={go}>Go</button>;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    const routeNode = makeRouteCodeNode("/dashboard");
    const { edges } = detectNavigationEdges([...nodes, routeNode], repoPath);

    const navEdge = edges.find(
      (e) => e.type === "NAVIGATES_TO" && e.to === routeNode.id
    );
    expect(navEdge).toBeDefined();
    expect(navEdge?.metadata?.matchType).toBe("exact");
    deleteFakeRepo(repoPath);
  });

  it("matches router.push('/users/123') against a dynamic /users/:id route", () => {
    const repoPath = createFakeRepo({
      "src/Page.tsx": `
        import { useRouter } from "next/navigation";
        export function Page() {
          const router = useRouter();
          function go() { router.push('/users/123'); }
          return null;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    const routeNode = makeRouteCodeNode("/users/:id", { isDynamic: true });
    const { edges } = detectNavigationEdges([...nodes, routeNode], repoPath);

    const navEdge = edges.find(
      (e) => e.type === "NAVIGATES_TO" && e.to === routeNode.id
    );
    expect(navEdge).toBeDefined();
    expect(navEdge?.metadata?.matchType).toBe("dynamic");
    deleteFakeRepo(repoPath);
  });

  it("creates a NAVIGATES_TO edge for <Link to>", () => {
    const repoPath = createFakeRepo({
      "src/Nav.tsx": `
        import { Link } from "react-router-dom";
        export function Nav() {
          return <Link to="/about">About</Link>;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    const routeNode = makeRouteCodeNode("/about");
    const { edges } = detectNavigationEdges([...nodes, routeNode], repoPath);

    expect(
      edges.find((e) => e.type === "NAVIGATES_TO" && e.to === routeNode.id)
    ).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("detects native window.location.href and window.history.pushState", () => {
    const repoPath = createFakeRepo({
      "src/nav.ts": `
        export function login() {
          window.location.href = '/login';
        }
        export function pushX() {
          window.history.pushState(null, '', '/x');
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    const loginRoute = makeRouteCodeNode("/login");
    const xRoute = makeRouteCodeNode("/x");
    const { edges } = detectNavigationEdges([...nodes, loginRoute, xRoute], repoPath);

    expect(edges.find((e) => e.type === "NAVIGATES_TO" && e.to === loginRoute.id)).toBeDefined();
    expect(edges.find((e) => e.type === "NAVIGATES_TO" && e.to === xRoute.id)).toBeDefined();
    deleteFakeRepo(repoPath);
  });

  it("creates an unresolved ghost route (never [npm]/-prefixed) for an unmatched path", () => {
    const repoPath = createFakeRepo({
      "src/Page.tsx": `
        import { useNavigate } from "react-router-dom";
        export function Page() {
          const navigate = useNavigate();
          function go() { navigate('/nope-not-a-route'); }
          return null;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    // No matching route node provided → should synthesize an unresolved ghost.
    const { edges, ghostNodes } = detectNavigationEdges([...nodes], repoPath);

    const ghost = ghostNodes.find((n) => n.id === "[route]::/nope-not-a-route");
    expect(ghost).toBeDefined();
    expect(ghost?.type).toBe("ROUTE");
    expect(ghost?.id.startsWith("[npm]/")).toBe(false);
    expect(ghost?.metadata.isUnresolved).toBe(true);

    const edge = edges.find((e) => e.to === "[route]::/nope-not-a-route");
    expect(edge?.metadata?.matchType).toBe("unresolved");
    deleteFakeRepo(repoPath);
  });

  it("does NOT create a NAVIGATES_TO edge for <Link> from a non-routing lib (MUI)", () => {
    const repoPath = createFakeRepo({
      "src/Nav.tsx": `
        import { Link } from "@mui/material";
        export function Nav() {
          return <Link href="/about">About</Link>;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    const routeNode = makeRouteCodeNode("/about");
    const { edges } = detectNavigationEdges([...nodes, routeNode], repoPath);

    expect(edges.find((e) => e.type === "NAVIGATES_TO")).toBeUndefined();
    deleteFakeRepo(repoPath);
  });

  it("route node and react-router-dom THIRD_PARTY node coexist — distinct ids, no duplicates", () => {
    const repoPath = createFakeRepo({
      "src/Page.tsx": `
        import { useNavigate } from "react-router-dom";
        export function Page() {
          const navigate = useNavigate();
          function go() { navigate('/users'); }
          return null;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);

    // The react-router-dom package THIRD_PARTY node — synthesized as thirdPartyLibs
    // would create it (keyed by name) so importEdges materializes its method node.
    const pkgNode: CodeNode = {
      id: "[npm]/react-router-dom",
      name: "react-router-dom",
      type: "THIRD_PARTY",
      filePath: "[npm]/react-router-dom",
      startLine: 0,
      endLine: 0,
      metadata: { isThirdParty: true, packageVersion: "6.0.0", category: "routing" },
    };
    const routeNode = makeRouteCodeNode("/users");

    const inputNodes = [...nodes, pkgNode, routeNode];
    const fingerprint = makeFingerprint({ framework: "react", router: "react-router" });
    const result = detectEdges(inputNodes, [], repoPath, fingerprint);

    const allNodes = [...inputNodes, ...result.ghostNodes];

    const tpMethod = allNodes.find((n) => n.id === "[npm]/react-router-dom::useNavigate");
    const usersRoute = allNodes.find((n) => n.type === "ROUTE" && n.id === routeNode.id);

    // both exist, with disjoint namespaces
    expect(tpMethod).toBeDefined();
    expect(tpMethod?.type).toBe("THIRD_PARTY");
    expect(usersRoute).toBeDefined();
    expect(usersRoute?.id.startsWith("[npm]/")).toBe(false);
    expect(tpMethod?.id).not.toBe(usersRoute?.id);

    // no duplicate ids anywhere in the combined node set
    const ids = allNodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);

    // the NAVIGATES_TO edge coexists with the third-party CALLS/IMPORTS edges
    expect(
      result.edges.find((e) => e.type === "NAVIGATES_TO" && e.to === routeNode.id)
    ).toBeDefined();
    deleteFakeRepo(repoPath);
  });

});

//  HANDLES edges for React Router routes 

describe("detectRouteEdges — React Router", () => {

  function makeRRRouteNode(
    urlPath: string,
    rendersComponent: string,
    filePath = "src/App.tsx"
  ): CodeNode {
    return {
      id: `${filePath}::${urlPath}`,
      name: urlPath,
      type: "ROUTE",
      filePath,
      startLine: 1,
      endLine: 1,
      metadata: {
        urlPath,
        routeKind: "react-router",
        routeNodeType: "REACT_ROUTER_ROUTE",
        rendersComponent,
      },
    };
  }

  it("creates a HANDLES edge from a route to a component in the same file", () => {
    const repoPath = createFakeRepo({
      "src/App.tsx": `
        import { Routes, Route } from "react-router-dom";
        export function Home() { return <div>Home</div>; }
        export default function App() {
          return <Routes><Route path="/" element={<Home/>} /></Routes>;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    const routeNode = makeRRRouteNode("/", "Home");
    const allNodes = [...nodes, routeNode];
    const lookup = buildLookupMaps(allNodes);

    const edges = detectRouteEdges(allNodes, lookup);
    const handles = edges.find(
      (e) => e.type === "HANDLES" && e.from === routeNode.id && e.to.includes("Home")
    );
    expect(handles).toBeDefined();
    expect(handles?.metadata?.routeKind).toBe("react-router");
    deleteFakeRepo(repoPath);
  });

  it("resolves a route component imported from another file", () => {
    const repoPath = createFakeRepo({
      "src/Home.tsx": `export default function Home() { return <div>Home</div>; }`,
      "src/App.tsx": `
        import { Routes, Route } from "react-router-dom";
        import Home from "./Home";
        export default function App() {
          return <Routes><Route path="/" element={<Home/>} /></Routes>;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    const routeNode = makeRRRouteNode("/", "Home");
    const allNodes = [...nodes, routeNode];
    const lookup = buildLookupMaps(allNodes);

    const edges = detectRouteEdges(allNodes, lookup);
    const handles = edges.find(
      (e) => e.type === "HANDLES" && e.from === routeNode.id
    );
    expect(handles).toBeDefined();
    expect(handles?.to).toContain("Home.tsx");   // resolved across files, not App.tsx
    deleteFakeRepo(repoPath);
  });

  it("leaves a route with no resolvable component as an orphan (no HANDLES edge)", () => {
    const repoPath = createFakeRepo({
      "src/App.tsx": `
        import { Routes, Route } from "react-router-dom";
        export default function App() {
          return <Routes><Route path="/ghost" element={<Missing/>} /></Routes>;
        }
      `,
    });
    const { nodes } = parseRepo(repoPath);
    const routeNode = makeRRRouteNode("/ghost", "Missing");
    const allNodes = [...nodes, routeNode];
    const lookup = buildLookupMaps(allNodes);

    const edges = detectRouteEdges(allNodes, lookup);
    expect(edges.find((e) => e.from === routeNode.id)).toBeUndefined();
    deleteFakeRepo(repoPath);
  });

});
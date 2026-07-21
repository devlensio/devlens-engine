import path from "path";
import type { BackendRouteNode, ProjectFingerprint, RouteNode } from "../types.js";
import { analyzeAppRouter } from "./appRouter.js";
import { analyzePagesRouter } from "./pagesRouter.js";
import { analyzeBackendRoutes } from "./backendRoutes.js";
import { analyzeReactRouterRoutes } from "./reactRouterRoutes.js";

export function analyzeFilesystem(
  repoPath: string,
  fingerprint: ProjectFingerprint
): (RouteNode[] | BackendRouteNode[]) {

  // Handle backend frameworks first.
  // Same list as BACKEND_FRAMEWORKS in fingerprint/detectors.ts — kept inline
  // to avoid a circular import (detectors imports types, not filesystem).
  // framework is forwarded so analyzeBackendRoutes can pick a scan strategy
  // (import-gated for express/fastify/koa/hono/elysia, broad for bare bun).
  if (["express", "fastify", "koa", "hono", "elysia", "bun"].includes(fingerprint.framework)) {
    return analyzeBackendRoutes(repoPath, fingerprint.framework);
  }
  
   // Handle React Router projects (framework: "react", router: "react-router").
  // Routes are defined in code, so this runs before the Next.js gate below.
  if(fingerprint.router === "react-router"){
    return analyzeReactRouterRoutes(repoPath);
  }

  // Handle Next.js frontend
  if (fingerprint.framework !== "nextjs") {
    return [];
  }

  switch (fingerprint.router) {
    case "app":
      return analyzeAppRouter(repoPath);

    case "pages":
      return analyzePagesRouter(repoPath);

    case "app+pages":
      // Analyze both and merge results
      const appRoutes = analyzeAppRouter(repoPath);
      const pagesRoutes = analyzePagesRouter(repoPath);
      return [...appRoutes, ...pagesRoutes];

    default:
      console.warn(
        `Next.js project detected but no app or pages folder found at: ${path.resolve(repoPath)}`
      );
      return [];
  }
}
import path from "path";
import type { BackendRouteNode, ProjectFingerprint, RouteNode } from "../types.js";
import { analyzeAppRouter } from "./appRouter.js";
import { analyzePagesRouter } from "./pagesRouter.js";
import { analyzeBackendRoutes } from "./backendRoutes.js";

export function analyzeFilesystem(
  repoPath: string,
  fingerprint: ProjectFingerprint
): (RouteNode[] | BackendRouteNode[]) {

  // Handle backend frameworks first
  if (["express", "fastify", "koa"].includes(fingerprint.framework)) {
    return analyzeBackendRoutes(repoPath);
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
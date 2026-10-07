import { SourceFile, SyntaxKind } from "ts-morph";
import type { CodeNode } from "../../types.js";
import { detectFunctionDirective, type RenderingBoundary } from "../directives.js";
import {
  extractParams,
  extractBareTypeNames,
  extractReferencedInterfaces,
  type ParamInfo,
} from "../typeUtils.js";
import { extractCallsWithSites } from "./functions.js";

function makeId(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

// Try explicit annotation first; fall back to shape heuristic.
function extractReturnType(node: any): string {
  const explicit = node.getReturnTypeNode?.()?.getText();
  if (explicit) return explicit;

  const returnStatements = node.getDescendantsOfKind(SyntaxKind.ReturnStatement);
  if (returnStatements.length === 0) return "void";
  for (const ret of returnStatements) {
    const expr = ret.getExpression();
    if (!expr) continue;
    if (expr.getKind() === SyntaxKind.ArrayLiteralExpression) return "array";
    if (expr.getKind() === SyntaxKind.ObjectLiteralExpression) return "object";
  }
  return "unknown";
}

export function extractHooks(file: SourceFile, fileDirective: RenderingBoundary = null): CodeNode[] {
  const nodes: CodeNode[] = [];
  const filePath = file.getFilePath();

  // ─── Function Declaration Hooks ────────────────────────────────────────────
  // e.g. function useAuth() { ... }

  for (const fn of file.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;

    // Hooks must start with "use" followed by uppercase
    if (!/^use[A-Z]/.test(name)) continue;

    const { calls, callSites, dependencyNames: dependencies, contextRefs } = extractCallsWithSites(fn);
    const returnType = extractReturnType(fn);
    const isAsync = fn.isAsync();
    const renderingBoundary = detectFunctionDirective(fn.getBody()) ?? fileDirective;
    const typedParams = extractParams(fn);
    const bareTypeNames = extractBareTypeNames([...typedParams.map((p: ParamInfo) => p.type), returnType]);
    const referencedTypes = extractReferencedInterfaces(file, bareTypeNames);

    nodes.push({
      id: makeId(filePath, name),
      name,
      type: "HOOK",
      filePath,
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      rawCode: fn.getText(),
      metadata: {
        dependencies,
        calls,
        callSites,
        contextRefs,
        returnType,
        parameters: typedParams,
        referencedTypes,
        isAsync,
        ...(renderingBoundary !== null && { renderingBoundary }),
      },
    });
  }

  // ─── Arrow Function Hooks ──────────────────────────────────────────────────
  // e.g. const useAuth = () => { ... }

  for (const variable of file.getVariableDeclarations()) {
    const name = variable.getName();

    // Hooks must start with "use" followed by uppercase
    if (!/^use[A-Z]/.test(name)) continue;

    const initializer = variable.getInitializer();
    if (!initializer) continue;

    const isArrow = initializer.getKind() === SyntaxKind.ArrowFunction;
    if (!isArrow) continue;

    const { calls, callSites, dependencyNames: dependencies, contextRefs } = extractCallsWithSites(initializer);
    const returnType = extractReturnType(initializer);
    const isAsync = initializer.asKind(SyntaxKind.ArrowFunction)?.isAsync() ?? false;
    const renderingBoundary = detectFunctionDirective((initializer as any).getBody?.()) ?? fileDirective;
    const typedParams = extractParams(initializer);
    const bareTypeNames = extractBareTypeNames([...typedParams.map((p: ParamInfo) => p.type), returnType]);
    const referencedTypes = extractReferencedInterfaces(file, bareTypeNames);

    nodes.push({
      id: makeId(filePath, name),
      name,
      type: "HOOK",
      filePath,
      startLine: variable.getStartLineNumber(),
      endLine: variable.getEndLineNumber(),
      rawCode: variable.getText(),
      metadata: {
        dependencies,
        calls,
        callSites,
        contextRefs,
        returnType,
        parameters: typedParams,
        referencedTypes,
        isAsync,
        ...(renderingBoundary !== null && { renderingBoundary }),
      },
    });
  }

  return nodes;
}
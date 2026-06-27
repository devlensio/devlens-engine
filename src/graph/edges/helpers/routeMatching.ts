// Shared route/URL matching helpers used by both the Next.js API-call detector
// (apiFetchEdges.ts) and the navigation detector (navigationEdges.ts).

import { Project, SourceFile, SyntaxKind } from "ts-morph";
import path from "node:path";

// Converts a route urlPath into a matching RegExp.
//   :id    → [^/]+   (dynamic segment)
//   :slug* → .+      (catch-all)
//   static → escaped literally
export function urlPathtoRegex(urlPath: string): RegExp {
  const pattern = urlPath.split("/").map(segment => {
    if (segment.startsWith(":") && segment.endsWith("*")) return ".+";   // catch-all :slug*
    if (segment.startsWith(":")) return "[^/]+";     // dynamic :id
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");  // escape static segments
  }).join("\\/");
  return new RegExp(`^${pattern}$`);
}

// Converts a raw URL string from a call site into a normalized form comparable
// against route index entries.
//   `/api/users/${id}` → /api/users/:dynamic
//   /api/users?foo=bar → /api/users
//   /api/users/        → /api/users
// Returns null for external (http/https) or non-"/"-prefixed URLs.
export function normalizeUrl(rawUrl: string): string | null {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return null;
  if (!rawUrl.startsWith("/")) return null;

  return rawUrl
    .split("?")[0]                            // strip query string
    .replace(/\$\{[^}]+\}/g, ":dynamic")     // ${anything} → :dynamic
    .replace(/\/+$/, "")                      // strip trailing slash
    || "/";                                   // fallback to root if empty
}

// Reconstructs a template literal preserving ${...} as-is so normalizeUrl can
// replace them with :dynamic later.
export function reconstructTemplate(templateExpr: any): string {
  const head  = templateExpr.getHead().getLiteralText();
  const spans = templateExpr.getTemplateSpans().map((span: any) =>
    `\${${span.getExpression().getText()}}${span.getLiteral().getLiteralText()}`
  );
  return head + spans.join("");
}

// Extracts a string value from an initializer node (literal / template / etc).
function resolveVariableValue(initializer: any): string | null {
  const kind = initializer.getKind();
  if (kind === SyntaxKind.StringLiteral) {
    return initializer.getLiteralText();
  }
  if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return initializer.getLiteralText();
  }
  if (kind === SyntaxKind.TemplateExpression) {
    const head = initializer.getHead().getLiteralText();
    const spans = initializer.getTemplateSpans().map((span: any) =>
      `\${${span.getExpression().getText()}}${span.getLiteral().getLiteralText()}`
    );
    return head + spans.join("");
  }
  return null;     // object, function, computed — can't resolve
}

// Resolves a variable name to its string value (same file first, then named imports).
function resolveUrlVariable(varName: string, sourceFile: SourceFile, project: Project): string | null {
  const localDecl = sourceFile.getVariableDeclaration(varName);
  if (localDecl) {
    const init = localDecl.getInitializer();
    if (init) return resolveVariableValue(init);
  }

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const match = importDecl.getNamedImports().find(n => n.getName() === varName);
    if (!match) continue;

    let importedFile = importDecl.getModuleSpecifierSourceFile();

    if (!importedFile) {
      const specifier = importDecl.getModuleSpecifierValue();
      const currentDir = path.dirname(sourceFile.getFilePath());
      const base = path.resolve(currentDir, specifier);

      for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
        try {
          importedFile = project.addSourceFileAtPath(base + ext);
          break;
        } catch {
          continue;
        }
      }
    }
    if (!importedFile) continue;

    const importedDecl = importedFile.getVariableDeclaration(varName);
    if (importedDecl) {
      const init = importedDecl.getInitializer();
      if (init) return resolveVariableValue(init);
    }
  }

  return null;
}

// Extracts a URL string from a call/attr argument node.
//   '/api/users'        → string literal      → return directly
//   `/api/users`        → no-sub template     → return directly
//   `/api/users/${id}`  → template expression → preserve ${...}
//   API_URL             → identifier          → resolve via resolveUrlVariable
// Returns null for objects/arrays/expressions we can't resolve.
export function extractUrlFromArg(
  arg:        any,
  sourceFile: SourceFile,
  project:    Project,
): { rawUrl: string; resolvedUrl: string } | null {
  const kind = arg.getKind();

  if (kind === SyntaxKind.StringLiteral ||
      kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const url = arg.getLiteralText();
    return { rawUrl: url, resolvedUrl: url };
  }

  if (kind === SyntaxKind.TemplateExpression) {
    const url = reconstructTemplate(arg);
    return { rawUrl: url, resolvedUrl: url };
  }

  if (kind === SyntaxKind.Identifier) {
    const varName  = arg.getText();
    const resolved = resolveUrlVariable(varName, sourceFile, project);
    if (!resolved) return null;
    return { rawUrl: varName, resolvedUrl: resolved };
  }

  return null;
}

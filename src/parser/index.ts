import { Project } from "ts-morph";
import path from "path";
import fs from "fs";
import type { CodeNode, GraphExports } from "../types.js";
import { extractComponents } from "./extractors/components.js";
import { extractHooks } from "./extractors/hooks.js";
import { extractFunctions } from "./extractors/functions.js";
import { extractStores } from "./extractors/stores.js";
import { extractObjectMethods } from "./extractors/objectMethods.js";
import { extractClasses } from "./extractors/classes.js";
import { detectFileDirective } from "./directives.js";
import { applyOverloadDisambiguation } from "./overloads.js";
import { buildExportsMap, validateExportsMap, exportsMapStats } from "./exportsMap.js";
import { createHash } from "crypto";

// Directories to skip entirely while walking
const IGNORE_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "migrations",
  ".git",
];

// File patterns to skip
function shouldIgnoreFile(fileName: string): boolean {
  // In V1.0 I am now detecting test and story files as well because we have added an edge TESTS and 2 node types TEST and STORY
  // if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(fileName)) return true;
  // if (/\.stories\.(ts|tsx|js|jsx)$/.test(fileName)) return true;
  if (/\.d\.ts$/.test(fileName)) return true;
  if (/\.config\.(ts|js)$/.test(fileName)) return true;
  return false;
}

function getFileNodeType(fileName: string): "TEST" | "STORY" | "FILE" {
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(fileName)) return "TEST";
  if (/\.stories\.(ts|tsx|js|jsx)$/.test(fileName)) return "STORY";
  return "FILE";
}

// Recursively walks directory and adds valid source files to the project
function addFilesRecursively(dir: string, project: Project): void {
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // If we can't read a directory just skip it
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip ignored directories immediately
      if (IGNORE_DIRS.includes(entry.name)) continue;
      addFilesRecursively(fullPath, project);
    } else if (entry.isFile()) {
      // Only process source files
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      // Skip ignored file patterns
      if (shouldIgnoreFile(entry.name)) continue;
      project.addSourceFileAtPath(fullPath);
    }
  }
}

export interface ParserResult {
  nodes: CodeNode[];
  exports?: GraphExports;
  stats: {
    totalFiles: number;
    totalNodes: number;
    componentCount: number;
    hookCount: number;
    functionCount: number;
    storeCount: number;
    classCount: number;
    methodCount: number;
    skippedFiles: number;
  };
}

export function parseRepo(repoPath: string): ParserResult {
  // Set up ts-morph project
  const project = new Project({
    compilerOptions: {
      allowJs: true,    // support plain JS files
      checkJs: false,   // don't type check JS, just parse
      jsx: 4,           // support JSX (4 = React)
      strict: false,    // don't enforce strict mode on user's code
    },
    skipAddingFilesFromTsConfig: true,
  });

  // Walk directory and add files manually
  // This approach works reliably on all platforms including Windows
  addFilesRecursively(repoPath, project);

  const sourceFiles = project.getSourceFiles();
  const allNodes: CodeNode[] = [];
  let skippedFiles = 0;


  for (const file of sourceFiles) {
    try {
      const absFilePath = file.getFilePath();
      const relativePath = path.relative(repoPath, absFilePath).replace(/\\/g, "/");
      const fileType = getFileNodeType(path.basename(relativePath)); // returns either TEST / STORY / FILE type

      // One FILE node per source file — represents the file itself in the graph
      const fileNode: CodeNode = {
        id: `file::${relativePath}`,
        name: path.basename(relativePath),
        type: fileType,
        filePath: relativePath,
        startLine: 1,
        endLine: file.getEndLineNumber(),
        parentFile: `file::${relativePath}`,  //there is no parent file for file type node
        metadata: {
          nodeCount: 0,
          childNodeIds: [],
          language: absFilePath.endsWith('.ts') || absFilePath.endsWith('.tsx') ? 'typescript' :
            absFilePath.endsWith('.js') || absFilePath.endsWith('.jsx') ? 'javascript' : 'unknown',
        },
      };

      const fileDirective = detectFileDirective(file);
      const components = extractComponents(file, fileDirective);
      const hooks = extractHooks(file, fileDirective);
      const functions = extractFunctions(file, fileDirective);
      const stores = extractStores(file);
      const objectMethods = extractObjectMethods(file, fileDirective);
      const classes = extractClasses(file, fileDirective);

      const extracted = [...components, ...hooks, ...functions, ...stores, ...objectMethods, ...classes];

      for (const node of extracted) {
        // Normalize all extracted nodes to relative paths so every node in the
        // graph uses the same coordinate system as the FILE nodes.
        // Extractors store absolute ts-morph paths; we rewrite them here.
        node.filePath = relativePath;
        node.id = `${relativePath}::${node.name}`;
        node.parentFile = `file::${relativePath}`;
        if (node.rawCode) {
          node.codeHash = createHash("sha256").update(node.rawCode).digest("hex").slice(0, 16);
        }
      }

      // Same-name function-likes in one file (overloads) get arity/signature
      // discriminator suffixes; signature-identical declarations collapse.
      applyOverloadDisambiguation(extracted, relativePath);
      const overloads = extracted.filter((n) => !n.metadata.isDuplicateOverload);

      if (fileType === "TEST" || fileType === "STORY") {
        // Do not add child nodes for test/story files — they are test helpers,
        fileNode.metadata.testCases = overloads.map(n => n.name);
        fileNode.metadata.nodeCount = 0;
        fileNode.metadata.childNodeIds = [];

        // File hash based on all child code combined
        const fileRawCode = overloads.map(n => n.rawCode ?? "").join("\n");
        if (fileRawCode.trim()) {
          fileNode.codeHash = createHash("sha256")
            .update(fileRawCode).digest("hex").slice(0, 16);
        }

        allNodes.push(fileNode); // only the file node, no children

      }
      else {
        fileNode.metadata.nodeCount = overloads.length;
        fileNode.metadata.childNodeIds = overloads.map(n => n.id);
        // File node hash — based on all child code combined
        const fileRawCode = overloads.map(n => n.rawCode ?? "").join("\n");
        if (fileRawCode.trim()) {
          fileNode.codeHash = createHash("sha256").update(fileRawCode).digest("hex").slice(0, 16);
        }

        allNodes.push(fileNode, ...overloads);
      }

    } catch (error) {
      // Never let one bad file break the entire analysis
      console.warn(`Skipped file due to error: ${file.getFilePath()}`);
      skippedFiles++;
    }
  }

  const componentCount = allNodes.filter((n) => n.type === "COMPONENT").length;
  const hookCount = allNodes.filter((n) => n.type === "HOOK").length;
  const functionCount = allNodes.filter((n) => n.type === "FUNCTION").length;
  const storeCount = allNodes.filter((n) => n.type === "STATE_STORE").length;
  const classCount = allNodes.filter((n) => n.type === "CLASS").length;
  const methodCount = allNodes.filter((n) => n.type === "METHOD").length;

  let exports: GraphExports | undefined;
  try {
    const built = buildExportsMap(project, repoPath, allNodes);
    if (built) {
      const dangling = validateExportsMap(built, new Set(allNodes.map((n) => n.id)));
      if (dangling.length > 0) {
        console.warn(`Exports map: dropping ${dangling.length} dangling nodeId references`);
        for (const perPath of Object.values(built.exports)) {
          for (const [name, ids] of Object.entries(perPath)) {
            const filtered = ids.filter((id) => !dangling.includes(id));
            if (filtered.length > 0) perPath[name] = filtered;
            else delete perPath[name];
          }
        }
        for (const [subpath, perPath] of Object.entries(built.exports)) {
          if (Object.keys(perPath).length === 0) delete built.exports[subpath];
        }
      }
      if (Object.keys(built.exports).length > 0) {
        exports = built;
        const s = exportsMapStats(built);
        console.log(`  Exports map: ${s.names} names across ${s.subpaths} subpath(s), ${s.ambiguous} ambiguous`);
      }
    }
  } catch (err) {
    console.warn(`Exports map build failed — continuing without it: ${err}`);
  }

  return {
    nodes: allNodes,
    exports,
    stats: {
      totalFiles: sourceFiles.length,
      totalNodes: allNodes.length,
      componentCount,
      hookCount,
      functionCount,
      storeCount,
      classCount,
      methodCount,
      skippedFiles,
    },
  };
}
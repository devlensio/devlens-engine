import type { Node } from "ts-morph";
import type { CodeNode } from "../types.js";
/** base id (`file::name`, no overload suffix) → every node sharing that base */
export type NodeIndex = Map<string, CodeNode[]>;
export declare function buildNodeIndex(nodes: CodeNode[]): NodeIndex;
/** Repo-relative path of a declaration's source file, posix separators. */
export declare function relativePathOf(decl: Node, repoPath: string): string;
/**
 * Name of the declaration behind an exported name.
 * Prefers the declaration's own `getName()` (functions, classes, variables) and
 * falls back to the symbol name. Returns undefined for anonymous declarations —
 * those have no node and are therefore not linkable.
 */
export declare function declarationName(decl: Node): string | undefined;
/**
 * Map an exported declaration to the node it produced.
 * `base` is the collection key (useful for ambiguity detection: two different
 * bases under one exported name means the name denotes more than one symbol).
 */
export declare function resolveDeclarationToNode(decl: Node, repoPath: string, nodeIndex: NodeIndex): {
    id: string;
    base: string;
} | undefined;

import { fileStorage } from "./fileStorage.js";
import type { GraphStorage } from "./interface.js";

export const storage: GraphStorage = fileStorage;

// Re-export types so consumers only need to import from storage/index
export type { GraphIndexEntry, GraphMeta, CommitData, NodeDiff } from "./fileStorage.js";
export type { GraphStorage } from "./interface.js";
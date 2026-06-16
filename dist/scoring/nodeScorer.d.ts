import type { CodeNode } from "../types.js";
import type { ConnectionProfile, ConnectionMaxima } from "./connectionCounter.js";
export declare function scoreNode(node: CodeNode, profile: ConnectionProfile, maxima: ConnectionMaxima): number;

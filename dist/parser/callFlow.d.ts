import { type Node } from "ts-morph";
import type { CallScope, DeferKind } from "../types.js";
export interface CallAnnotations {
    col: number;
    scope: CallScope;
    nested?: number;
    awaited?: boolean;
    defer?: DeferKind;
    deferDetail?: string;
    conc?: boolean;
    repeat?: boolean;
    maybe?: boolean;
}
export declare function isIifeCallee(callee: Node): boolean;
export declare function annotateCall(call: Node, owner: Node, isFileOwner: boolean, ordinals: Map<Node, number>): CallAnnotations;

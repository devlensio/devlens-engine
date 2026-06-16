import type { CodeNode, CodeEdge } from "../types.js";
export interface ConnectionProfile {
    incomingCalls: number;
    outgoingCalls: number;
    incomingReads: number;
    incomingWrites: number;
    incomingProps: number;
    outgoingProps: number;
    importedBy: number;
}
export interface ConnectionMaxima {
    maxIncomingCalls: number;
    maxOutgoingCalls: number;
    maxIncomingReads: number;
    maxIncomingWrites: number;
    maxIncomingProps: number;
    maxOutgoingProps: number;
    maxImportedBy: number;
    p75IncomingCalls: number;
    p75OutgoingCalls: number;
    p75IncomingReads: number;
    p75IncomingProps: number;
}
export interface ConnectionCountResult {
    profiles: Map<string, ConnectionProfile>;
    maxima: ConnectionMaxima;
}
export declare function countConnections(nodes: CodeNode[], edges: CodeEdge[]): ConnectionCountResult;

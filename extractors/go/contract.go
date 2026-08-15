// contract.go — the JSON shape DevLens Engine expects.
//
// Every key here is camelCase to match the TypeScript interfaces in the
// devlens-engine (src/types.ts, src/extractors/types.ts). This file is the
// single source of truth for the output shape; other modules never spell
// keys by hand.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"path"
)

// ── Node types (subset of the engine's NodeType union used by Go) ──
const (
	NodeFile       = "FILE"
	NodeFunction   = "FUNCTION"
	NodeMethod     = "METHOD"
	NodeStruct     = "STRUCT"
	NodeInterface  = "INTERFACE"
	NodePackage    = "PACKAGE"
	NodeTest       = "TEST"
	NodeRoute      = "ROUTE"
	NodeThirdParty = "THIRD_PARTY"
	NodeEnum       = "ENUM"
)

// ── Edge types (subset of the engine's EdgeType union used by Go) ──
const (
	EdgeCalls      = "CALLS"
	EdgeImports    = "IMPORTS"
	EdgeExtends    = "EXTENDS"
	EdgeImplements = "IMPLEMENTS"
	EdgeHandles    = "HANDLES"
	EdgeTests      = "TESTS"
	EdgeReadsFrom  = "READS_FROM"
	EdgeWritesTo   = "WRITES_TO"
)

// codeHash = sha256(rawCode) hex-encoded, first 16 chars (contract rule).
func codeHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])[:16]
}

// ── Fingerprint ──

type Fingerprint struct {
	Language        string            `json:"language"`
	ProjectType     string            `json:"projectType"`
	Framework       string            `json:"framework"`
	Router          string            `json:"router"`
	StateManagement []string          `json:"stateManagement"`
	DataFetching    []string          `json:"dataFetching"`
	Databases       []string          `json:"databases"`
	RawDependencies map[string]string `json:"rawDependencies"`
}

func newFingerprint() *Fingerprint {
	return &Fingerprint{
		Language:        "go",
		ProjectType:     "unknown",
		Framework:       "unknown",
		Router:          "none",
		StateManagement: []string{},
		DataFetching:    []string{},
		Databases:       []string{},
		RawDependencies: map[string]string{},
	}
}

// ── Stats / Errors / Result ──

type Stats struct {
	TotalFiles   int `json:"totalFiles"`
	TotalNodes   int `json:"totalNodes"`
	SkippedFiles int `json:"skippedFiles"`
}

type ExtractorError struct {
	File  string `json:"file,omitempty"`
	Error string `json:"error"`
}

type ExtractorResult struct {
	Fingerprint *Fingerprint     `json:"fingerprint"`
	Nodes       []map[string]any `json:"nodes"`
	Edges       []map[string]any `json:"edges"`
	Routes      []map[string]any `json:"routes"`
	Stats       Stats            `json:"stats"`
	Errors      []ExtractorError `json:"errors"`
}

// ── Node / edge builders ──

// fileNode — FILE (or TEST) node. Id format: file::rel/path.go (matches
// src/parser/index.ts). File nodes parent themselves.
func fileNode(relPath string, endLine int, nodeType string) map[string]any {
	return map[string]any{
		"id":         "file::" + relPath,
		"name":       path.Base(relPath),
		"type":       nodeType,
		"filePath":   relPath,
		"startLine":  1,
		"endLine":    endLine,
		"parentFile": "file::" + relPath,
		"metadata": map[string]any{
			"nodeCount":    0,
			"childNodeIds": []any{},
			"language":     "go",
		},
	}
}

// codeNode — FUNCTION/METHOD/STRUCT/INTERFACE/ENUM/PACKAGE/THIRD_PARTY/ROUTE.
// rawCode on every code node (summarizer input — engine discards after).
func codeNode(id, relPath, name, nodeType string, startLine, endLine int, rawCode string, metadata map[string]any) map[string]any {
	return map[string]any{
		"id":         id,
		"name":       name,
		"type":       nodeType,
		"filePath":   relPath,
		"startLine":  startLine,
		"endLine":    endLine,
		"parentFile": "file::" + relPath,
		"codeHash":   codeHash(rawCode),
		"rawCode":    rawCode,
		"metadata":   metadata,
	}
}

func edge(from, to, etype string) map[string]any {
	return map[string]any{"from": from, "to": to, "type": etype}
}

func edgeWithMeta(from, to, etype string, metadata map[string]any) map[string]any {
	return map[string]any{"from": from, "to": to, "type": etype, "metadata": metadata}
}

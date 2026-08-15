// imports.go — PACKAGE nodes + IMPORTS edges + [mod] third-party nodes.
//
// Resolution (documented Go semantics): an import path is internal when it
// starts with the module path (honoring `replace` directives, including
// filesystem replaces) — otherwise external → [mod]/... node (gated). std
// packages (no dot in first path element) → no node, no edge. Go imports
// PACKAGES, so the IMPORTS edge targets the PACKAGE node (one edge per
// import; the package's files ride in the package node's metadata).

package main

import (
	"path/filepath"
	"strings"
)

// pkgNode — PACKAGE node for a local package directory.
func pkgNode(importPath, name string, fileRels []string) map[string]any {
	return map[string]any{
		"id":        pkgNodeID(importPath),
		"name":      name,
		"type":      "PACKAGE",
		"filePath":  "",
		"startLine": 0,
		"endLine":   0,
		"metadata": map[string]any{
			"importPath": importPath,
			"files":      fileRels,
			"language":   "go",
		},
	}
}

// detectImports — returns PACKAGE nodes + IMPORTS edges. Also seeds the
// shared ThirdPartyRegistry on the lookups (imports/calls/inheritance share
// one gated registry per extraction).
func detectImports(pr *parsedRepo, l *LookupMaps, opts *Options, fp *Fingerprint) ([]map[string]any, []map[string]any) {
	nodes := []map[string]any{}
	edges := []map[string]any{}

	l.tp = newThirdPartyRegistry(opts.IncludeThirdPartyLibs, fp, l)

	// PACKAGE nodes for every local package (import path → dir).
	dirByImportPath := map[string]string{}
	for _, pkg := range pr.packages {
		relFiles := make([]string, 0, len(pkg.Files))
		for _, pf := range pkg.Files {
			relFiles = append(relFiles, pf.RelPath)
		}
		n := pkgNode(pkg.ImportPath, pkg.Name, relFiles)
		nodes = append(nodes, n)
		l.PkgNodesByPath[pkg.ImportPath] = n
		l.NodeByID[pkgNodeID(pkg.ImportPath)] = n
		dirByImportPath[pkg.ImportPath] = pkg.Dir
	}
	// replace-directive aliases: import path → local dir (filesystem replaces)
	fsReplaceDir := map[string]string{}
	for old, newp := range pr.mod.Replaces {
		if strings.HasPrefix(newp, "./") || strings.HasPrefix(newp, "../") || strings.HasPrefix(newp, "/") {
			fsReplaceDir[old] = strings.TrimPrefix(filepath.ToSlash(newp), "./")
		}
	}

	for _, pf := range pr.files {
		fileID := "file::" + pf.RelPath
		for _, imp := range pf.Imports {
			p := imp.Path
			if isStdImport(p) {
				continue // std: no node, no edge
			}
			// internal? (a) module-prefixed, (b) replace → filesystem dir
			if _, ok := l.PkgNodesByPath[p]; ok {
				edges = append(edges, edgeWithMeta(fileID, pkgNodeID(p), EdgeImports,
					map[string]any{"importPath": p}))
				continue
			}
			if dir, ok := fsReplaceDir[p]; ok {
				// find the local package whose Dir matches
				target := ""
				for ip, d := range dirByImportPath {
					if strings.TrimPrefix(filepath.ToSlash(d), "./") == dir {
						target = ip
						break
					}
				}
				if target != "" {
					edges = append(edges, edgeWithMeta(fileID, pkgNodeID(target), EdgeImports,
						map[string]any{"importPath": p, "replacedBy": target}))
					continue
				}
			}
			// external → [mod]/... (gated)
			if n := l.tp.packageNode(p); n != nil {
				edges = append(edges, edgeWithMeta(fileID, n["id"].(string), EdgeImports,
					map[string]any{"importPath": p, "isThirdParty": true}))
			}
		}
	}
	return nodes, edges
}

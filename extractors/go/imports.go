// imports.go — IMPORTS edges + [mod] third-party nodes + the local-package
// membership index. No PACKAGE nodes (removed 2026-08-17 — engine-wide
// connected-only pruning makes package stubs obsolete; import edges now
// target the imported package's FILES, matching JS/Java/Rust).
//
// Resolution (documented Go semantics): an import path is internal when it
// starts with the module path (honoring `replace` directives, including
// filesystem replaces) — otherwise external → [mod]/... node (gated). std
// packages (no dot in first path element) → no node, no edge. Go imports
// PACKAGES, so the IMPORTS edge fans out from the importing FILE to every
// non-test FILE of the target package (one edge per file; package identity
// rides in each file's metadata.package).

package main

import (
	"path/filepath"
	"strings"
)

// detectImports — returns IMPORTS edges + seeds the shared ThirdPartyRegistry
// (imports/calls/inheritance share one gated registry per extraction) and the
// PkgNodesByPath membership index (local-vs-external checks in
// calls/routes/orm/inheritance — key presence only, values unused).
func detectImports(pr *parsedRepo, l *LookupMaps, opts *Options, fp *Fingerprint) []map[string]any {
	edges := []map[string]any{}

	l.tp = newThirdPartyRegistry(opts.IncludeThirdPartyLibs, fp, l)

	// Index: import path → non-test files of that package (FILE→FILE targets),
	// plus import path → dir for filesystem-replace resolution.
	filesByImportPath := map[string][]string{}
	dirByImportPath := map[string]string{}
	for _, pkg := range pr.packages {
		l.PkgNodesByPath[pkg.ImportPath] = nil // membership marker only
		relFiles := []string{}
		for _, pf := range pkg.Files {
			if pf.IsTest {
				continue // test files are never import targets (leaf rule)
			}
			relFiles = append(relFiles, pf.RelPath)
		}
		filesByImportPath[pkg.ImportPath] = relFiles
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
			// internal? (a) module-prefixed → package files, (b) replace →
			// filesystem dir → that package's files
			targets, ok := filesByImportPath[p]
			if !ok {
				if dir, ok := fsReplaceDir[p]; ok {
					for ip, d := range dirByImportPath {
						if strings.TrimPrefix(filepath.ToSlash(d), "./") == dir {
							targets = filesByImportPath[ip]
							ok = true
							break
						}
					}
				}
			}
			if ok {
				for _, rel := range targets {
					edges = append(edges, edgeWithMeta(fileID, "file::"+rel, EdgeImports,
						map[string]any{"importPath": p}))
				}
				continue
			}
			// external → [mod]/... (gated)
			if n := l.tp.packageNode(p); n != nil {
				edges = append(edges, edgeWithMeta(fileID, n["id"].(string), EdgeImports,
					map[string]any{"importPath": p, "isThirdParty": true}))
			}
		}
	}
	return edges
}

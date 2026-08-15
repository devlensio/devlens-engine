// typeload.go — go/types type-checking, fully self-contained.
//
// REVISED from the plan: go/packages is NOT stdlib (it lives in
// golang.org/x/tools) and would drag in a build-time network dep + a runtime
// dependency on the `go` command. Instead we type-check the module's own
// packages in-process:
//
//   - local packages: checked in dependency order (Go import graphs are
//     acyclic) from the already-parsed ASTs
//   - std packages: importer.Default() (compiled-in export data; degrades to
//     import errors on machines without a GOROOT — harmless, errors ignored)
//   - external packages: import error → unresolved (degraded) — calls to them
//     resolve via name-based [mod] lazy edges anyway
//
// All checker errors are swallowed (we're type-RESOLVING, not verifying).
// The result is per-file *types.Info: Selections/Uses give exact local call
// targets, and package scopes give exact type objects for IMPLEMENTS.
//
// The binary stays static and offline — no `go` command needed at runtime.

package main

import (
	"go/ast"
	"go/importer"
	"go/token"
	"go/types"
	"sort"
)

type TypeInfo struct {
	Mode     string             // "typed" — informational
	Infos    map[string]*types.Info // rel file path → type info for that file
	Pkgs     map[string]*types.Package // import path → checked package
	Checks   int
	Failures int
}

// loadTypes — type-check every package in dependency order.
func loadTypes(pr *parsedRepo, addError errFn) *TypeInfo {
	ti := &TypeInfo{
		Mode:  "typed",
		Infos: map[string]*types.Info{},
		Pkgs:  map[string]*types.Package{},
	}

	// Check units: a package's own files (non-test + same-package test files)
	// and — for *_test.go files declaring a DIFFERENT package name
	// (package foo_test) — a synthetic package with import path <dir>_test.
	type unit struct {
		path  string
		files []*ParsedFile
		fset  *token.FileSet
	}
	units := []*unit{}
	byPath := map[string]*unit{}
	for _, pkg := range pr.packages {
		own := &unit{path: pkg.ImportPath, fset: pkg.fset}
		ext := &unit{path: pkg.ImportPath + "_test", fset: pkg.fset}
		byPath[own.path] = own
		byPath[ext.path] = ext
		for _, pf := range pkg.Files {
			if pf.IsTest && pf.PkgName != pkg.Name {
				ext.files = append(ext.files, pf)
			} else {
				own.files = append(own.files, pf)
			}
		}
		units = append(units, own, ext)
	}

	// internal deps per unit (imports that resolve to local packages)
	depPaths := func(u *unit) []string {
		seen := map[string]bool{}
		var deps []string
		for _, pf := range u.files {
			for _, imp := range pf.Imports {
				if _, ok := byPath[imp.Path]; ok && !seen[imp.Path] {
					seen[imp.Path] = true
					deps = append(deps, imp.Path)
				}
			}
		}
		sort.Strings(deps)
		return deps
	}

	// importer: local packages in-memory; std via importer.Default(); external
	// → error (degraded, fine).
	stdImp := importer.Default()
	imp := importerFunc(func(path string) (*types.Package, error) {
		if p, ok := ti.Pkgs[path]; ok {
			return p, nil
		}
		if _, local := byPath[path]; local {
			return nil, errNotCheckedYet
		}
		return stdImp.Import(path)
	})

	// topological order over the internal import graph
	done := map[string]bool{}
	var order []*unit
	for len(order) < len(units) {
		progress := false
		for _, u := range units {
			if done[u.path] || len(u.files) == 0 {
				done[u.path] = true
				continue
			}
			ready := true
			for _, d := range depPaths(u) {
				if !done[d] {
					ready = false
					break
				}
			}
			if ready {
				done[u.path] = true
				order = append(order, u)
				progress = true
			}
		}
		if !progress {
			// cycle / unresolvable internal dep — check what we can
			for _, u := range units {
				if !done[u.path] && len(u.files) > 0 {
					done[u.path] = true
					order = append(order, u)
				}
			}
			break
		}
	}

	for _, u := range order {
		if len(u.files) == 0 {
			continue
		}
		files := make([]*ast.File, 0, len(u.files))
		for _, pf := range u.files {
			files = append(files, pf.AST)
		}
		info := &types.Info{
			Types:      map[ast.Expr]types.TypeAndValue{},
			Uses:       map[*ast.Ident]types.Object{},
			Selections: map[*ast.SelectorExpr]*types.Selection{},
			Defs:       map[*ast.Ident]types.Object{},
			Implicits:  map[ast.Node]types.Object{},
		}
		conf := types.Config{
			Importer: imp,
			Error:    func(error) {}, // swallow — resolution, not verification
		}
		pkg, _ := conf.Check(u.path, u.fset, files, info)
		if pkg == nil {
			ti.Failures++
			continue
		}
		ti.Pkgs[u.path] = pkg
		ti.Checks++
		for _, pf := range u.files {
			ti.Infos[pf.RelPath] = info
		}
	}
	return ti
}

var errNotCheckedYet = &errNotChecked{}

type errNotChecked struct{}

func (*errNotChecked) Error() string { return "package not checked yet" }

// importerFunc adapts a function to types.Importer.
type importerFunc func(path string) (*types.Package, error)

func (f importerFunc) Import(path string) (*types.Package, error) { return f(path) }

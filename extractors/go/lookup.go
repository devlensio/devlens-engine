// lookup.go — LookupMaps: ONE shared index built once from parsed facts,
// consumed by every edge detector. Edge resolution is dict lookups only —
// never re-walks ASTs (playbook rule).

package main

import "strings"

type LookupMaps struct {
	// node id → node map (all emitted nodes register here)
	NodeByID map[string]map[string]any
	// file node per rel path
	FileNodesByPath map[string]map[string]any
	// PACKAGE node per import path
	PkgNodesByPath map[string]map[string]any
	// symbol maps: rel file → import alias → import path (the bridge for
	// Calls/Routes/Tests — mirrors python's symbol_maps)
	SymbolMaps map[string]map[string]string
	// pkgPath::Name → node id (exact per-package resolution; Go type names
	// are unique per package, so no closest_by_path needed)
	FuncNodeByPkgName       map[string]string
	MethodNodeByPkgTypeName map[string]string
	StructNodeByPkgName     map[string]string
	InterfaceNodeByPkgName  map[string]string
	// third-party registry output (gated) — [mod]/... nodes
	thirdPartyNodes []map[string]any
	thirdPartyByID  map[string]map[string]any
	// gated [mod] node factory (imports/calls/inheritance share ONE registry)
	tp *ThirdPartyRegistry
}

func buildLookupMaps(pr *parsedRepo, ti *TypeInfo) *LookupMaps {
	l := &LookupMaps{
		NodeByID:                map[string]map[string]any{},
		FileNodesByPath:         map[string]map[string]any{},
		PkgNodesByPath:          map[string]map[string]any{},
		SymbolMaps:              map[string]map[string]string{},
		FuncNodeByPkgName:       map[string]string{},
		MethodNodeByPkgTypeName: map[string]string{},
		StructNodeByPkgName:     map[string]string{},
		InterfaceNodeByPkgName:  map[string]string{},
		thirdPartyByID:          map[string]map[string]any{},
	}
	pkgNameByPath := map[string]string{}
	for _, pkg := range pr.packages {
		pkgNameByPath[pkg.ImportPath] = pkg.Name
	}
	for _, pkg := range pr.packages {
		for _, pf := range pkg.Files {
			// symbol map for this file
			syms := map[string]string{}
			for _, imp := range pf.Imports {
				if imp.Alias == "_" || imp.Alias == "." {
					continue
				}
				alias := imp.Alias
				if alias == "" {
					if name, ok := pkgNameByPath[imp.Path]; ok {
						alias = name
					} else {
						alias = lastPathElem(imp.Path)
					}
				}
				syms[alias] = imp.Path
			}
			l.SymbolMaps[pf.RelPath] = syms

			// code-node id maps
			for _, fn := range pf.Funcs {
				if fn.IsMethod {
					l.MethodNodeByPkgTypeName[fn.PkgPath+"::"+fn.RecvType+"."+fn.Name] = methodNodeID(pf.RelPath, fn)
				} else {
					l.FuncNodeByPkgName[fn.PkgPath+"::"+fn.Name] = funcNodeID(pf.RelPath, fn.Name)
				}
			}
			for _, st := range pf.Structs {
				if st.IsEnum {
					continue // iota enums dropped (2026-08-17) — no node, no edge
				}
				id := structNodeID(pf.RelPath, st.Name)
				l.StructNodeByPkgName[st.PkgPath+"::"+st.Name] = id
			}
			for _, it := range pf.Interfaces {
				l.InterfaceNodeByPkgName[it.PkgPath+"::"+it.Name] = interfaceNodeID(pf.RelPath, it.Name)
			}
		}
	}
	return l
}

// ── node id schemes (deterministic, file-scoped) ──

func funcNodeID(rel, name string) string        { return rel + "::" + name }
func methodNodeID(rel string, fn *ParsedFunc) string {
	return rel + "::" + fn.RecvType + "." + fn.Name
}
func structNodeID(rel, name string) string      { return rel + "::" + name }
func interfaceNodeID(rel, name string) string   { return rel + "::" + name }
func thirdPartyID(importPath string) string     { return "[mod]/" + importPath }

func lastPathElem(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

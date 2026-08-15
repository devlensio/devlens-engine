// inheritance.go — EXTENDS (struct embedding / interface embedding) +
// IMPLEMENTS (go/types.Implements — the gold standard: exact method-set
// satisfaction, pointer receivers included, no guessing).

package main

import (
	"go/types"
	"strings"
)

func detectInheritance(pr *parsedRepo, l *LookupMaps, ti *TypeInfo, opts *Options) []map[string]any {
	edges := []map[string]any{}

	// ── EXTENDS: embedding ──
	for _, pf := range pr.files {
		for _, st := range pf.Structs {
			from := structNodeID(pf.RelPath, st.Name)
			for _, emb := range st.Embedded {
				target := resolveTypeRef(emb, pf, st.PkgPath, l, opts)
				if target != "" {
					edges = append(edges, edgeWithMeta(from, target, EdgeExtends, map[string]any{"embedded": emb}))
				}
			}
		}
		for _, it := range pf.Interfaces {
			from := interfaceNodeID(pf.RelPath, it.Name)
			for _, emb := range it.Embedded {
				target := resolveTypeRef(emb, pf, it.PkgPath, l, opts)
				if target != "" {
					edges = append(edges, edgeWithMeta(from, target, EdgeExtends, map[string]any{"embedded": emb}))
				}
			}
		}
	}

	// ── IMPLEMENTS: exact via go/types ──
	if ti != nil {
		for _, pkg := range pr.packages {
			tp, ok := ti.Pkgs[pkg.ImportPath]
			if !ok {
				continue
			}
			scope := tp.Scope()
			// local interfaces of this package
			type ifaceInfo struct {
				id  string
				typ *types.Interface
			}
			var ifaces []ifaceInfo
			for _, pf := range pkg.Files {
				for _, it := range pf.Interfaces {
					obj := scope.Lookup(it.Name)
					if obj == nil {
						continue
					}
					tn, ok := obj.(*types.TypeName)
					if !ok {
						continue
					}
					if i, ok := tn.Type().Underlying().(*types.Interface); ok {
						ifaces = append(ifaces, ifaceInfo{id: interfaceNodeID(pf.RelPath, it.Name), typ: i})
					}
				}
			}
			if len(ifaces) == 0 {
				continue
			}
			// every named type in the package (structs + enums; types without
			// nodes can't get edges — documented)
			for _, name := range scope.Names() {
				obj := scope.Lookup(name)
				tn, ok := obj.(*types.TypeName)
				if !ok {
					continue
				}
				if _, isIface := tn.Type().Underlying().(*types.Interface); isIface {
					continue
				}
				id := typeNodeID(l, pkg.ImportPath, name)
				if id == "" {
					continue
				}
				for _, ifc := range ifaces {
					if types.Implements(tn.Type(), ifc.typ) || types.Implements(types.NewPointer(tn.Type()), ifc.typ) {
						edges = append(edges, edgeWithMeta(id, ifc.id, EdgeImplements, map[string]any{}))
					}
				}
			}
		}
	}
	return edges
}

// resolveTypeRef — embedded type text → node id (local struct/interface node,
// or gated [mod]/pkg::Member for external embeds like gorm.Model).
func resolveTypeRef(emb string, pf *ParsedFile, pkgPath string, l *LookupMaps, opts *Options) string {
	name := strings.TrimPrefix(emb, "*")
	// qualified: alias.Type
	if i := strings.Index(name, "."); i >= 0 {
		alias := name[:i]
		member := name[i+1:]
		if impPath, ok := l.SymbolMaps[pf.RelPath][alias]; ok {
			if _, local := l.PkgNodesByPath[impPath]; local {
				if id, ok := l.StructNodeByPkgName[impPath+"::"+member]; ok {
					return id
				}
				if id, ok := l.InterfaceNodeByPkgName[impPath+"::"+member]; ok {
					return id
				}
				return ""
			}
			// external (e.g. gorm.Model) → gated [mod] member node
			if n := l.tp.memberNode(impPath, member); n != nil {
				return n["id"].(string)
			}
			return ""
		}
		return ""
	}
	// unqualified: same package
	if id, ok := l.StructNodeByPkgName[pkgPath+"::"+name]; ok {
		return id
	}
	if id, ok := l.InterfaceNodeByPkgName[pkgPath+"::"+name]; ok {
		return id
	}
	return ""
}

// typeNodeID — node id for a named type (struct / enum), or "" if the type
// has no node (plain aliases — documented).
func typeNodeID(l *LookupMaps, pkgPath, name string) string {
	if id, ok := l.StructNodeByPkgName[pkgPath+"::"+name]; ok {
		return id
	}
	if id, ok := l.EnumNodeByPkgName[pkgPath+"::"+name]; ok {
		return id
	}
	return ""
}

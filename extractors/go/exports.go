// exports.go — the flattened public surface of a Go module, shipped in the
// ExtractorResult for cross-repo linking (docs/EXPORTS_MAP.md).
//
// Go-specific concerns:
//   - Export = capitalized identifier (token.IsExported); Go has no
//     package.json "door" — every package is importable, so the map is keyed
//     by package: subpath "." for the module-root package, "./rel/dir" for
//     the rest (mirrors the TS multi-door shape).
//   - The map key is the name an importer writes: plain funcs/structs/
//     interfaces/enums use their bare name; exported methods of exported
//     types use "Type.Method" (that is what consumer code writes).
//   - Go has no overloads → values are always single-element arrays.
//   - Test files are excluded (their symbols are not importable surface).
//   - Same-name duplicates within a package cannot compile, but if the
//     walker ever yields them, all ids are emitted rather than guessing.
//   - Requires go.mod: without a module path the consumer-side join key
//     ([mod]/importPath) is undefined, so no map is emitted.
package main

import (
	"go/token"
	"sort"
	"strings"
)

type ExportsMap struct {
	Exports        map[string]map[string][]string `json:"exports"`
	AmbiguousNames map[string][]string            `json:"ambiguousNames"`
}

func buildExportsMap(pr *parsedRepo) *ExportsMap {
	if pr.mod == nil || !pr.mod.HasMod || pr.mod.ModulePath == "" {
		return nil
	}

	exports := map[string]map[string][]string{}
	ambiguous := map[string][]string{}

	for _, pkg := range pr.packages {
		rel := strings.TrimPrefix(pkg.ImportPath, pr.mod.ModulePath)
		rel = strings.TrimPrefix(rel, "/")
		subpath := "."
		if rel != "" && rel != "." {
			subpath = "./" + rel
		}

		perPath := map[string][]string{}
		for _, pf := range pkg.Files {
			if pf.IsTest {
				continue
			}
			for _, fn := range pf.Funcs {
				if fn.IsTest {
					continue
				}
				if fn.IsMethod {
					if !token.IsExported(fn.RecvType) || !token.IsExported(fn.Name) {
						continue
					}
					addExport(perPath, fn.RecvType+"."+fn.Name, methodNodeID(pf.RelPath, fn))
				} else {
					if !token.IsExported(fn.Name) {
						continue
					}
					addExport(perPath, fn.Name, funcNodeID(pf.RelPath, fn.Name))
				}
			}
			for _, st := range pf.Structs {
				if !token.IsExported(st.Name) {
					continue
				}
				addExport(perPath, st.Name, structNodeID(pf.RelPath, st.Name))
			}
			for _, it := range pf.Interfaces {
				if !token.IsExported(it.Name) {
					continue
				}
				addExport(perPath, it.Name, interfaceNodeID(pf.RelPath, it.Name))
			}
			for _, en := range pf.numericEnums {
				if !token.IsExported(en.TypeName) {
					continue
				}
				addExport(perPath, en.TypeName, structNodeID(pf.RelPath, en.TypeName))
			}
		}

		if len(perPath) > 0 {
			exports[subpath] = perPath
		}
	}

	if len(exports) == 0 {
		return nil
	}
	return &ExportsMap{Exports: exports, AmbiguousNames: ambiguous}
}

func addExport(perPath map[string][]string, name, id string) {
	for _, existing := range perPath[name] {
		if existing == id {
			return
		}
	}
	perPath[name] = append(perPath[name], id)
	sort.Strings(perPath[name])
}

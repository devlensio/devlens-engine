// nodes.go — FILE/TEST nodes + code nodes (FUNCTION/METHOD/STRUCT/INTERFACE/
// ENUM). Test files are LEAF nodes: their test funcs feed metadata.testCases
// only — never emitted into the graph (JS parity, python bug #7).

package main

import (
	"unicode"
	"unicode/utf8"
)

// ── file / test nodes ──

func collectFileNodes(pr *parsedRepo, l *LookupMaps) []map[string]any {
	nodes := []map[string]any{}
	pkgByFile := map[string]string{}
	for _, pkg := range pr.packages {
		for _, pf := range pkg.Files {
			pkgByFile[pf.RelPath] = pkg.ImportPath
		}
	}
	for _, pf := range pr.files {
		nodeType := NodeFile
		if pf.IsTest {
			nodeType = NodeTest
		}
		n := fileNode(pf.RelPath, pf.EndLine, nodeType)
		meta := n["metadata"].(map[string]any)
		if pf.IsTest {
			meta["testCases"] = testCaseNames(pf)
		} else {
			ids := []string{}
			for _, fn := range pf.Funcs {
				ids = append(ids, nodeIDForFunc(pf.RelPath, fn))
			}
			for _, st := range pf.Structs {
				if st.IsEnum {
					continue // iota enums dropped — no node, no child
				}
				ids = append(ids, structNodeID(pf.RelPath, st.Name))
			}
			for _, it := range pf.Interfaces {
				ids = append(ids, interfaceNodeID(pf.RelPath, it.Name))
			}
			meta["nodeCount"] = len(ids)
			meta["childNodeIds"] = ids
		}
		meta["package"] = pkgByFile[pf.RelPath]
		nodes = append(nodes, n)
		l.FileNodesByPath[pf.RelPath] = n
		l.NodeByID[n["id"].(string)] = n
	}
	return nodes
}

func testCaseNames(pf *ParsedFile) []string {
	var names []string
	for _, fn := range pf.Funcs {
		if fn.IsTest {
			names = append(names, fn.Name)
		}
	}
	return names
}

// ── code nodes ──

func collectCodeNodes(pr *parsedRepo, l *LookupMaps, ti *TypeInfo) []map[string]any {
	nodes := []map[string]any{}
	for _, pf := range pr.files {
		if pf.IsTest {
			continue // leaf rule
		}
		for _, fn := range pf.Funcs {
			meta := map[string]any{
				"package":    fn.PkgPath,
				"isExported": isExported(fn.Name),
			}
			if fn.IsMethod {
				meta["parentStruct"] = fn.RecvType
			}
			id := nodeIDForFunc(pf.RelPath, fn)
			n := codeNode(id, pf.RelPath, fn.Name, nodeTypeForFunc(fn), fn.Start, fn.End, fn.RawCode, meta)
			nodes = append(nodes, n)
			l.NodeByID[id] = n
		}
		for _, st := range pf.Structs {
			if st.IsEnum {
				continue // iota enums dropped (2026-08-17) — no node, no edge
			}
			meta := map[string]any{
				"package":    st.PkgPath,
				"isExported": isExported(st.Name),
			}
			fields := make([]map[string]any, 0, len(st.Fields))
			for _, f := range st.Fields {
				fields = append(fields, map[string]any{"name": f.Name, "type": f.Type, "tag": f.Tag})
			}
			meta["fields"] = fields
			meta["embedded"] = st.Embedded
			id := structNodeID(pf.RelPath, st.Name)
			n := codeNode(id, pf.RelPath, st.Name, NodeStruct, st.Start, st.End, st.RawCode, meta)
			nodes = append(nodes, n)
			l.NodeByID[id] = n
		}
		for _, it := range pf.Interfaces {
			meta := map[string]any{
				"package":    it.PkgPath,
				"isExported": isExported(it.Name),
				"methods":    it.Methods,
				"embedded":   it.Embedded,
			}
			id := interfaceNodeID(pf.RelPath, it.Name)
			n := codeNode(id, pf.RelPath, it.Name, NodeInterface, it.Start, it.End, it.RawCode, meta)
			nodes = append(nodes, n)
			l.NodeByID[id] = n
		}
	}
	return nodes
}

func nodeTypeForFunc(fn *ParsedFunc) string {
	if fn.IsMethod {
		return NodeMethod
	}
	return NodeFunction
}

func isExported(name string) bool {
	r, _ := utf8.DecodeRuneInString(name)
	return unicode.IsUpper(r)
}

// ── fingerprint helpers (net-http / database/sql / main) ──

func importsNetHTTP(pr *parsedRepo) bool {
	for _, pf := range pr.files {
		for _, imp := range pf.Imports {
			if imp.Path == "net/http" {
				return true
			}
		}
	}
	return false
}

func importsDatabaseSQL(pr *parsedRepo) bool {
	for _, pf := range pr.files {
		for _, imp := range pf.Imports {
			if imp.Path == "database/sql" {
				return true
			}
		}
	}
	return false
}

func hasMainPackage(pr *parsedRepo) bool {
	for _, pkg := range pr.packages {
		if pkg.Name == "main" {
			return true
		}
	}
	return false
}

// pkgPathOf — package import path for a parsed file (tests.go uses it).
func pkgPathOf(pr *parsedRepo, pf *ParsedFile) string {
	for _, pkg := range pr.packages {
		for _, f := range pkg.Files {
			if f == pf {
				return pkg.ImportPath
			}
		}
	}
	return ""
}

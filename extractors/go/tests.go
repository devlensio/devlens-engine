// tests.go — TESTS edges: *_test.go (TEST leaf nodes) → the production
// symbol they test. Go naming convention: TestXxx tests Xxx; TestType_Method
// tests Type.Method. Never dangling (no edge when the target can't resolve).

package main

import "strings"

func detectTests(pr *parsedRepo, l *LookupMaps) []map[string]any {
	edges := []map[string]any{}
	for _, pf := range pr.files {
		if !pf.IsTest {
			continue
		}
		from := "file::" + pf.RelPath
		pkgPath := pkgPathOf(pr, pf)
		for _, fn := range pf.Funcs {
			if !fn.IsTest {
				continue
			}
			target := testTarget(fn.Name, pkgPath, l)
			if target != "" {
				edges = append(edges, edgeWithMeta(from, target, EdgeTests, map[string]any{"testCase": fn.Name}))
			}
		}
	}
	return edges
}

// testTarget — TestFoo → Foo; TestUser_GetName → User.GetName (method).
func testTarget(name, pkgPath string, l *LookupMaps) string {
	rest := strings.TrimPrefix(name, "Test")
	if rest == "" || rest == name {
		return ""
	}
	if i := strings.Index(rest, "_"); i > 0 {
		if id, ok := l.MethodNodeByPkgTypeName[pkgPath+"::"+rest[:i]+"."+rest[i+1:]]; ok {
			return id
		}
	}
	if id, ok := l.FuncNodeByPkgName[pkgPath+"::"+rest]; ok {
		return id
	}
	return ""
}

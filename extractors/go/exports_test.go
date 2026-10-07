package main

import (
	"reflect"
	"testing"
)

func TestBuildExportsMapPublicSurface(t *testing.T) {
	repo := parseRepo("tests/fixtures/plainfix", parseGoMod("tests/fixtures/plainfix"), func(string, string) {})
	m := buildExportsMap(repo)
	if m == nil {
		t.Fatal("expected exports map for a module with go.mod")
	}

	perPath, ok := m.Exports["."]
	if !ok {
		t.Fatalf("expected root package subpath '.', got subpaths %v", keys(m.Exports))
	}

	expectIds(perPath, t, "Shape", []string{"shapes.go::Shape"})
	expectIds(perPath, t, "Circle", []string{"shapes.go::Circle"})
	expectIds(perPath, t, "Circle.Area", []string{"shapes.go::Circle.Area"})
	expectIds(perPath, t, "Circle.Perimeter", []string{"shapes.go::Circle.Perimeter"})
	expectIds(perPath, t, "Square.Scale", []string{"shapes.go::Square.Scale"})
	expectIds(perPath, t, "Color", []string{"shapes.go::Color"})

	if len(m.AmbiguousNames) != 0 {
		t.Fatalf("expected no ambiguous names, got %v", m.AmbiguousNames)
	}
}

func TestBuildExportsMapRequiresGoMod(t *testing.T) {
	repo := parseRepo("tests/fixtures/plainfix", &modFile{}, func(string, string) {})
	if m := buildExportsMap(repo); m != nil {
		t.Fatal("expected no exports map without a module path")
	}
}

func expectIds(perPath map[string][]string, t *testing.T, name string, want []string) {
	t.Helper()
	got, ok := perPath[name]
	if !ok {
		t.Fatalf("expected exported name %q in map, got keys %v", name, keysOf(perPath))
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %v, want %v", name, got, want)
	}
}

func keys(m map[string]map[string][]string) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
}

func keysOf(m map[string][]string) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
}

// extractor.go — pipeline orchestration.
//
// Order (mirrors the python/java extractors):
//   walk → parse (facts) → typeload (Mode A/B) → lookup → imports (+PACKAGE
//   nodes) → calls → routes → orm → inheritance → tests → enrich →
//   dedupe → deterministic sort → result.
// Edge detectors resolve from facts via lookup maps — never re-walk ASTs.

package main

import (
	"sort"
)

func runExtractor(repoPath string, opts *Options) *ExtractorResult {
	if opts == nil {
		opts = &Options{}
	}
	result := &ExtractorResult{
		Fingerprint: newFingerprint(),
		Nodes:       []map[string]any{},
		Edges:       []map[string]any{},
		Routes:      []map[string]any{},
		Errors:      []ExtractorError{},
	}
	addError := func(file, msg string) {
		result.Errors = append(result.Errors, ExtractorError{File: file, Error: msg})
	}

	// ── fingerprint (go.mod only; net-http/sql upgrades come after walk) ──
	mf := parseGoMod(repoPath)
	fp := fingerprintFromMod(mf)
	result.Fingerprint = fp

	// ── walk + parse ──
	parsed := parseRepo(repoPath, mf, addError)

	// stdlib database/sql + net-http presence upgrade the fingerprint
	// (both are stdlib — invisible in go.mod requires).
	if fp.Framework == "unknown" && importsNetHTTP(parsed) {
		fp.Framework = "net-http"
		fp.ProjectType = "backend"
	}
	if importsDatabaseSQL(parsed) && !contains(fp.Databases, "sql") {
		fp.Databases = append(fp.Databases, "sql")
	}
	if hasMainPackage(parsed) {
		fp.ProjectType = "backend"
	}

	// ── type load (in-process go/types; local + std, external degraded) ──
	ti := loadTypes(parsed, addError)

	// ── lookup maps — ONE shared index, consumed by all detectors ──
	lookup := buildLookupMaps(parsed, ti)

	// ── edges, in dependency order ──
	allEdges := []map[string]any{}
	nodes := []map[string]any{}
	routes := []map[string]any{}

	// file + test nodes first (parents exist before children)
	files := collectFileNodes(parsed, lookup)
	nodes = append(nodes, files...)

	// IMPORTS edges + [mod] third-party nodes (no PACKAGE nodes — connected-only
	// pruning is engine-side; imports target the package's FILES, JS parity)
	allEdges = append(allEdges, detectImports(parsed, lookup, opts, fp)...)

	// code nodes (functions/methods/structs/interfaces/enums)
	codeNodes := collectCodeNodes(parsed, lookup, ti)
	nodes = append(nodes, codeNodes...)

	// CALLS edges
	allEdges = append(allEdges, detectCalls(parsed, ti, lookup, opts)...)

	// ROUTE nodes + HANDLES edges + BackendRouteNode entries
	routeNodes, handlesEdges, backendRoutes := detectRoutes(parsed, lookup, ti, fp)
	nodes = append(nodes, routeNodes...)
	allEdges = append(allEdges, handlesEdges...)
	routes = append(routes, backendRoutes...)

	// EXTENDS / IMPLEMENTS
	allEdges = append(allEdges, detectInheritance(parsed, lookup, ti, opts)...)

	// READS_FROM / WRITES_TO
	allEdges = append(allEdges, detectOrmEdges(parsed, lookup, ti, opts)...)

	// TESTS edges
	allEdges = append(allEdges, detectTests(parsed, lookup)...)

	// third-party nodes (gated) — created during imports/calls, collected last
	nodes = append(nodes, lookup.thirdPartyNodes...)

	// ── dedupe + deterministic sort ──
	allEdges = dedupeEdges(allEdges)
	sort.SliceStable(allEdges, func(i, j int) bool {
		a, b := allEdges[i], allEdges[j]
		return edgeKey(a) < edgeKey(b)
	})
	sort.SliceStable(nodes, func(i, j int) bool {
		return nodeKey(nodes[i]) < nodeKey(nodes[j])
	})
	sort.SliceStable(routes, func(i, j int) bool {
		return routeKey(routes[i]) < routeKey(routes[j])
	})
	// keep errors in insertion order (they're already deterministic: file walk order)

	result.Nodes = nodes
	result.Edges = allEdges
	result.Routes = routes
	result.Stats = Stats{
		TotalFiles:   len(parsed.files),
		TotalNodes:   len(nodes),
		SkippedFiles: parsed.skipped,
	}
	return result
}

// ── deterministic key helpers ──

func nodeKey(n map[string]any) string {
	s, _ := n["id"].(string)
	return s
}

func edgeKey(e map[string]any) string {
	from, _ := e["from"].(string)
	to, _ := e["to"].(string)
	t, _ := e["type"].(string)
	return from + "\x00" + t + "\x00" + to
}

func routeKey(r map[string]any) string {
	m, _ := r["method"].(string)
	p, _ := r["path"].(string)
	return m + "\x00" + p
}

func dedupeEdges(edges []map[string]any) []map[string]any {
	seen := map[string]bool{}
	out := []map[string]any{}
	for _, e := range edges {
		k := edgeKey(e)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, e)
	}
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

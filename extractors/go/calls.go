// calls.go — CALLS resolution ladder.
//
// 1. types.Info.Selections[selExpr] → *types.Func → local package → exact
//    METHOD/FUNCTION node; std → skip; external → lazy [mod]/pkg::member
//    (gated), receiver package from the selection's receiver type.
// 2. types.Info.Uses[ident] → *types.Func → same by name.
// 3. Name-based fallback (no type info / external receivers): plain name →
//    same-package func; alias.member → symbol maps → local method/func or
//    [mod] lazy member (python's proven chain rule).
//
// metadata.calls (sorted unique strings) + metadata.resolvedCalls written on
// every caller node (contract compliance + LLM context).

package main

import (
	"go/ast"
	"go/token"
	"go/types"
	"sort"
	"strings"
)

type resolvedCall struct {
	Target string `json:"target"`
	Method string `json:"method,omitempty"`
	Class  string `json:"class,omitempty"`
}

// detectCalls — CALLS edges for every non-test function/method body.
func detectCalls(pr *parsedRepo, ti *TypeInfo, l *LookupMaps, opts *Options) []map[string]any {
	edges := []map[string]any{}

	for _, pf := range pr.files {
		info := ti.Infos[pf.RelPath]
		for _, fn := range pf.Funcs {
			if fn.IsTest {
				continue // test funcs are leaf metadata, not callers
			}
			callerID := nodeIDForFunc(pf.RelPath, fn)
			callStrings := make([]string, 0, len(fn.Calls))
			var details []resolvedCall
			for _, c := range fn.Calls {
				callStrings = append(callStrings, c.Str)
				target, method, class, e := resolveCall(c, fn, pf, info, l)
				if e != nil {
					edges = append(edges, e)
				}
				if target != "" {
					details = append(details, resolvedCall{Target: target, Method: method, Class: class})
				}
			}
			// metadata enrichment on the (already created) caller node
			if n, ok := l.NodeByID[callerID]; ok {
				m := n["metadata"].(map[string]any)
				m["calls"] = sortedUnique(callStrings)
				if len(details) > 0 {
					m["resolvedCalls"] = details
				}
			}
		}
	}
	return edges
}

// nodeIDForFunc — matches the id scheme in lookup.go.
func nodeIDForFunc(rel string, fn *ParsedFunc) string {
	if fn.IsMethod {
		return methodNodeID(rel, fn)
	}
	return funcNodeID(rel, fn.Name)
}

// resolveCall → (target node id, method, class, edge) — edge nil when
// unresolvable (documented: builtins/locals/dynamic stay metadata-only).
func resolveCall(c CallSite, fn *ParsedFunc, pf *ParsedFile, info *types.Info,
	l *LookupMaps) (string, string, string, map[string]any) {

	pkgPath := fn.PkgPath
	callerID := nodeIDForFunc(pf.RelPath, fn)

	// ── 1. type-info resolution (exact) ──
	if info != nil {
		if selExpr, ok := c.Node.(*ast.SelectorExpr); ok {
			if sel, ok := info.Selections[selExpr]; ok {
				if obj, ok := sel.Obj().(*types.Func); ok && obj != nil {
					if id, class, ok := funcToNode(obj, l); ok {
						return id, c.Sel, class, callEdge(callerID, id, c.Sel, class)
					}
					if obj.Pkg() != nil {
						path := obj.Pkg().Path()
						if !isStdImport(path) {
							if n := l.tp.memberNode(path, c.Sel); n != nil {
								return n["id"].(string), c.Sel, "", callEdge(callerID, n["id"].(string), c.Sel, "")
							}
						}
					}
				}
			}
		} else if idExpr, ok := c.Node.(*ast.Ident); ok {
			if obj, ok := info.Uses[idExpr].(*types.Func); ok && obj != nil {
				if id, class, ok := funcToNode(obj, l); ok {
					return id, "", class, callEdge(callerID, id, "", class)
				}
				if obj.Pkg() != nil {
					path := obj.Pkg().Path()
					if !isStdImport(path) {
						if n := l.tp.memberNode(path, obj.Name()); n != nil {
							return n["id"].(string), obj.Name(), "", callEdge(callerID, n["id"].(string), obj.Name(), "")
						}
					}
				}
			}
		}
	}

	// ── 1.5 receiver-type-from-declaration (params / typed vars) ──
	// Handlers receive framework types by signature: func(c *gin.Context) —
	// the checker can't resolve external types, but the DECLARED type can.
	if c.IsSel {
		if impPath, typeName, local := receiverDeclaredType(c, fn, pf, l); typeName != "" {
			if local {
				if id, ok := l.MethodNodeByPkgTypeName[impPath+"::"+typeName+"."+c.Sel]; ok {
					return id, c.Sel, typeName, callEdge(callerID, id, c.Sel, typeName)
				}
			} else if n := l.tp.memberNode(impPath, typeName+"."+c.Sel); n != nil {
				return n["id"].(string), c.Sel, typeName, callEdge(callerID, n["id"].(string), c.Sel, typeName)
			}
		}
	}

	// ── 2. name-based fallback ──
	if c.IsSel {
		// alias.member: receiver is an import alias → local member or [mod]
		alias := firstSegment(c.Receiver)
		if impPath, ok := l.SymbolMaps[pf.RelPath][alias]; ok {
			if _, local := l.PkgNodesByPath[impPath]; local {
				if id, ok := l.MethodNodeByPkgTypeName[impPath+"::"+c.Sel]; ok {
					return id, c.Sel, "", callEdge(callerID, id, c.Sel, "")
				}
				if id, ok := l.FuncNodeByPkgName[impPath+"::"+c.Sel]; ok {
					return id, c.Sel, "", callEdge(callerID, id, c.Sel, "")
				}
				return "", "", "", nil
			}
			if n := l.tp.memberNode(impPath, c.Sel); n != nil {
				return n["id"].(string), c.Sel, "", callEdge(callerID, n["id"].(string), c.Sel, "")
			}
			return "", "", "", nil
		}
		// receiver names a local TYPE (User.Create) → method on that type
		if id, ok := l.MethodNodeByPkgTypeName[pkgPath+"::"+c.Receiver+"."+c.Sel]; ok {
			return id, c.Sel, c.Receiver, callEdge(callerID, id, c.Sel, c.Receiver)
		}
		// receiver is a plain variable whose type we can't see — bare-method-name
		// candidates across packages, filtered by arity/type shape
		if id, matchedBy := resolveByCandidates(l.MethodCandidatesByName[c.Sel], c, pf.RelPath); id != "" {
			return id, c.Sel, "", callEdgeMatched(callerID, id, c.Sel, "", matchedBy)
		}
		return "", "", "", nil
	}

	// plain name: same package first
	if id, ok := l.FuncNodeByPkgName[pkgPath+"::"+c.Str]; ok {
		return id, "", "", callEdge(callerID, id, "", "")
	}
	// same-package miss: bare-name candidates across packages, filtered by
	// arity/type shape (fire only where resolution previously gave up)
	if id, matchedBy := resolveByCandidates(l.FuncCandidatesByName[c.Str], c, pf.RelPath); id != "" {
		return id, "", "", callEdgeMatched(callerID, id, "", "", matchedBy)
	}
	return "", "", "", nil
}

func callEdge(from, to, method, class string) map[string]any {
	meta := map[string]any{}
	if method != "" {
		meta["method"] = method
	}
	if class != "" {
		meta["class"] = class
	}
	return edgeWithMeta(from, to, EdgeCalls, meta)
}

// callEdgeMatched — callEdge plus resolution confidence from the arity-aware
// candidate tier: "arity" (arg count singled out the target), "signature"
// (arg type agreement decided it), "name" (path proximity fallback).
func callEdgeMatched(from, to, method, class, matchedBy string) map[string]any {
	e := callEdge(from, to, method, class)
	e["metadata"].(map[string]any)["matchedBy"] = matchedBy
	return e
}

// ── arity-aware candidate resolution ──

// arityAccepts — Go call compatibility: exact arg count, except a variadic
// tail accepts any count >= required. Spread calls (f(xs...)) have an
// unknowable runtime arity — every candidate stays admissible.
func arityAccepts(cand funcCandidate, argCount int, hasSpread bool) bool {
	if hasSpread {
		return true
	}
	if cand.Variadic {
		return argCount >= cand.Required
	}
	return argCount == cand.Required
}

// typeAgrees — loose agreement between a call-site arg tag and a declared
// param type text; "unknown" tags never match (parity with the TS resolver).
func typeAgrees(argType, paramType string) bool {
	if argType == "" || argType == "unknown" || paramType == "" {
		return false
	}
	return paramType == argType || strings.Contains(paramType, argType)
}

// typeScore — how many argument tags agree with the declared params.
func typeScore(cand funcCandidate, argTypes []string) int {
	score := 0
	for i, at := range argTypes {
		if i < len(cand.ParamTypes) && typeAgrees(at, cand.ParamTypes[i]) {
			score++
		}
	}
	return score
}

// pathProximity — shared leading path segments between two rel paths
// (mirrors the TS engine's closestByPath tiebreak).
func pathProximity(candidate, reference string) int {
	a := strings.Split(candidate, "/")
	b := strings.Split(reference, "/")
	score := 0
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			break
		}
		score++
	}
	return score
}

// resolveByCandidates — pick among same-name declarations by argument shape:
// arity filter first, then arg-type agreement tiebreak, then path proximity.
// Single-candidate groups return immediately (matchedBy "arity" only when the
// call shape actually participated). Returns ("", "") when nothing applies.
func resolveByCandidates(candidates []funcCandidate, c CallSite, callerRel string) (string, string) {
	if len(candidates) == 0 {
		return "", ""
	}
	if len(candidates) == 1 {
		// a lone same-name declaration elsewhere — arity still gates it
		if arityAccepts(candidates[0], c.ArgCount, c.HasSpread) {
			return candidates[0].ID, "arity"
		}
		return "", ""
	}

	pool := make([]funcCandidate, 0, len(candidates))
	for _, cand := range candidates {
		if arityAccepts(cand, c.ArgCount, c.HasSpread) {
			pool = append(pool, cand)
		}
	}
	if len(pool) == 0 {
		return "", "" // nothing accepts this shape — stay unresolvable
	}
	if len(pool) == 1 {
		return pool[0].ID, "arity"
	}

	// type agreement tiebreak — needs usable (non-unknown) arg tags
	usable := false
	for _, at := range c.ArgTypes {
		if at != "unknown" {
			usable = true
			break
		}
	}
	if usable {
		best := pool[0]
		bestScore := typeScore(pool[0], c.ArgTypes)
		tie := 1
		for _, cand := range pool[1:] {
			s := typeScore(cand, c.ArgTypes)
			if s > bestScore {
				best, bestScore, tie = cand, s, 1
			} else if s == bestScore {
				tie++
			}
		}
		if bestScore > 0 && tie == 1 {
			return best.ID, "signature"
		}
	}

	// path proximity fallback
	best := pool[0]
	bestScore := pathProximity(best.RelPath, callerRel)
	for _, cand := range pool[1:] {
		if s := pathProximity(cand.RelPath, callerRel); s > bestScore {
			best, bestScore = cand, s
		}
	}
	return best.ID, "name"
}

// receiverDeclaredType — the receiver's type from its DECLARATION: function
// parameters first (func(c *gin.Context) — the documented handler signature),
// then package-level typed vars (var DB *gorm.DB). Returns (importPath,
// typeName, local) — local=false means external (memberNode candidate).
func receiverDeclaredType(c CallSite, fn *ParsedFunc, pf *ParsedFile, l *LookupMaps) (string, string, bool) {
	recvName := firstSegment(c.Receiver)
	if recvName == "" {
		return "", "", false
	}
	// 1. function parameters
	if fn.Decl != nil && fn.Decl.Type != nil && fn.Decl.Type.Params != nil {
		for _, field := range fn.Decl.Type.Params.List {
			for _, name := range field.Names {
				if name.Name == recvName {
					return declaredTypeInfo(field.Type, fn.PkgPath, pf, l)
				}
			}
		}
	}
	// 2. package-level typed vars in this file (var DB *gorm.DB)
	for _, decl := range pf.AST.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.VAR {
			continue
		}
		for _, spec := range gd.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok || vs.Type == nil {
				continue
			}
			for _, name := range vs.Names {
				if name.Name == recvName {
					return declaredTypeInfo(vs.Type, fn.PkgPath, pf, l)
				}
			}
		}
	}
	return "", "", false
}

// declaredTypeInfo — a declared type expr → (importPath, typeName, local).
// Ident "User" → local; SelectorExpr "gin.Context" → alias → external path.
func declaredTypeInfo(expr ast.Expr, pkgPath string, pf *ParsedFile, l *LookupMaps) (string, string, bool) {
	switch t := expr.(type) {
	case *ast.StarExpr:
		return declaredTypeInfo(t.X, pkgPath, pf, l)
	case *ast.Ident:
		return pkgPath, t.Name, true // same package — local type
	case *ast.SelectorExpr:
		alias := identName(t.X)
		if impPath, ok := l.SymbolMaps[pf.RelPath][alias]; ok {
			return impPath, t.Sel.Name, false
		}
	case *ast.IndexExpr:
		return declaredTypeInfo(t.X, pkgPath, pf, l)
	case *ast.IndexListExpr:
		return declaredTypeInfo(t.X, pkgPath, pf, l)
	}
	return "", "", false
}

// funcToNode — *types.Func declared in a local package → (node id, typeName).
func funcToNode(obj *types.Func, l *LookupMaps) (string, string, bool) {
	if obj.Pkg() == nil {
		return "", "", false
	}
	pkgPath := obj.Pkg().Path()
	if _, local := l.PkgNodesByPath[pkgPath]; !local {
		return "", "", false
	}
	if recv := obj.Type().(*types.Signature).Recv(); recv != nil {
		typeName := recvTypeNameFromTypes(recv.Type())
		if typeName == "" {
			return "", "", false
		}
		id, ok := l.MethodNodeByPkgTypeName[pkgPath+"::"+typeName+"."+obj.Name()]
		return id, typeName, ok
	}
	id, ok := l.FuncNodeByPkgName[pkgPath+"::"+obj.Name()]
	return id, "", ok
}

// recvTypeNameFromTypes — receiver type → simple name (strips * and pkg path).
func recvTypeNameFromTypes(t types.Type) string {
	switch tt := t.(type) {
	case *types.Pointer:
		return recvTypeNameFromTypes(tt.Elem())
	case *types.Named:
		return tt.Obj().Name()
	}
	return ""
}

func firstSegment(s string) string {
	if i := strings.Index(s, "."); i >= 0 {
		return s[:i]
	}
	return s
}

func sortedUnique(list []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range list {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

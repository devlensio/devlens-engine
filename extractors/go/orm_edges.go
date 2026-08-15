// orm_edges.go — GORM + database/sql → READS_FROM/WRITES_TO (consumer → store,
// mirrors stateEdges.ts and python's orm_edges). Go's type info resolves the
// model argument EXACTLY (Mode A); Mode B falls back to receiver-name
// heuristics flagged `heuristic: true`.

package main

import (
	"go/ast"
	"go/token"
	"go/types"
	"strings"
)

// GORM method grammar (documented GORM API).
var gormReadVerbs = map[string]bool{
	"Find": true, "First": true, "Take": true, "Last": true, "Count": true,
	"Pluck": true, "Scan": true, "Joins": true, "Preload": true, "Where": true,
	"Model": true, "Limit": true, "Offset": true, "Order": true, "Select": true,
	"Group": true, "Having": true, "Distinct": true, "Raw": true,
	"FindInBatches": true,
}

var gormWriteVerbs = map[string]bool{
	"Create": true, "Save": true, "Updates": true, "Update": true,
	"Delete": true, "Exec": true, "CreateInBatches": true,
}

// database/sql: Scan targets the model; Exec takes an optional model.
var sqlReadVerbs = map[string]bool{"Query": true, "QueryRow": true, "Scan": true}
var sqlWriteVerbs = map[string]bool{"Exec": true}

// common receiver names for the Mode-B heuristic (documented as heuristic).
var dbReceiverNames = map[string]bool{
	"db": true, "tx": true, "d": true, "conn": true, "pool": true,
	"database": true, "sqlDB": true, "gormDB": true, "store": true, "repo": true,
}

func detectOrmEdges(pr *parsedRepo, l *LookupMaps, ti *TypeInfo, opts *Options) []map[string]any {
	edges := []map[string]any{}
	dbVars := dbVarKinds(pr) // pkgPath → varName → "gorm" | "sql" (from var decls)

	// ── model detection (GORM): embeds gorm.Model OR has gorm:"..." tags ──
	for _, pf := range pr.files {
		for _, st := range pf.Structs {
			isModel := false
			for _, emb := range st.Embedded {
				if strings.Contains(emb, "gorm.Model") {
					isModel = true
					break
				}
			}
			if !isModel {
				for _, f := range st.Fields {
					if strings.Contains(f.Tag, "gorm:") {
						isModel = true
						break
					}
				}
			}
			if isModel {
				if n, ok := l.NodeByID[structNodeID(pf.RelPath, st.Name)]; ok {
					m := n["metadata"].(map[string]any)
					m["isModel"] = true
					m["modelType"] = "gorm"
				}
			}
		}
	}

	// ── R/W edges: consumer (func) → model STRUCT ──
	for _, pf := range pr.files {
		info := ti.Infos[pf.RelPath]
		for _, fn := range pf.Funcs {
			if fn.IsTest {
				continue
			}
			consumer := nodeIDForFunc(pf.RelPath, fn)
			for _, c := range fn.Calls {
				if !c.IsSel {
					continue
				}
				receiverType, heuristic := dbReceiverType(c, info, dbVars, fn.PkgPath)
				if receiverType == "" {
					continue
				}
				var edgeType string
				switch {
				case gormReadVerbs[c.Sel] || sqlReadVerbs[c.Sel]:
					edgeType = EdgeReadsFrom
				case gormWriteVerbs[c.Sel] || sqlWriteVerbs[c.Sel]:
					edgeType = EdgeWritesTo
				default:
					continue
				}
				modelID := modelArgID(c, info, l, fn)
				if modelID == "" {
					continue
				}
				edges = append(edges, edgeWithMeta(consumer, modelID, edgeType, map[string]any{
					"method":       c.Sel,
					"receiverVar":  firstSegment(c.Receiver),
					"heuristic":    heuristic,
					"modelType":    receiverType,
				}))
			}
		}
	}
	return edges
}

// dbReceiverType — "gorm" | "sql" | "" — resolution ladder:
// 1. types.Info (exact, local types)
// 2. the receiver's `var` DECLARATION type (e.g. `var DB *gorm.DB` — exact,
//    works for external types the checker can't resolve)
// 3. receiver-name heuristic (common db var names — flagged heuristic).
func dbReceiverType(c CallSite, info *types.Info, dbVars map[string]map[string]string, pkgPath string) (string, bool) {
	recvName := firstSegment(c.Receiver)
	if info != nil {
		if selExpr, ok := c.Node.(*ast.SelectorExpr); ok {
			if recvIdent, ok := selExpr.X.(*ast.Ident); ok {
				if tv, ok := info.Types[recvIdent]; ok && tv.Type != nil {
					switch t := deref(tv.Type).(type) {
					case *types.Named:
						if t.Obj() != nil && t.Obj().Pkg() != nil {
							switch t.Obj().Pkg().Path() {
							case "gorm.io/gorm":
								return "gorm", false
							case "database/sql":
								return "sql", false
							}
						}
					}
				}
			}
		}
	}
	// var declaration scan (exact: the declared type names the package)
	if m, ok := dbVars[pkgPath]; ok {
		if kind, ok := m[recvName]; ok {
			return kind, false
		}
	}
	// name heuristic (Mode B)
	if dbReceiverNames[strings.ToLower(recvName)] {
		return "gorm", true
	}
	return "", false
}

// dbVarKinds — package-level vars whose declared type mentions gorm/sql.
func dbVarKinds(pr *parsedRepo) map[string]map[string]string {
	out := map[string]map[string]string{}
	for _, pkg := range pr.packages {
		m := map[string]string{}
		for _, pf := range pkg.Files {
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
					t := exprText(vs.Type)
					kind := ""
					switch {
					case strings.Contains(t, "gorm"):
						kind = "gorm"
					case strings.Contains(t, "sql"):
						kind = "sql"
					}
					if kind != "" {
						for _, n := range vs.Names {
							m[n.Name] = kind
						}
					}
				}
			}
		}
		if len(m) > 0 {
			out[pkg.ImportPath] = m
		}
	}
	return out
}

func deref(t types.Type) types.Type {
	for {
		switch tt := t.(type) {
		case *types.Pointer:
			t = tt.Elem()
		case *types.Slice:
			t = tt.Elem()
		default:
			return t
		}
	}
}

// modelArgID — the model struct node from the method's model argument.
// Handles the documented GORM chain form `DB.Model(&user).Updates(map...)`
// where the model lives in the inner Model() call.
func modelArgID(c CallSite, info *types.Info, l *LookupMaps, fn *ParsedFunc) string {
	sel, ok := c.Node.(*ast.SelectorExpr)
	if !ok {
		return ""
	}
	call := selParentCall(c, fn)
	if call == nil || len(call.Args) == 0 {
		return ""
	}
	// direct: arg0 is the model
	if id := typeExprToStructID(call.Args[0], info, l); id != "" {
		return id
	}
	// chain: receiver is a CallExpr — its args may carry the model
	if chain, ok := sel.X.(*ast.CallExpr); ok && len(chain.Args) > 0 {
		if id := typeExprToStructID(chain.Args[0], info, l); id != "" {
			return id
		}
	}
	return ""
}

// selParentCall — the CallExpr containing the selector (we have the callee
// node; climb to the call itself via the fn's AST). Since CallSite only
// carries the callee expr, locate the call by walking the function body.
func selParentCall(c CallSite, fn *ParsedFunc) *ast.CallExpr {
	if fn.Decl == nil || fn.Decl.Body == nil {
		return nil
	}
	var found *ast.CallExpr
	ast.Inspect(fn.Decl.Body, func(n ast.Node) bool {
		if found != nil {
			return false
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if call.Fun == c.Node {
			found = call
			return false
		}
		return true
	})
	return found
}

// typeExprToStructID — resolve an argument expr to a local struct node id.
func typeExprToStructID(arg ast.Expr, info *types.Info, l *LookupMaps) string {
	// unwrap &x
	if un, ok := arg.(*ast.UnaryExpr); ok && un.Op.String() == "&" {
		arg = un.X
	}
	if lit, ok := arg.(*ast.CompositeLit); ok {
		arg = lit.Type
	}
	if info != nil {
		if tv, ok := info.Types[arg]; ok && tv.Type != nil {
			if named, ok := deref(tv.Type).(*types.Named); ok && named.Obj() != nil {
				if named.Obj().Pkg() != nil {
					pkgPath := named.Obj().Pkg().Path()
					if _, local := l.PkgNodesByPath[pkgPath]; local {
						if id, ok := l.StructNodeByPkgName[pkgPath+"::"+named.Obj().Name()]; ok {
							return id
						}
					}
				}
			}
		}
	}
	return ""
}

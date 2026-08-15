// routes.go — imperative route registration detection: net/http (stdlib +
// gorilla/mux), Gin, Echo, Fiber. One detector: registration calls are
// receiver-method + string-literal patterns; the receiver's TYPE (via
// types.Info) or the file's imports selects the framework.
//
// Handlers: named func → HANDLES to FUNCTION node · method value (h.GetUsers)
// → METHOD node · closure → HANDLES to the ENCLOSING function node
// (handlerKind="closure") — keeps the "0 broken HANDLES" guarantee.
//
// Group prefixes compose (r.Group("/api") → api.GET("/users") = /api/users)
// and can live across statements; the router map tracks construction-time
// prefixes per variable (python's APIRouter(prefix=) rule, imperative form).

package main

import (
	"go/ast"
	"go/types"
	"strconv"
	"strings"
)

// route registration state per function body
type routeState struct {
	routers  map[string]string // var name → framework
	prefixes map[string]string // var name → accumulated prefix
	// var name → enclosing fn node id — `apiHandler := func(c *gin.Context){}`
	// then `r.GET("/x", apiHandler)` — the documented var-closure pattern.
	funcLitVars map[string]string
	info        *types.Info
	l           *LookupMaps
	// emission collections (state-owned so appends survive — Go slice gotcha)
	routeNodes    []map[string]any
	edges         []map[string]any
	backendRoutes []map[string]any
	seen          map[string]bool // route id → true (dedupe)
}

var httpVerbSet = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "DELETE": true,
	"PATCH": true, "OPTIONS": true, "HEAD": true,
}

// detectRoutes — ROUTE nodes + HANDLES edges + BackendRouteNode entries.
func detectRoutes(pr *parsedRepo, l *LookupMaps, ti *TypeInfo, fp *Fingerprint) ([]map[string]any, []map[string]any, []map[string]any) {
	routeNodes := []map[string]any{}
	edges := []map[string]any{}
	backendRoutes := []map[string]any{}

	for _, pf := range pr.files {
		if pf.IsTest {
			continue
		}
		info := ti.Infos[pf.RelPath]
		fwByImport := fileFrameworks(pf)
		for _, fn := range pf.Funcs {
			if fn.IsTest || fn.Decl == nil || fn.Decl.Body == nil {
				continue
			}
			state := &routeState{
				routers:      map[string]string{},
				prefixes:     map[string]string{},
				funcLitVars:  map[string]string{},
				info:         info,
				l:            l,
				seen:         map[string]bool{},
			}
			ast.Inspect(fn.Decl.Body, func(n ast.Node) bool {
				// router creation / group prefix / var-closure tracking
				if assign, ok := n.(*ast.AssignStmt); ok {
					state.trackAssign(assign, fn, pf)
				}
				// route registration
				if call, ok := n.(*ast.CallExpr); ok {
					state.detectRegistration(call, pf, fn, fwByImport, l)
				}
				return true
			})
			routeNodes = append(routeNodes, state.routeNodes...)
			edges = append(edges, state.edges...)
			backendRoutes = append(backendRoutes, state.backendRoutes...)
		}
	}
	return routeNodes, edges, backendRoutes
}

// trackAssign — `r := gin.Default()` / `api := r.Group("/api")` /
// `apiHandler := func(...)` (var-closure handler).
func (s *routeState) trackAssign(a *ast.AssignStmt, fn *ParsedFunc, pf *ParsedFile) {
	if len(a.Lhs) != 1 || len(a.Rhs) != 1 {
		return
	}
	lhs, ok := a.Lhs[0].(*ast.Ident)
	if !ok || lhs.Name == "_" {
		return
	}
	// var holding a func literal → handler reference
	if _, ok := a.Rhs[0].(*ast.FuncLit); ok {
		s.funcLitVars[lhs.Name] = nodeIDForFunc(pf.RelPath, fn)
	}
	call, ok := a.Rhs[0].(*ast.CallExpr)
	if !ok {
		return
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return
	}
	recvName := identName(sel.X)
	method := sel.Sel.Name

	// root router creation
	switch method {
	case "Default", "New":
		switch {
		case strings.HasPrefix(s.frameworkOf(recvName, sel), "gin") || recvName == "gin":
			s.routers[lhs.Name] = "gin"
		case recvName == "echo":
			s.routers[lhs.Name] = "echo"
		case recvName == "fiber":
			s.routers[lhs.Name] = "fiber"
		case recvName == "http":
			s.routers[lhs.Name] = "net-http"
		case recvName == "mux":
			s.routers[lhs.Name] = "net-http"
		}
	case "NewServeMux", "NewRouter":
		s.routers[lhs.Name] = "net-http"
	case "Group":
		if parentFw, ok := s.routers[recvName]; ok {
			prefix := s.prefixes[recvName] + pathLiteral(call, 0)
			s.routers[lhs.Name] = parentFw
			s.prefixes[lhs.Name] = prefix
		}
	}
}

// detectRegistration — a route registration call (verb method / Handle /
// HandleFunc / Add). Emits one ROUTE node + HANDLES edge + backend route.
func (s *routeState) detectRegistration(call *ast.CallExpr, pf *ParsedFile, fn *ParsedFunc,
	fwByImport map[string]bool, l *LookupMaps) {

	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return
	}
	method := sel.Sel.Name
	recvName := identName(sel.X)

	// package-level net/http: http.HandleFunc / http.Handle / mux.HandleFunc
	if recvName == "http" || recvName == "mux" {
		if method != "HandleFunc" && method != "Handle" {
			return
		}
		if !fwByImport["net-http"] && !fwByImport["gin"] {
			return
		}
		s.emit(call, "net-http", "GET", 0, pf, fn, l)
		return
	}

	// receiver-method forms
	var verb string
	var pathIdx int
	switch {
	case httpVerbSet[method]:
		verb, pathIdx = method, 0
	case method == "Any":
		verb, pathIdx = "ANY", 0
	case method == "Handle" || method == "HandleFunc":
		// gin: r.Handle("POST", "/x", h); echo: e.Handle? (echo uses Add);
		// net-http mux: mux.Handle("/x", h) — but that's covered above when
		// receiver is literally http/mux; here it's a mux VARIABLE.
		if s.routers[recvName] == "net-http" {
			verb, pathIdx = "GET", 0
		} else {
			// gin/echo Handle(method, path, handler)
			verb = pathLiteral(call, 0)
			if verb == "" {
				return
			}
			verb = strings.ToUpper(verb)
			pathIdx = 1
		}
	case method == "Add" && s.routers[recvName] == "echo":
		verb = pathLiteral(call, 0)
		if verb == "" {
			return
		}
		verb = strings.ToUpper(verb)
		pathIdx = 1
	default:
		return
	}

	fw := s.frameworkOf(recvName, sel)
	if fw == "" {
		fw = fwByImportFramework(fwByImport)
	}
	if fw == "" {
		return
	}
	s.emit(call, fw, verb, pathIdx, pf, fn, l)
}

// emit — one route: ROUTE node + HANDLES edge + BackendRouteNode.
func (s *routeState) emit(call *ast.CallExpr, fw, verb string, pathIdx int,
	pf *ParsedFile, fn *ParsedFunc, l *LookupMaps) {

	if verb == "" || len(call.Args) <= pathIdx {
		return
	}
	rawPath := pathLiteral(call, pathIdx)
	if rawPath == "" {
		return
	}
	fullPath := s.prefixes[identNameOfReceiver(call)] + rawPath
	if fullPath == "" {
		fullPath = rawPath
	}
	// collapse doubled slashes from prefix+path composition (java incident #3:
	// group "/" + path "/stream" → "//stream" → "/stream")
	for strings.Contains(fullPath, "//") {
		fullPath = strings.ReplaceAll(fullPath, "//", "/")
	}

	norm, params := normalizePath(fullPath)
	isDynamic := len(params) > 0

	handlerExpr := lastArg(call, pathIdx)
	handlerID, handlerName, kind := s.resolveHandler(handlerExpr, pf, fn, l)

	id := pf.RelPath + "::" + verb + " " + norm
	if s.seen[id] {
		return
	}
	s.seen[id] = true

	meta := map[string]any{
		"urlPath":     norm,
		"httpMethod":  verb,
		"isDynamic":   isDynamic,
		"params":      params,
		"framework":   fw,
		"handlerName": handlerName,
		"routeKind":   "backend",
		"rawPath":     rawPath,
	}
	node := map[string]any{
		"id":         id,
		"name":       verb + " " + norm,
		"type":       NodeRoute,
		"filePath":   pf.RelPath,
		"startLine":  fn.Start,
		"endLine":    fn.End,
		"parentFile": "file::" + pf.RelPath,
		"metadata":   meta,
	}
	s.routeNodes = append(s.routeNodes, node)
	l.NodeByID[id] = node

	if handlerID != "" {
		s.edges = append(s.edges, edgeWithMeta(id, handlerID, EdgeHandles, map[string]any{
			"urlPath":     norm,
			"httpMethod":  verb,
			"framework":   fw,
			"handlerKind": kind,
		}))
		// mark the handler node (isHandler enrichment — nodes exist already)
		if hn, ok := l.NodeByID[handlerID]; ok {
			if hm, ok := hn["metadata"].(map[string]any); ok {
				hm["isHandler"] = true
				if hm["handlerKind"] == nil {
					hm["handlerKind"] = kind
				}
			}
		}
	}

	// BackendRouteNode for the `routes` array
	s.backendRoutes = append(s.backendRoutes, map[string]any{
		"type":        "BACKEND_ROUTE",
		"urlPath":     norm,
		"filePath":    pf.RelPath,
		"httpMethod":  verb,
		"framework":   fw,
		"isDynamic":   isDynamic,
		"params":      params,
		"handlerName": handlerName,
		"nodeId":      id,
	})
}

// resolveHandler — handler arg → (node id, name, kind).
func (s *routeState) resolveHandler(expr ast.Expr, pf *ParsedFile, fn *ParsedFunc, l *LookupMaps) (string, string, string) {
	switch h := expr.(type) {
	case *ast.Ident:
		// named function in this package
		if id, ok := l.FuncNodeByPkgName[fn.PkgPath+"::"+h.Name]; ok {
			return id, h.Name, "function"
		}
		// var holding a func literal (apiHandler := func(...))
		if id, ok := s.funcLitVars[h.Name]; ok {
			return id, h.Name, "closure"
		}
		return "", h.Name, "unresolved"
	case *ast.SelectorExpr:
		// method value (h.GetUsers) or package-qualified func (handlers.GetUsers)
		recv := identName(h.X)
		if impPath, ok := s.importAlias(pf, recv); ok {
			if id, ok := l.FuncNodeByPkgName[impPath+"::"+h.Sel.Name]; ok {
				return id, h.Sel.Name, "function"
			}
			if id, ok := l.MethodNodeByPkgTypeName[impPath+"::"+h.Sel.Name]; ok {
				return id, h.Sel.Name, "method"
			}
			return "", h.Sel.Name, "unresolved"
		}
		// receiver var → its type's method (types info)
		if id, class := s.methodForReceiver(h, fn); id != "" {
			return id, h.Sel.Name, "method"
		} else if class != "" {
			return "", h.Sel.Name, "unresolved"
		}
		return "", h.Sel.Name, "unresolved"
	case *ast.FuncLit:
		// closure → enclosing function node
		return nodeIDForFunc(pf.RelPath, fn), "<closure>", "closure"
	case *ast.IndexExpr:
		return s.resolveHandler(h.X, pf, fn, l)
	}
	return "", "<unknown>", "unknown"
}

func (s *routeState) methodForReceiver(h *ast.SelectorExpr, fn *ParsedFunc) (string, string) {
	if s.info == nil {
		return "", ""
	}
	if sel, ok := s.info.Selections[h]; ok {
		if obj, ok := sel.Obj().(*types.Func); ok && obj != nil && obj.Pkg() != nil {
			pkgPath := obj.Pkg().Path()
			if _, local := s.l.PkgNodesByPath[pkgPath]; local {
				typeName := recvTypeNameFromTypes(sel.Recv())
				if typeName == "" {
					return "", ""
				}
				if id, ok := s.l.MethodNodeByPkgTypeName[pkgPath+"::"+typeName+"."+obj.Name()]; ok {
					return id, typeName
				}
			}
		}
	}
	return "", ""
}

func (s *routeState) importAlias(pf *ParsedFile, alias string) (string, bool) {
	for _, imp := range pf.Imports {
		a := imp.Alias
		if a == "" {
			a = lastPathElem(imp.Path)
		}
		if a == alias {
			return imp.Path, true
		}
	}
	return "", false
}

func (s *routeState) frameworkOf(recvName string, sel *ast.SelectorExpr) string {
	// type info first: receiver's package path → framework
	if s.info != nil {
		if ident, ok := sel.X.(*ast.Ident); ok {
			if tv, ok := s.info.Types[ident]; ok && tv.Type != nil {
				if named, ok := tv.Type.(*types.Named); ok && named.Obj() != nil && named.Obj().Pkg() != nil {
					switch named.Obj().Pkg().Path() {
					case "net/http":
						return "net-http"
					case "github.com/gorilla/mux":
						return "net-http"
					case "github.com/gin-gonic/gin":
						return "gin"
					case "github.com/labstack/echo", "github.com/labstack/echo/v4":
						return "echo"
					case "github.com/gofiber/fiber/v2", "github.com/gofiber/fiber":
						return "fiber"
					}
				}
				if ptr, ok := tv.Type.(*types.Pointer); ok {
					if named, ok := ptr.Elem().(*types.Named); ok && named.Obj() != nil && named.Obj().Pkg() != nil {
						switch named.Obj().Pkg().Path() {
						case "net/http":
							return "net-http"
						case "github.com/gorilla/mux":
							return "net-http"
						case "github.com/gin-gonic/gin":
							return "gin"
						case "github.com/labstack/echo", "github.com/labstack/echo/v4":
							return "echo"
						case "github.com/gofiber/fiber/v2", "github.com/gofiber/fiber":
							return "fiber"
						}
					}
				}
			}
		}
	}
	return s.routers[recvName]
}

func fwByImportFramework(fwByImport map[string]bool) string {
	for _, fw := range []string{"gin", "echo", "fiber", "net-http"} {
		if fwByImport[fw] {
			return fw
		}
	}
	return ""
}

func fileFrameworks(pf *ParsedFile) map[string]bool {
	fws := map[string]bool{}
	for _, imp := range pf.Imports {
		switch {
		case imp.Path == "net/http" || imp.Path == "github.com/gorilla/mux":
			fws["net-http"] = true
		case imp.Path == "github.com/gin-gonic/gin":
			fws["gin"] = true
		case imp.Path == "github.com/labstack/echo" || imp.Path == "github.com/labstack/echo/v4":
			fws["echo"] = true
		case imp.Path == "github.com/gofiber/fiber/v2" || imp.Path == "github.com/gofiber/fiber":
			fws["fiber"] = true
		}
	}
	return fws
}

// ── path helpers ──

// pathLiteral — the string literal at args[idx] (or "" if not a literal).
func pathLiteral(call *ast.CallExpr, idx int) string {
	if idx >= len(call.Args) {
		return ""
	}
	lit, ok := call.Args[idx].(*ast.BasicLit)
	if !ok || lit.Kind.String() != "STRING" {
		return ""
	}
	s, err := strconv.Unquote(lit.Value)
	if err != nil {
		return ""
	}
	return s
}

func lastArg(call *ast.CallExpr, pathIdx int) ast.Expr {
	if len(call.Args) == 0 {
		return nil
	}
	// handler is the arg after the path (verb forms) or the LAST arg
	// (gin/echo Handle with middleware chains)
	if len(call.Args) > pathIdx+1 {
		return call.Args[len(call.Args)-1]
	}
	return nil
}

func identName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return identName(t.X)
	case *ast.StarExpr:
		return identName(t.X)
	case *ast.CallExpr:
		return identName(t.Fun)
	case *ast.ParenExpr:
		return identName(t.X)
	}
	return ""
}

func identNameOfReceiver(call *ast.CallExpr) string {
	if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
		return identName(sel.X)
	}
	return ""
}

// normalizePath — :param / *wildcard → {param} (consistent with python/java
// route ids); returns (normalized, params).
func normalizePath(p string) (string, []string) {
	var params []string
	var b strings.Builder
	i := 0
	for i < len(p) {
		c := p[i]
		if c == ':' || c == '*' {
			j := i + 1
			for j < len(p) && (isAlphaNum(p[j]) || p[j] == '_') {
				j++
			}
			name := p[i+1 : j]
			if name == "" {
				b.WriteByte(c)
				i++
				continue
			}
			params = append(params, name)
			b.WriteString("{" + name + "}")
			i = j
			continue
		}
		b.WriteByte(c)
		i++
	}
	return b.String(), params
}

func isAlphaNum(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

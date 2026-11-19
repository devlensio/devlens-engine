// parser.go — parse-time FACT collection (the only AST pass).
//
// Per .go file: package name, imports, functions/methods (Recv nil|non-nil),
// structs (fields, tags, embedded types), interfaces (method names), iota
// const blocks (enum pattern), and body CALLS. Everything downstream (edges)
// resolves from these facts via lookup maps — never re-walks ASTs.

package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ── fact types ──

type CallSite struct {
	Str       string // call string: "f" or "a.b.c" (contract metadata.calls)
	Sel       string // method name for selector form ("Find" in db.Find)
	Receiver  string // receiver expr text for selector form ("db")
	IsSel     bool
	Node      ast.Expr // the callee node (Ident or SelectorExpr) — types lookup
	Pos       token.Pos
	ArgCount  int      // number of arguments at the call site
	ArgTypes  []string // per-arg type tags (Go type vocabulary, "unknown" when not cheaply inferable)
	HasSpread bool     // f(xs...) — variadic spread, runtime arity unknowable

	// ── callOrder/v1 (docs/CALL_ORDER.md §3.1) — metadata only, never identity ──
	Order       int    // 1-based lexical rank among the owner's recorded sites
	Line        int    // 1-based line of the call expression
	Col         int    // 0-based column, so two calls on one line stay distinct
	Nested      int    // order of the enclosing call expression: outer(mid()) → 1
	Scope       string // scopeInline | scopeCallback | scopeNested | scopeModule
	Defer       string // deferTimer | deferEvent | deferOnReturn ("" = no evidence)
	DeferDetail string // the scheduler symbol that produced Defer
	Conc        bool   // go statement: may run alongside the frame
	Repeat      bool   // loop body: may run 0..N times
	Maybe       bool   // branch arm / block behind a terminating guard: may run 0 times
	EarlyExit   bool   // Go has no `?` operator — always false; shared contract shape
}

// CallSite.Scope values — the execution region a site belongs to.
const (
	scopeInline   = "inline"
	scopeCallback = "callback"
	scopeNested   = "nested"
	scopeModule   = "module"
)

// CallSite.Defer values Go can evidence. The remaining contract kinds
// (promise/microtask/postRender/unknown) simply stay absent for Go.
const (
	deferTimer    = "timer"
	deferEvent    = "event"
	deferOnReturn = "onReturn"
)

type ParsedFunc struct {
	Name     string
	IsMethod bool
	RecvType string // receiver type name (no *), e.g. "User"
	PkgPath  string
	Start    int
	End      int
	RawCode  string
	File     string
	Calls    []CallSite
	IsTest   bool
	Decl     *ast.FuncDecl // the decl node — routes.go needs it for body walks
}

type FieldInfo struct {
	Name string
	Type string
	Tag  string
}

type ParsedStruct struct {
	Name      string
	PkgPath   string
	Fields    []FieldInfo
	Embedded  []string
	Start     int
	End       int
	RawCode   string
	File      string
	IsEnum    bool
	Constants []string
}

type ParsedInterface struct {
	Name     string
	PkgPath  string
	Methods  []string
	Embedded []string // embedded interfaces (no method names in AST field)
	Start    int
	End      int
	RawCode  string
	File     string
}

type ImportSpec struct {
	Path  string // import path, unquoted
	Alias string // explicit alias or "" (use package name)
}

type ParsedFile struct {
	RelPath string
	PkgName string
	PkgPath string // import path of the containing package (module + dir)
	IsTest  bool
	Imports    []ImportSpec
	Funcs      []*ParsedFunc
	Structs    []*ParsedStruct
	Interfaces []*ParsedInterface
	// FileCalls — calls in package-level VAR initializers (run at init time,
	// owned by the FILE node). Function bodies stay on ParsedFunc.Calls.
	FileCalls []CallSite
	EndLine   int
	AST       *ast.File // kept for go/types check (typeload.go)
	// iota const blocks on named numeric types (enum pattern, stretch)
	numericEnums []numericEnum
}

type ParsedPackage struct {
	ImportPath string // module path + rel dir
	Dir        string // rel dir from repo root ("" or "." for root)
	Name       string // package name
	Files      []*ParsedFile
	fset       *token.FileSet // shared per package (positions must share one fset)
}

type parsedRepo struct {
	files      []*ParsedFile // ALL .go files (tests included), walk order
	packages   []*ParsedPackage
	fileByPath map[string]*ParsedFile
	mod        *modFile
	repoPath   string
	skipped    int
}

type errFn func(file, msg string)

// parseRepo — walk → group into packages → parse each file into facts.
func parseRepo(repoPath string, mf *modFile, addError errFn) *parsedRepo {
	pr := &parsedRepo{fileByPath: map[string]*ParsedFile{}, mod: mf, repoPath: repoPath}
	all := goFiles(repoPath)
	groups := groupByDir(all)
	for _, dir := range sortedKeys(groups) {
		group := groups[dir]
		pkg := &ParsedPackage{
			Dir:        dir,
			ImportPath: importPathForDir(mf, dir),
			fset:       token.NewFileSet(),
		}
		for _, rel := range group {
			pf := parseFile(repoPath, rel, pkg, addError)
			if pf == nil {
				pr.skipped++
				continue
			}
			if pkg.Name == "" {
				pkg.Name = pf.PkgName
			}
			pkg.Files = append(pkg.Files, pf)
			pr.files = append(pr.files, pf)
			pr.fileByPath[rel] = pf
		}
		if len(pkg.Files) > 0 {
			pr.packages = append(pr.packages, pkg)
		}
	}
	return pr
}

// importPathForDir — module path + rel dir (root → module path itself). For
// repos without go.mod, the rel dir stands in as the pseudo import path.
func importPathForDir(mf *modFile, dir string) string {
	base := mf.ModulePath
	if base == "" {
		return dir
	}
	if dir == "." || dir == "" {
		return base
	}
	return base + "/" + strings.TrimPrefix(dir, "./")
}

// parseFile — one file → facts. nil on parse error (caller counts skipped).
func parseFile(repoPath, rel string, pkg *ParsedPackage, addError errFn) *ParsedFile {
	abs := filepath.Join(repoPath, rel)
	src, err := os.ReadFile(abs)
	if err != nil {
		addError(rel, "read: "+err.Error())
		return nil
	}
	fset := pkg.fset
	f, err := parser.ParseFile(fset, rel, src, parser.ParseComments)
	if err != nil {
		addError(rel, "parse: "+err.Error())
		return nil
	}
	pf := &ParsedFile{
		RelPath: rel,
		PkgName: f.Name.Name,
		PkgPath: pkg.ImportPath,
		IsTest:  strings.HasSuffix(rel, "_test.go"),
		AST:     f,
	}
	if pf.EndLine = fset.Position(f.End()).Line; pf.EndLine == 0 {
		pf.EndLine = 1
	}
	// imports
	for _, imp := range f.Imports {
		p, _ := strconvUnquote(imp.Path)
		alias := ""
		if imp.Name != nil {
			alias = imp.Name.Name
		}
		pf.Imports = append(pf.Imports, ImportSpec{Path: p, Alias: alias})
	}
	// named numeric types (the iota-enum substrate)
	numericTypes := map[string]bool{}
	// const specs: type → constants
	constBlocks := map[string][]string{}

	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			fn := parseFuncDecl(fset, src, rel, pkg, d, pf.IsTest)
			if fn != nil {
				pf.Funcs = append(pf.Funcs, fn)
			}
		case *ast.GenDecl:
			switch d.Tok {
			case token.TYPE:
				for _, spec := range d.Specs {
					ts, ok := spec.(*ast.TypeSpec)
					if !ok {
						continue
					}
					start := fset.Position(d.Pos()).Line
					end := fset.Position(d.End()).Line
					raw := string(src[fset.Position(d.Pos()).Offset:fset.Position(d.End()).Offset])
					switch t := ts.Type.(type) {
					case *ast.StructType:
						st := &ParsedStruct{
							Name: ts.Name.Name, PkgPath: pkg.ImportPath,
							Start: start, End: end, RawCode: raw, File: rel,
						}
						for _, field := range t.Fields.List {
							ftype := exprText(field.Type)
							tag := ""
							if field.Tag != nil {
								tag, _ = strconvUnquote(field.Tag)
							}
							if len(field.Names) == 0 {
								// embedded field
								st.Embedded = append(st.Embedded, ftype)
								st.Fields = append(st.Fields, FieldInfo{Name: "", Type: ftype, Tag: tag})
							} else {
								for _, n := range field.Names {
									st.Fields = append(st.Fields, FieldInfo{Name: n.Name, Type: ftype, Tag: tag})
								}
							}
						}
						pf.Structs = append(pf.Structs, st)
					case *ast.InterfaceType:
						it := &ParsedInterface{
							Name: ts.Name.Name, PkgPath: pkg.ImportPath,
							Start: start, End: end, RawCode: raw, File: rel,
						}
						for _, m := range t.Methods.List {
							if len(m.Names) > 0 {
								it.Methods = append(it.Methods, m.Names[0].Name)
							} else {
								// embedded interface
								it.Embedded = append(it.Embedded, exprText(m.Type))
							}
						}
						pf.Interfaces = append(pf.Interfaces, it)
					case *ast.Ident, *ast.StarExpr, *ast.ArrayType, *ast.SelectorExpr:
						// plain named type (type X int / type X = Other) —
						// the enum substrate if numeric
						if isNumericType(t) {
							numericTypes[ts.Name.Name] = true
						}
					}
				}
			case token.VAR:
				// Package-level initializers execute at init time — attribute
				// their calls to the FILE node (function bodies stay on the
				// ParsedFunc). const blocks are compile-time, no calls.
				for _, spec := range d.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for _, val := range vs.Values {
						// ordinals continue the FILE node's sequence across every
						// package-level var in the file
						pf.FileCalls = append(pf.FileCalls, collectModuleCalls(fset, val, len(pf.FileCalls))...)
					}
				}
			case token.CONST:
				// Go const blocks inherit type + value from the previous spec
				// (`Red Color = iota; Green; Blue`). Two passes: resolve names
				// with their inherited type, then check if the block uses iota.
				type constEntry struct{ name, typeName string }
				var entries []constEntry
				lastType := ""
				blockIota := false
				for _, spec := range d.Specs {
					cs, ok := spec.(*ast.ValueSpec)
					if !ok || len(cs.Names) == 0 {
						continue
					}
					if cs.Type != nil {
						lastType = exprText(cs.Type)
					}
					hasIota := false
					ast.Inspect(cs, func(n ast.Node) bool {
						if id, ok := n.(*ast.Ident); ok && id.Name == "iota" {
							hasIota = true
						}
						return true
					})
					if hasIota {
						blockIota = true
					}
					if lastType != "" {
						for _, n := range cs.Names {
							entries = append(entries, constEntry{n.Name, lastType})
						}
					}
				}
				if blockIota {
					for _, e := range entries {
						constBlocks[e.typeName] = append(constBlocks[e.typeName], e.name)
					}
				}
			}
		}
	}
	// enum pattern: named numeric type + iota const block → ENUM (stretch)
	for typeName, consts := range constBlocks {
		if numericTypes[typeName] {
			for _, st := range pf.Structs {
				if st.Name == typeName {
					st.IsEnum = true
					st.Constants = consts
				}
			}
			// numeric types aren't Structs — record them on the file for
			// node emission via a synthetic entry
			pf.numericEnums = append(pf.numericEnums, numericEnum{TypeName: typeName, Constants: consts})
		}
	}
	return pf
}

type numericEnum struct {
	TypeName  string
	Constants []string
}

// parseFuncDecl — FuncDecl → facts. Test funcs (TestXxx in *_test.go) keep
// their name; node emission treats test files as leaves (nodes=[]).
func parseFuncDecl(fset *token.FileSet, src []byte, rel string, pkg *ParsedPackage, d *ast.FuncDecl, isTestFile bool) *ParsedFunc {
	fn := &ParsedFunc{
		Name:     d.Name.Name,
		PkgPath:  pkg.ImportPath,
		Start:    fset.Position(d.Pos()).Line,
		End:      fset.Position(d.End()).Line,
		RawCode:  string(src[fset.Position(d.Pos()).Offset:fset.Position(d.End()).Offset]),
		File:     rel,
		IsMethod: d.Recv != nil && len(d.Recv.List) > 0,
		Decl:     d,
	}
	if fn.IsMethod {
		fn.RecvType = receiverTypeName(d.Recv.List[0].Type)
	}
	if isTestFile && strings.HasPrefix(d.Name.Name, "Test") {
		fn.IsTest = true
	}
	if d.Body != nil {
		fn.Calls = collectCalls(fset, d.Body)
	}
	return fn
}

// receiverTypeName — "(u User)" / "(u *User)" / "(u *User[T])" → "User".
func receiverTypeName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return receiverTypeName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr:
		return receiverTypeName(t.X)
	case *ast.IndexListExpr:
		return receiverTypeName(t.X)
	case *ast.ParenExpr:
		return receiverTypeName(t.X)
	}
	return exprText(e)
}

// ── call collection (the only call-site walk) ──

// collectCalls — every call site of one function body, ONE RECORD PER
// OCCURRENCE (docs/CALL_ORDER.md §2). The recorded SET is unchanged from the
// pre-callOrder extractor: the walk descends into FuncLit bodies because Go has
// no nested func decls — a closure's calls belong to the enclosing function.
func collectCalls(fset *token.FileSet, body ast.Node) []CallSite {
	w := &callWalk{
		fset:    fset,
		inherit: callCtx{scope: scopeInline},
		guarded: markEarlyExitGuards(body),
		chanCb:  channelCallbackVars(body),
	}
	w.walk(body)
	return w.calls
}

// collectModuleCalls — calls in a package-level VAR initializer (FILE node).
// Closures are NOT module scope: `var h = func() { svc.Get() }` runs svc.Get
// when h is invoked, so the walk does not descend into FuncLit. `base` is the
// number of ordinals the FILE node already used.
func collectModuleCalls(fset *token.FileSet, root ast.Node, base int) []CallSite {
	w := &callWalk{
		fset:    fset,
		base:    base,
		inherit: callCtx{scope: scopeModule},
		skipLit: true,
	}
	w.walk(root)
	return w.calls
}

// callWalk — one ast.Inspect pass whose pre-order = source order, so the
// ordinal a site receives is its lexical rank among the owner's recorded
// sites. Every entered node pushes a frame (the exit callback pops it), which
// is how the flags of the ancestors reach the site.
type callWalk struct {
	fset    *token.FileSet
	base    int               // ordinals already used by the owner
	inherit callCtx           // context at the root
	guarded map[ast.Node]bool // statements behind a terminating guard
	chanCb  map[string]string // func values received from a channel
	skipLit bool              // do not descend into FuncLit (module scope)
	stack   []callFrame
	calls   []CallSite
}

// callCtx — the flags an owner region imposes on every site inside it.
type callCtx struct {
	scope       string
	conc        bool
	repeat      bool
	maybe       bool
	deferKind   string
	deferDetail string
}

type callFrame struct {
	node    ast.Node
	funcLit bool // function-literal boundary: `nested` never crosses it
	order   int  // ordinal of this frame when it is a recorded call site
	ctx     callCtx
}

func (w *callWalk) walk(root ast.Node) {
	ast.Inspect(root, func(n ast.Node) bool {
		if n == nil {
			w.stack = w.stack[:len(w.stack)-1]
			return false
		}
		if _, isLit := n.(*ast.FuncLit); isLit && w.skipLit {
			return false // no frame pushed — ast.Inspect sends no exit callback
		}
		parent := w.parent()
		ctx := w.narrow(w.ctx(), n, parent)
		order := 0
		if call, ok := n.(*ast.CallExpr); ok {
			if site := callSiteFrom(call); site != nil {
				w.annotate(site, ctx)
				w.calls = append(w.calls, *site)
				order = site.Order
			}
		}
		_, isLit := n.(*ast.FuncLit)
		w.stack = append(w.stack, callFrame{node: n, funcLit: isLit, order: order, ctx: ctx})
		return true
	})
}

func (w *callWalk) parent() ast.Node {
	if len(w.stack) == 0 {
		return nil
	}
	return w.stack[len(w.stack)-1].node
}

func (w *callWalk) ctx() callCtx {
	if len(w.stack) == 0 {
		return w.inherit
	}
	return w.stack[len(w.stack)-1].ctx
}

// narrow — widen the inherited context for the subtree rooted at n. Only
// metadata changes here; the recorded set is decided by walk alone.
func (w *callWalk) narrow(ctx callCtx, n, parent ast.Node) callCtx {
	switch n.(type) {
	case *ast.FuncLit:
		// a closure body: callback when registered, nested when declared
		ctx.scope = funcLitScope(parent)
		if kind, detail, ok := registrationScheduler(parent); ok {
			ctx.deferKind, ctx.deferDetail = kind, detail
		}
	case *ast.GoStmt:
		ctx.conc = true // go f() starts now — concurrent, NOT deferred
	case *ast.DeferStmt:
		ctx.deferKind, ctx.deferDetail = deferOnReturn, "defer"
	case *ast.CaseClause, *ast.CommClause:
		ctx.maybe = true // switch / type-switch / select arm
	}
	switch p := parent.(type) {
	case *ast.IfStmt:
		if p.Body == n || p.Else == n {
			ctx.maybe = true // then arm, else arm, or an else-if chain
		}
	case *ast.RangeStmt:
		if p.Body == n {
			ctx.repeat = true // range body
		}
	case *ast.ForStmt:
		if p.Body == n {
			ctx.repeat = true // for body
		}
	}
	if w.guarded[n] {
		ctx.maybe = true // the rest of a block behind a terminating guard
	}
	return ctx
}

// annotate — write the callOrder/v1 fields of one recorded site.
func (w *callWalk) annotate(site *CallSite, ctx callCtx) {
	pos := w.fset.Position(site.Pos)
	site.Order = w.base + len(w.calls) + 1
	site.Line = pos.Line
	if pos.Column > 0 {
		site.Col = pos.Column - 1
	}
	site.Scope = ctx.scope
	if site.Scope == "" {
		site.Scope = scopeInline
	}
	site.Conc = ctx.conc
	site.Repeat = ctx.repeat
	site.Maybe = ctx.maybe
	site.Defer = ctx.deferKind
	site.DeferDetail = ctx.deferDetail

	// the nearest enclosing call expression, without crossing a closure: the
	// calls of a callback passed to foo() are not evaluated as part of foo()
	for i := len(w.stack) - 1; i >= 0; i-- {
		f := w.stack[i]
		if f.funcLit {
			break
		}
		if f.order > 0 {
			site.Nested = f.order
			break
		}
	}

	// a func value that arrived over a channel is registered externally
	if site.Defer == "" && !site.IsSel {
		if ch, ok := w.chanCb[site.Str]; ok {
			site.Defer, site.DeferDetail = deferEvent, "<-"+ch
		}
	}
}

// funcLitScope — a closure body's scope: passed to a call (or dispatched by go
// / defer) is a callback; a variable initializer or any other position is a
// function declared inside the owner, i.e. "nested".
func funcLitScope(parent ast.Node) string {
	switch parent.(type) {
	case *ast.CallExpr, *ast.GoStmt, *ast.DeferStmt:
		return scopeCallback
	}
	return scopeNested
}

// registrationScheduler — the call that receives this closure, when it is a
// scheduler the contract knows about (docs/CALL_ORDER.md §4.2).
func registrationScheduler(parent ast.Node) (string, string, bool) {
	call, ok := parent.(*ast.CallExpr)
	if !ok {
		return "", "", false
	}
	text := exprText(call.Fun)
	if text == "time.AfterFunc" || strings.HasSuffix(text, ".AfterFunc") {
		return deferTimer, text, true
	}
	return "", "", false
}

// markEarlyExitGuards — the Go diamond `if err != nil { return }`: the rest of
// the block only runs when the guard did not fire, so its calls are `maybe`.
func markEarlyExitGuards(root ast.Node) map[ast.Node]bool {
	guarded := map[ast.Node]bool{}
	ast.Inspect(root, func(n ast.Node) bool {
		block, ok := n.(*ast.BlockStmt)
		if !ok {
			return true
		}
		for i, stmt := range block.List {
			if !terminatingGuard(stmt) {
				continue
			}
			for _, rest := range block.List[i+1:] {
				guarded[rest] = true
			}
			break
		}
		return true
	})
	return guarded
}

func terminatingGuard(stmt ast.Stmt) bool {
	guard, ok := stmt.(*ast.IfStmt)
	if !ok || guard.Else != nil {
		return false
	}
	return terminates(guard.Body)
}

// terminates — the block always leaves the enclosing block (return, break,
// continue, goto, or a panic-style call).
func terminates(block *ast.BlockStmt) bool {
	if block == nil || len(block.List) == 0 {
		return false
	}
	switch last := block.List[len(block.List)-1].(type) {
	case *ast.ReturnStmt, *ast.BranchStmt:
		return true
	case *ast.ExprStmt:
		call, ok := last.X.(*ast.CallExpr)
		if !ok {
			return false
		}
		name := exprText(call.Fun)
		if i := strings.LastIndex(name, "."); i >= 0 {
			name = name[i+1:]
		}
		switch name {
		case "panic", "Fatal", "Fatalf", "Fatalln", "Exit", "Goexit":
			return true
		}
	}
	return false
}

// channelCallbackVars — `cb := <-cbCh`: a func value that arrives over a
// channel is triggered from outside the frame, so calling it is `defer:event`
// (the contract's "channel consumer", docs/CALL_ORDER.md §4.2).
func channelCallbackVars(root ast.Node) map[string]string {
	vars := map[string]string{}
	ast.Inspect(root, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			if len(s.Lhs) == 1 && len(s.Rhs) == 1 {
				addChannelVar(vars, s.Lhs[0], s.Rhs[0])
			}
		case *ast.ValueSpec:
			for i, name := range s.Names {
				if i < len(s.Values) {
					addChannelVar(vars, name, s.Values[i])
				}
			}
		}
		return true
	})
	return vars
}

func addChannelVar(vars map[string]string, target, value ast.Expr) {
	id, ok := target.(*ast.Ident)
	if !ok {
		return
	}
	recv, ok := value.(*ast.UnaryExpr)
	if !ok || recv.Op != token.ARROW {
		return
	}
	vars[id.Name] = exprText(recv.X)
}

// callSiteFrom — one CallExpr → CallSite (nil for inline func-literal
// invocation, which has no symbol to resolve). Each call records its argument
// shape (count, cheap type tags, spread) for arity-aware CALLS resolution.
func callSiteFrom(call *ast.CallExpr) *CallSite {
	argCount := len(call.Args)
	hasSpread := call.Ellipsis != token.NoPos
	argTypes := make([]string, 0, argCount)
	for _, arg := range call.Args {
		argTypes = append(argTypes, argTypeTag(arg))
	}
	fun := call.Fun
	// unwrap generic calls: f[T](...)
	if idx, ok := fun.(*ast.IndexExpr); ok {
		fun = idx.X
	} else if idx, ok := fun.(*ast.IndexListExpr); ok {
		fun = idx.X
	}
	switch f := fun.(type) {
	case *ast.Ident:
		return &CallSite{Str: f.Name, Node: f, Pos: call.Pos(), ArgCount: argCount, ArgTypes: argTypes, HasSpread: hasSpread}
	case *ast.SelectorExpr:
		return &CallSite{
			Str:      exprText(f),
			Sel:      f.Sel.Name,
			Receiver: identName(f.X), // root ident survives call chains: DB.Model(...).Updates → "DB"
			IsSel:    true,
			Node:     f,
			Pos:      call.Pos(),
			ArgCount: argCount, ArgTypes: argTypes, HasSpread: hasSpread,
		}
	}
	// inline anonymous invocation — no symbol to resolve
	return nil
}

// argTypeTag — cheap per-argument type tag in Go's own vocabulary: literals
// and composite literals carry their type, everything else (idents, calls,
// expressions) degrades to "unknown". No go/types dependency at parse time.
func argTypeTag(arg ast.Expr) string {
	switch t := arg.(type) {
	case *ast.BasicLit:
		switch t.Kind {
		case token.STRING:
			return "string"
		case token.INT:
			return "int"
		case token.FLOAT:
			return "float64"
		case token.CHAR:
			return "rune"
		}
	case *ast.Ident:
		if t.Name == "true" || t.Name == "false" {
			return "bool"
		}
	case *ast.CompositeLit:
		if t.Type != nil {
			return exprText(t.Type)
		}
		return "unknown"
	case *ast.FuncLit:
		return "func"
	}
	return "unknown"
}

// exprText — renders common AST expressions to source text.
func exprText(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return exprText(t.X) + "." + t.Sel.Name
	case *ast.StarExpr:
		return "*" + exprText(t.X)
	case *ast.IndexExpr:
		return exprText(t.X)
	case *ast.IndexListExpr:
		return exprText(t.X)
	case *ast.ParenExpr:
		return exprText(t.X)
	case *ast.BasicLit:
		return t.Value
	case *ast.CallExpr:
		return exprText(t.Fun) // chains render as the callee path: DB.Model(...).Updates → "DB.Model.Updates"
	case *ast.ArrayType:
		if t.Len == nil {
			return "[]" + exprText(t.Elt)
		}
		return "[" + exprText(t.Len) + "]" + exprText(t.Elt)
	case *ast.MapType:
		return "map[" + exprText(t.Key) + "]" + exprText(t.Value)
	case *ast.FuncType:
		return "func"
	case *ast.ChanType:
		return "chan"
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.StructType:
		return "struct{}"
	}
	return "?"
}

func isNumericType(e ast.Expr) bool {
	switch t := e.(type) {
	case *ast.Ident:
		switch t.Name {
		case "int", "int8", "int16", "int32", "int64", "uint", "uint8",
			"uint16", "uint32", "uint64", "uintptr", "float32", "float64",
			"complex64", "complex128", "byte", "rune":
			return true
		}
	case *ast.SelectorExpr:
		return isNumericType(t.X) // e.g. time.Duration — treat as numeric-ish
	}
	return false
}

func strconvUnquote(lit *ast.BasicLit) (string, bool) {
	if lit == nil {
		return "", false
	}
	s := lit.Value
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1], true
	}
	return s, false
}

func sortedKeys(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

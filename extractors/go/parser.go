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
	Str      string    // call string: "f" or "a.b.c" (contract metadata.calls)
	Sel      string    // method name for selector form ("Find" in db.Find)
	Receiver string    // receiver expr text for selector form ("db")
	IsSel    bool
	Node     ast.Expr  // the callee node (Ident or SelectorExpr) — types lookup
	Pos      token.Pos
}

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
	RelPath    string
	PkgName    string
	IsTest     bool
	Imports    []ImportSpec
	Funcs      []*ParsedFunc
	Structs    []*ParsedStruct
	Interfaces []*ParsedInterface
	EndLine    int
	AST        *ast.File // kept for go/types check (typeload.go)
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
		fn.Calls = collectCalls(d.Body)
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

// collectCalls — all CallExprs in a body (scope rule: closures inside the
// body attribute to the enclosing function — Go has no nested func decls).
func collectCalls(body ast.Node) []CallSite {
	var calls []CallSite
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
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
			calls = append(calls, CallSite{Str: f.Name, Node: f, Pos: call.Pos()})
		case *ast.SelectorExpr:
			calls = append(calls, CallSite{
				Str:      exprText(f),
				Sel:      f.Sel.Name,
				Receiver: identName(f.X), // root ident survives call chains: DB.Model(...).Updates → "DB"
				IsSel:    true,
				Node:     f,
				Pos:      call.Pos(),
			})
		case *ast.FuncLit:
			// inline anonymous invocation — no symbol to resolve
		}
		return true
	})
	return calls
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

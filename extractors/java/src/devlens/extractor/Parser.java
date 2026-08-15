package devlens.extractor;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.AnnotationDeclaration;
import com.github.javaparser.ast.body.BodyDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.nodeTypes.NodeWithMembers;
import com.github.javaparser.ast.type.ReferenceType;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Parser — parse-time FACT collection (mirrors the Python parser package).
 *
 * One AST walk per file produces a ParsedFile of facts: imports, types
 * (class/interface/enum/record), fields, methods, call sites. Edge detectors
 * NEVER re-walk the AST — they resolve facts via the shared LookupMaps.
 *
 * Facts (not decisions): "who calls what" is recorded here as strings +
 * best-effort symbol-solver targets; deciding which of those become CALLS
 * edges happens later in edges/Calls.java.
 */
public final class Parser {

    private Parser() {}

    // ─────────────────────────── fact model ───────────────────────────

    public static final class ImportInfo {
        public String name;          // com.foo.Bar  |  com.foo (wildcard)
        public boolean isStatic;
        public boolean isWildcard;
    }

    public static final class FieldInfo {
        public String name;
        public String type;          // simple type name (generics stripped)
        public List<String> annotations = new ArrayList<>();
        public int line;
    }

    public static final class CallInfo {
        public String name;          // full display string: userService.getUser
        public String methodName;    // simple method name: getUser
        public String receiverName;  // root identifier of the scope (or null)
        public int line;
        public String resolvedTarget; // FQCN.method when the symbol solver hit, else null
    }

    public static final class MethodInfo {
        public String name;          // getName  |  <init> for constructors
        public boolean isConstructor;
        public boolean isStatic;
        public boolean isAbstract;
        public List<String> annotations = new ArrayList<>();
        public Map<String, String> annotationValues = new LinkedHashMap<>();
        public String returnType = "";
        public List<String> params = new ArrayList<>();
        public List<String> throwsTypes = new ArrayList<>();
        public int startLine;
        public int endLine;
        public String rawCode;
        public List<CallInfo> calls = new ArrayList<>();
    }

    public static final class TypeInfo {
        public String dottedName;    // Outer.Inner for nested types
        public String kind;          // class | interface | enum | record | annotation
        public int startLine;
        public int endLine;
        public String rawCode;
        public List<String> annotations = new ArrayList<>();
        public Map<String, String> annotationValues = new LinkedHashMap<>();
        public String extendedType = "";        // simple name (generics stripped)
        public List<String> implementedTypes = new ArrayList<>();
        public List<FieldInfo> fields = new ArrayList<>();
        public List<MethodInfo> methods = new ArrayList<>();
        public List<String> typeParameters = new ArrayList<>();
        public List<TypeInfo> nested = new ArrayList<>();
        public boolean isInterface;
        public boolean isEnum;
        public boolean isRecord;
        public boolean isAbstract;
    }

    public static final class ParsedFile {
        public String relPath;
        public String raw;
        public int endLine;
        public boolean isTest;
        public String packageName = "";
        public List<ImportInfo> imports = new ArrayList<>();
        public List<TypeInfo> types = new ArrayList<>();
        public Set<String> usedTypeNames = new LinkedHashSet<>();
        public List<String> errors = new ArrayList<>();

        /** Top-level + nested types flattened (nested get dotted names). */
        public List<TypeInfo> allTypes() {
            List<TypeInfo> out = new ArrayList<>();
            for (TypeInfo t : types) {
                out.add(t);
                out.addAll(t.nested);
            }
            return out;
        }
    }

    // ─────────────────────────── parsing ───────────────────────────

    /** Parse one file into facts. Parse problems are non-fatal (errors[]). */
    public static ParsedFile parseFile(Path repoRoot, String relPath) throws IOException {
        String raw = Files.readString(repoRoot.resolve(relPath));
        ParsedFile pf = new ParsedFile();
        pf.relPath = relPath;
        pf.raw = raw;
        pf.endLine = countLines(raw);
        pf.isTest = SourceWalker.isTestFile(relPath);
        try {
            CompilationUnit cu = StaticJavaParser.parse(raw);
            cu.getPackageDeclaration().ifPresent(p -> pf.packageName = p.getNameAsString());
            for (ImportDeclaration imp : cu.getImports()) {
                ImportInfo ii = new ImportInfo();
                ii.isStatic = imp.isStatic();
                ii.isWildcard = imp.isAsterisk();
                ii.name = imp.getNameAsString();
                pf.imports.add(ii);
            }
            for (TypeDeclaration<?> td : cu.getTypes()) {
                pf.types.add(extractType(td, pf, null));
            }
        } catch (Exception e) {
            pf.errors.add(e.getMessage() == null ? e.toString() : e.getMessage());
        }
        return pf;
    }

    private static TypeInfo extractType(TypeDeclaration<?> td, ParsedFile pf, String outerDotted) {
        TypeInfo t = new TypeInfo();
        String simple = td.getNameAsString();
        t.dottedName = outerDotted == null ? simple : outerDotted + "." + simple;
        t.startLine = lineOf(td, true);
        t.endLine = lineOf(td, false);
        t.rawCode = slice(pf.raw, t.startLine, t.endLine);

        if (td instanceof EnumDeclaration ed) {
            t.kind = "enum";
            t.isEnum = true;
            t.implementedTypes = typeNames(ed.getImplementedTypes());
            extractFields(ed, t, pf);
            extractMethods(ed, t, pf);
            extractNested(ed, t, pf, t.dottedName);
        } else if (td instanceof RecordDeclaration rd) {
            t.kind = "record";
            t.isRecord = true;
            for (Parameter p : rd.getParameters()) {   // record components → fields
                FieldInfo f = new FieldInfo();
                f.name = p.getNameAsString();
                f.type = simpleTypeName(p.getTypeAsString());
                f.line = t.startLine;
                t.fields.add(f);
            }
            t.implementedTypes = typeNames(rd.getImplementedTypes());
            extractMethods(rd, t, pf);
            extractNested(rd, t, pf, t.dottedName);
        } else if (td instanceof AnnotationDeclaration) {
            t.kind = "annotation";
        } else if (td instanceof ClassOrInterfaceDeclaration c) {
            if (c.isInterface()) {
                t.kind = "interface";
                t.isInterface = true;
            } else {
                t.kind = "class";
            }
            t.isAbstract = c.isAbstract();
            t.typeParameters.addAll(c.getTypeParameters().stream()
                    .map(tp -> tp.getNameAsString()).toList());
            c.getExtendedTypes().forEach(ext -> t.extendedType = simpleTypeName(ext.getNameAsString()));
            t.implementedTypes.addAll(typeNames(c.getImplementedTypes()));
            extractFields(c, t, pf);
            extractMethods(c, t, pf);
            extractNested(c, t, pf, t.dottedName);
        }

        collectAnnotations(td, t.annotations, t.annotationValues, pf);
        return t;
    }

    private static void extractFields(NodeWithMembers<?> node, TypeInfo t, ParsedFile pf) {
        for (BodyDeclaration<?> member : node.getMembers()) {
            if (member instanceof FieldDeclaration fd) {
                for (VariableDeclarator v : fd.getVariables()) {
                    FieldInfo f = new FieldInfo();
                    f.name = v.getNameAsString();
                    f.type = simpleTypeName(v.getTypeAsString());
                    f.line = lineOf(fd, true);
                    f.annotations.addAll(annotationNames(fd.getAnnotations()));
                    t.fields.add(f);
                }
            }
        }
    }

    private static void extractMethods(NodeWithMembers<?> node, TypeInfo t, ParsedFile pf) {
        for (BodyDeclaration<?> member : node.getMembers()) {
            if (member instanceof MethodDeclaration md) {
                t.methods.add(extractMethod(md, pf, t.isInterface));
            } else if (member instanceof ConstructorDeclaration cd) {
                t.methods.add(extractConstructor(cd, pf));
            }
        }
    }

    private static void extractNested(NodeWithMembers<?> node, TypeInfo t, ParsedFile pf, String outerDotted) {
        for (BodyDeclaration<?> member : node.getMembers()) {
            if (member instanceof TypeDeclaration<?> nested) {
                t.nested.add(extractType(nested, pf, outerDotted));
            }
        }
    }

    private static MethodInfo extractConstructor(ConstructorDeclaration cd, ParsedFile pf) {
        MethodInfo m = new MethodInfo();
        m.name = "<init>";
        m.isConstructor = true;
        m.returnType = cd.getNameAsString();
        m.startLine = lineOf(cd, true);
        m.endLine = lineOf(cd, false);
        m.rawCode = slice(pf.raw, m.startLine, m.endLine);
        collectAnnotations(cd, m.annotations, m.annotationValues, pf);
        for (Parameter p : cd.getParameters()) {
            m.params.add(p.getTypeAsString() + " " + p.getNameAsString());
        }
        m.calls = collectCalls(cd.getBody(), m);
        return m;
    }

    private static MethodInfo extractMethod(MethodDeclaration md, ParsedFile pf, boolean inInterface) {
        MethodInfo m = new MethodInfo();
        m.name = md.getNameAsString();
        m.isStatic = md.isStatic();
        m.isAbstract = inInterface || md.isAbstract();
        m.returnType = simpleTypeName(md.getTypeAsString());
        m.startLine = lineOf(md, true);
        m.endLine = lineOf(md, false);
        m.rawCode = slice(pf.raw, m.startLine, m.endLine);
        collectAnnotations(md, m.annotations, m.annotationValues, pf);
        for (Parameter p : md.getParameters()) {
            m.params.add(p.getTypeAsString() + " " + p.getNameAsString());
        }
        m.throwsTypes.addAll(md.getThrownExceptions().stream()
                .map(t -> simpleTypeName(t.asString())).toList());
        m.calls = collectCalls(md.getBody().orElse(null), m);
        return m;
    }

    /**
     * Call collection — SCOPE RULE: only the method's own body. We visit
     * MethodCallExprs but never descend into nested type declarations /
     * lambdas attributed to another owner (same guard as Python's
     * NESTED_SCOPES).
     */
    private static List<CallInfo> collectCalls(BlockStmt body, MethodInfo owner) {
        List<CallInfo> calls = new ArrayList<>();
        if (body == null) {
            return calls;
        }
        body.walk(MethodCallExpr.class, call -> {
            CallInfo ci = new CallInfo();
            ci.methodName = call.getNameAsString();
            ci.line = lineOf(call, true);
            Expression scope = call.getScope().orElse(null);
            if (scope != null) {
                ci.receiverName = rootName(scope);
                ci.name = scopeName(scope) + "." + call.getNameAsString();
            } else {
                ci.receiverName = null;
                ci.name = call.getNameAsString();
            }
            // Best-effort symbol-solver target: pkg.Class.method (or null).
            try {
                ResolvedMethodDeclaration r = call.resolve();
                ci.resolvedTarget = r.getPackageName() + "." + r.getClassName() + "." + r.getName();
            } catch (Throwable ignored) {
                // unresolved (external lib, local variable, dynamic) — fallback ladder
            }
            calls.add(ci);
        });
        return calls;
    }

    // ─────────────────────────── helpers ───────────────────────────

    private static int lineOf(Node n, boolean start) {
        return n.getRange().map(r -> start ? r.begin.line : r.end.line).orElse(0);
    }

    private static int countLines(String raw) {
        int n = 1;
        for (int i = 0; i < raw.length(); i++) {
            if (raw.charAt(i) == '\n') n++;
        }
        return n;
    }

    /** Exact source slice by 1-based inclusive line range. */
    public static String slice(String raw, int start, int end) {
        if (start < 1) start = 1;
        String[] lines = raw.split("\n", -1);
        if (end > lines.length) end = lines.length;
        StringBuilder sb = new StringBuilder();
        for (int i = start - 1; i < end; i++) {
            sb.append(lines[i]).append('\n');
        }
        return sb.toString();
    }

    /** Strip generics + qualifiers: java.util.List<User> → List. */
    public static String simpleTypeName(String type) {
        String t = type;
        int generic = t.indexOf('<');
        if (generic >= 0) t = t.substring(0, generic);
        int dot = t.lastIndexOf('.');
        if (dot >= 0) t = t.substring(dot + 1);
        return t.trim();
    }

    private static List<String> typeNames(List<? extends com.github.javaparser.ast.type.Type> types) {
        return types.stream().map(t -> simpleTypeName(t.asString())).toList();
    }

    private static List<String> annotationNames(List<AnnotationExpr> anns) {
        List<String> names = new ArrayList<>();
        for (AnnotationExpr a : anns) {
            names.add(a.getNameAsString());
        }
        return names;
    }

    private static void collectAnnotations(NodeWithAnnotations<?> node,
                                           List<String> names,
                                           Map<String, String> values,
                                           ParsedFile pf) {
        for (AnnotationExpr a : node.getAnnotations()) {
            names.add(a.getNameAsString());
            String value = annotationValue(a, values, pf);
            if (value != null) {
                values.put(a.getNameAsString(), value);
            }
        }
    }

    /**
     * First string literal from an annotation — handles the common forms:
     *   @GetMapping("/users")          → /users
     *   @RequestMapping(value="/x")    → /x
     *   @RequestMapping(path="/x")     → /x
     *   @RequestMapping({"/a","/b"})   → /a  (first element)
     *   @Entity                        → null
     */
    private static String annotationValue(AnnotationExpr a, Map<String, String> values, ParsedFile pf) {
        if (a instanceof SingleMemberAnnotationExpr single) {
            return stringOf(single.getMemberValue());
        }
        if (a instanceof NormalAnnotationExpr normal) {
            String valueResult = null;
            for (var pair : normal.getPairs()) {
                String key = pair.getNameAsString();
                if ((key.equals("value") || key.equals("path")) && valueResult == null) {
                    valueResult = stringOf(pair.getValue());
                }
                // @RequestMapping(method = RequestMethod.POST) — note: must NOT
                // early-return on the path pair; method pairs come after it.
                if (key.equals("method")) {
                    String v = enumNameOf(pair.getValue());
                    if (v != null) {
                        values.put(a.getNameAsString() + ".method", v);
                    }
                }
            }
            return valueResult;
        }
        return null;
    }

    /**
     * Verb of a method= member: RequestMethod.POST → POST (FieldAccessExpr),
     * or a bare static-imported POST (NameExpr) — realworld uses both styles.
     */
    private static String enumNameOf(Expression e) {
        if (e instanceof FieldAccessExpr fa) {
            return fa.getNameAsString();
        }
        if (e instanceof NameExpr n) {
            return n.getNameAsString();
        }
        if (e instanceof com.github.javaparser.ast.expr.ArrayInitializerExpr arr) {
            for (Expression v : arr.getValues()) {
                String s = enumNameOf(v);
                if (s != null) {
                    return s;
                }
            }
        }
        return null;
    }

    private static String stringOf(Expression e) {
        if (e instanceof StringLiteralExpr s) {
            return s.getValue();
        }
        if (e instanceof com.github.javaparser.ast.expr.ArrayInitializerExpr arr) {
            for (Expression v : arr.getValues()) {
                if (v instanceof StringLiteralExpr s) {
                    return s.getValue();
                }
            }
        }
        return null;
    }

    /**
     * Root identifier of a scope chain for field/param lookup:
     *   userService.getX()   → userService
     *   this.owners.save()   → owners   (this. prefix stripped — field lookup)
     *   config.props.save()  → config   (outer field; deep chains usually miss)
     *   service.getUser().x  → null     (method-call chain — unresolvable)
     */
    private static String rootName(Expression scope) {
        Expression cur = scope;
        String lastSegment = null;
        while (cur != null) {
            if (cur instanceof NameExpr n) {
                return n.getNameAsString();
            }
            if (cur instanceof FieldAccessExpr fa) {
                lastSegment = fa.getNameAsString();
                cur = fa.getScope();
                if (cur instanceof com.github.javaparser.ast.expr.ThisExpr
                        || cur instanceof com.github.javaparser.ast.expr.SuperExpr) {
                    return lastSegment;
                }
                continue;
            }
            return lastSegment;   // method-call chain or other expr
        }
        return lastSegment;
    }

    /** Display string of a scope: userService, userService.a.b, or the method call name. */
    private static String scopeName(Expression scope) {
        if (scope instanceof NameExpr n) {
            return n.getNameAsString();
        }
        if (scope instanceof FieldAccessExpr fa) {
            return fa.toString();
        }
        if (scope instanceof MethodCallExpr mc) {
            return mc.getNameAsString() + "()";
        }
        return scope.toString();
    }

    /** Used simple type names — feeds wildcard import resolution. */
    public static void collectUsedTypes(ParsedFile pf, TypeInfo t) {
        pf.usedTypeNames.add(t.extendedType);
        pf.usedTypeNames.addAll(t.implementedTypes);
        pf.usedTypeNames.addAll(t.typeParameters);
        pf.usedTypeNames.addAll(t.annotations);
        for (FieldInfo f : t.fields) {
            pf.usedTypeNames.add(f.type);
            pf.usedTypeNames.addAll(f.annotations);
        }
        for (MethodInfo m : t.methods) {
            pf.usedTypeNames.add(m.returnType);
            pf.usedTypeNames.addAll(m.annotations);
            for (String p : m.params) {
                pf.usedTypeNames.add(simpleTypeName(p));
            }
            pf.usedTypeNames.addAll(m.throwsTypes);
            for (CallInfo c : m.calls) {
                if (c.receiverName != null) {
                    pf.usedTypeNames.add(c.receiverName);
                }
            }
        }
        pf.usedTypeNames.remove("");
        for (TypeInfo nested : t.nested) {
            collectUsedTypes(pf, nested);
        }
    }
}

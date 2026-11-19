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
import com.github.javaparser.ast.body.InitializerDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.nodeTypes.NodeWithMembers;
import com.github.javaparser.ast.type.ReferenceType;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.CastExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.ast.stmt.CatchClause;
import com.github.javaparser.ast.stmt.DoStmt;
import com.github.javaparser.ast.stmt.ForEachStmt;
import com.github.javaparser.ast.stmt.ForStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.SwitchEntry;
import com.github.javaparser.ast.stmt.TryStmt;
import com.github.javaparser.ast.stmt.WhileStmt;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.IdentityHashMap;
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
        public int argCount;          // argument count at the call site
        public List<String> argTypes = new ArrayList<>(); // cheap arg type tags ("String", "int", "unknown")
        public boolean hasSpread = false; // Java has no call-site spread; kept for contract parity

        // ── callOrder/v1 (docs/CALL_ORDER.md) ────────────────────────────
        // Metadata only: the SET of recorded calls is decided by the walk,
        // these fields never add or remove a site.
        public int order;             // 1-based lexical rank among the owner's sites
        public int col;               // 0-based column of the call expression
        public Integer nested;        // order of the enclosing recorded call expression
        public CallInfo nestedIn;     // that enclosing site (re-linked when the file order is fixed)
        public String scope = "inline"; // inline | callback | nested | module
        public boolean awaited = false; // Java has no await — contract parity only
        public String defer;          // null = no evidence of detachment
        public String deferDetail;    // scheduler symbol ("Executors.submit", "@PostConstruct")
        public boolean conc = false;
        public boolean repeat = false;
        public boolean maybe = false;
        public boolean earlyExit = false; // Java has no `?` — contract parity only
    }

    public static final class MethodInfo {
        public String name;          // getName  |  <init> for constructors
        public boolean isConstructor;
        public boolean isStatic;
        public boolean isAbstract;
        public boolean isPublic;
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
        public boolean isPublic;
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
        /** Calls in field initializers + static/instance { } blocks. These run
         *  at class-init time and are owned by the FILE node (module scope). */
        public List<CallInfo> fileCalls = new ArrayList<>();

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
            // Field initializers and { } blocks are collected per member, so a
            // file's module-scope sites arrive in member order, not source
            // order — fix that up into ONE 1..N sequence for the FILE node.
            orderFileCalls(pf);
        } catch (Exception e) {
            pf.errors.add(e.getMessage() == null ? e.toString() : e.getMessage());
        }
        return pf;
    }

    /** Module-scope sites (FILE node): source order, contiguous ordinals, re-linked nesting. */
    private static void orderFileCalls(ParsedFile pf) {
        pf.fileCalls.sort(Comparator.comparingInt((CallInfo c) -> c.line)
                .thenComparingInt(c -> c.col));
        for (int i = 0; i < pf.fileCalls.size(); i++) {
            CallInfo ci = pf.fileCalls.get(i);
            ci.order = i + 1;
            // an enclosing site always starts before its argument — hence
            // already renumbered here, so `nested` stays a valid, smaller order.
            ci.nested = ci.nestedIn == null ? null : ci.nestedIn.order;
        }
    }

    private static TypeInfo extractType(TypeDeclaration<?> td, ParsedFile pf, String outerDotted) {
        TypeInfo t = new TypeInfo();
        String simple = td.getNameAsString();
        t.isPublic = td.isPublic();
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
                    // Field initializers run at class-init time — module scope.
                    v.getInitializer().ifPresent(init ->
                        pf.fileCalls.addAll(collectCalls(init, null, true)));
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
            } else if (member instanceof InitializerDeclaration id) {
                // static { } / instance { } blocks — module-scope call sites.
                pf.fileCalls.addAll(collectCalls(id.getBody(), null, true));
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
        m.isPublic = inInterface || md.isPublic();
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
    private static List<CallInfo> collectCalls(Node body, MethodInfo owner) {
        return collectCalls(body, owner, false);
    }

    /**
     * @param moduleScope when true, skip calls nested in a lambda / anonymous
     *   class method inside the node — those execute later, not at init time.
     */
    private static List<CallInfo> collectCalls(Node body, MethodInfo owner, boolean moduleScope) {
        List<CallInfo> calls = new ArrayList<>();
        if (body == null) {
            return calls;
        }
        // pre-order walk, so an enclosing call is always numbered before the
        // calls nested inside its arguments (nested === its order).
        Map<MethodCallExpr, CallInfo> recorded = new IdentityHashMap<>();
        body.walk(MethodCallExpr.class, call -> {
            if (moduleScope && isNestedScope(call)) {
                return;
            }
            CallInfo ci = new CallInfo();
            ci.methodName = call.getNameAsString();
            ci.line = lineOf(call, true);
            ci.col = columnOf(call);
            Expression scope = call.getScope().orElse(null);
            if (scope != null) {
                ci.receiverName = rootName(scope);
                ci.name = scopeName(scope) + "." + call.getNameAsString();
            } else {
                ci.receiverName = null;
                ci.name = call.getNameAsString();
            }
            for (Expression arg : call.getArguments()) {
                ci.argTypes.add(argTypeName(arg));
            }
            ci.argCount = ci.argTypes.size();
            // Best-effort symbol-solver target: pkg.Class.method (or null).
            try {
                ResolvedMethodDeclaration r = call.resolve();
                ci.resolvedTarget = r.getPackageName() + "." + r.getClassName() + "." + r.getName();
            } catch (Throwable ignored) {
                // unresolved (external lib, local variable, dynamic) — fallback ladder
            }
            ci.order = calls.size() + 1;
            ci.nestedIn = enclosingRecordedCall(call, recorded);
            ci.nested = ci.nestedIn == null ? null : ci.nestedIn.order;
            ci.scope = moduleScope ? "module" : scopeOf(call, body);
            annotateCallFlags(call, ci, body, owner);
            recorded.put(call, ci);
            calls.add(ci);
        });
        return calls;
    }

    // ── callOrder/v1 — placement + detachment flags ────────────────────
    // Every annotation below is derived from AST ancestry only: no call is
    // added or removed, so the recorded set stays byte-identical.

    private static final Set<String> TIMER_TYPES =
            Set.of("Timer", "ScheduledExecutorService", "ScheduledThreadPoolExecutor");
    private static final Set<String> TIMER_MEMBERS =
            Set.of("schedule", "scheduleAtFixedRate", "scheduleWithFixedDelay");
    private static final Set<String> PROMISE_MEMBERS = Set.of(
            "supplyAsync", "runAsync", "thenApply", "thenApplyAsync", "thenAccept",
            "thenAcceptAsync", "thenRun", "thenRunAsync", "thenCompose",
            "thenComposeAsync", "thenCombine", "thenCombineAsync", "applyToEither",
            "applyToEitherAsync", "acceptEither", "acceptEitherAsync", "handle",
            "handleAsync", "whenComplete", "whenCompleteAsync", "completeAsync",
            "exceptionallyAsync");
    private static final Set<String> CONC_MEMBERS = Set.of("submit", "execute", "invokeAll", "invokeAny");
    private static final Set<String> CONC_TYPES = Set.of(
            "Thread", "ForkJoinPool", "ForkJoinTask", "CompletableFuture", "ExecutorService",
            "ScheduledExecutorService", "Executor");
    /** Synchronous iteration combinators: their callback runs 0..N times. */
    private static final Set<String> ITERATION_MEMBERS = Set.of(
            "forEach", "forEachOrdered", "map", "mapToInt", "mapToLong", "mapToDouble",
            "flatMap", "filter", "reduce", "peek", "anyMatch", "allMatch", "noneMatch",
            "sorted", "removeIf");

    /**
     * The scheduler a call runs on, derived from the expression that received
     * the closure / from the detachment API itself. `defer` may be null when
     * only `conc` / `repeat` are known (ExecutorService.submit(f), stream
     * forEach) — same convention as the TypeScript annotator.
     */
    private record Scheduler(String defer, String detail, boolean conc, boolean repeat) {}

    private static void annotateCallFlags(MethodCallExpr call, CallInfo ci, Node body, MethodInfo owner) {
        Node frame = nearestFunctionLike(call, body);
        String defer = null;
        String detail = null;
        boolean conc = false;
        boolean repeat = false;

        // 1. Closure frame: a callback runs on whatever received it.
        if (frame != null) {
            Scheduler s = schedulerOfReceiver(frame, body);
            if (s != null) {
                defer = s.defer();
                detail = s.detail();
                conc = s.conc();
                repeat = s.repeat();
            }
        }

        // 2. The call site itself may be the detachment API
        //    (CompletableFuture.thenApply, timer.schedule, executor.submit, …).
        Scheduler self = schedulerOfCall(call, ci);
        if (self != null) {
            if (defer == null) {
                defer = self.defer();
                detail = self.detail();
            } else if (detail == null) {
                detail = self.detail();
            }
            conc = conc || self.conc();
            repeat = repeat || self.repeat();
        }

        // 3. Branch / loop / catch ancestry, bounded by the enclosing frame
        //    (an outer `if` decides whether the closure runs at all, not the
        //    calls inside it — those are the closure's own frame).
        Node boundary = frame != null ? frame : body;
        boolean maybe = false;
        Node child = call;
        Node parent = call.getParentNode().orElse(null);
        while (parent != null && parent != boundary) {
            if (parent instanceof ForStmt || parent instanceof ForEachStmt
                    || parent instanceof WhileStmt || parent instanceof DoStmt) {
                repeat = true;
            }
            if (parent instanceof IfStmt ifs) {
                boolean inBranch = child == ifs.getThenStmt()
                        || (ifs.getElseStmt().isPresent() && ifs.getElseStmt().get() == child);
                if (inBranch) {
                    maybe = true;
                }
            }
            if (parent instanceof ConditionalExpr cond) {
                if (child == cond.getThenExpr() || child == cond.getElseExpr()) {
                    maybe = true;
                }
            }
            if (parent instanceof SwitchEntry || parent instanceof CatchClause) {
                maybe = true;
            }
            if (parent instanceof TryStmt ts && ts.getFinallyBlock().isPresent()
                    && ts.getFinallyBlock().get() == child) {
                if (defer == null) {
                    defer = "onReturn";
                }
            }
            child = parent;
            parent = parent.getParentNode().orElse(null);
        }

        // 4. Commit-phase lifecycle method: the whole body runs post-render.
        if (defer == null && owner != null && owner.annotations.contains("PostConstruct")) {
            defer = "postRender";
            detail = "@PostConstruct";
        }

        ci.defer = defer;
        ci.deferDetail = detail;
        ci.conc = conc;
        ci.repeat = repeat;
        ci.maybe = maybe;
    }

    /**
     * Scheduler of a closure's receiver: `executor.submit(…)`, `new Thread(…)`,
     * `items.forEach(…)`, `someLib.runLater(fn)` → unknown. Null when the
     * closure is not passed to a call/creation or cannot be classified.
     */
    private static Scheduler schedulerOfReceiver(Node frame, Node body) {
        Node receiver;
        if (frame instanceof LambdaExpr lambda) {
            receiver = detachingReceiver(lambda, body);
        } else {
            ObjectCreationExpr anonymous = anonymousCreationOf(frame, body);
            receiver = anonymous == null ? null : detachingReceiver(anonymous, body);
        }
        if (receiver == null) {
            return null;
        }
        if (receiver instanceof ObjectCreationExpr creation) {
            String type = simpleTypeName(creation.getTypeAsString());
            String display = "new " + type;
            if (TIMER_TYPES.contains(type)) {
                return new Scheduler("timer", display, false, false);
            }
            if (CONC_TYPES.contains(type)) {
                return new Scheduler(null, display, true, false);
            }
            return new Scheduler("unknown", display, false, false);
        }
        MethodCallExpr mc = (MethodCallExpr) receiver;
        String display = displayOf(mc);
        String member = mc.getNameAsString();
        String root = scopeRoot(mc);
        if (isCompletionStage(root, member)) {
            return new Scheduler("promise", display, isAsyncCompletion(member), false);
        }
        if (isTimer(root, member)) {
            return new Scheduler("timer", display, false, false);
        }
        if (isConcurrentDispatch(root, member, display)) {
            return new Scheduler(null, display, true, false);
        }
        if (ITERATION_MEMBERS.contains(member)) {
            return new Scheduler(null, display, false, true);
        }
        return new Scheduler("unknown", display, false, false);
    }

    /** Scheduler signalled by the call site itself; null when it is no detachment API. */
    private static Scheduler schedulerOfCall(MethodCallExpr call, CallInfo ci) {
        String member = call.getNameAsString();
        String root = scopeRoot(call);
        String declaring = simpleTypeName(declaringClassOf(ci.resolvedTarget));
        boolean known = false;
        String defer = null;
        boolean conc = false;
        if (isCompletionStage(root, member) || "CompletableFuture".equals(declaring)) {
            defer = "promise";
            conc = isAsyncCompletion(member);
            known = true;
        } else if (isTimer(root, member) || TIMER_TYPES.contains(declaring)) {
            defer = "timer";
            known = true;
        } else if (isConcurrentDispatch(root, member, ci.name) || CONC_TYPES.contains(declaring)) {
            conc = true;
            known = true;
        }
        if (!known) {
            return null;
        }
        return new Scheduler(defer, ci.name, conc, false);
    }

    private static boolean isCompletionStage(String root, String member) {
        return "CompletableFuture".equals(root) || PROMISE_MEMBERS.contains(member);
    }

    private static boolean isAsyncCompletion(String member) {
        return member.endsWith("Async");
    }

    private static boolean isTimer(String root, String member) {
        return TIMER_MEMBERS.contains(member) || TIMER_TYPES.contains(root);
    }

    private static boolean isConcurrentDispatch(String root, String member, String display) {
        return CONC_MEMBERS.contains(member) || CONC_TYPES.contains(root)
                || display.contains("parallelStream");
    }

    /** Nearest enclosing function-like node that is not the owner itself. */
    private static Node nearestFunctionLike(Node node, Node boundary) {
        Node parent = node.getParentNode().orElse(null);
        while (parent != null && parent != boundary) {
            if (parent instanceof LambdaExpr || parent instanceof MethodDeclaration
                    || parent instanceof ConstructorDeclaration) {
                return parent;
            }
            parent = parent.getParentNode().orElse(null);
        }
        return null;
    }

    /** Anonymous class creation expression whose body contains `frame` (or null). */
    private static ObjectCreationExpr anonymousCreationOf(Node frame, Node boundary) {
        Node cur = frame.getParentNode().orElse(null);
        while (cur != null && cur != boundary) {
            if (cur instanceof ObjectCreationExpr oce && oce.getAnonymousClassBody().isPresent()) {
                return oce;
            }
            cur = cur.getParentNode().orElse(null);
        }
        return null;
    }

    /**
     * The expression that RECEIVES `fn` as an argument — the escape point of a
     * closure (`executor.submit(() -> …)`, `new Thread(runnable)`, `register(fn)`).
     * Null when `fn` is not passed to a call/creation (e.g. a lambda stored in a
     * local variable), i.e. it stays in the owner's frame.
     */
    private static Node detachingReceiver(Node fn, Node boundary) {
        Node child = fn;
        Node parent = fn.getParentNode().orElse(null);
        while (parent != null && parent != boundary) {
            if (parent instanceof MethodCallExpr mc && containsIdentity(mc.getArguments(), child)) {
                return mc;
            }
            if (parent instanceof ObjectCreationExpr oce) {
                if (containsIdentity(oce.getArguments(), child)) {
                    return oce;
                }
                if (oce.getAnonymousClassBody().isPresent()
                        && containsIdentity(oce.getAnonymousClassBody().get(), child)) {
                    return oce;
                }
            }
            if (parent instanceof EnclosedExpr || parent instanceof CastExpr) {
                child = parent;
                parent = parent.getParentNode().orElse(null);
                continue;
            }
            return null;
        }
        return null;
    }

    /** Execution region of a call site (docs/CALL_ORDER.md §4.3). */
    private static String scopeOf(MethodCallExpr call, Node body) {
        Node frame = nearestFunctionLike(call, body);
        if (frame == null) {
            return "inline";
        }
        Scheduler detached = schedulerOfReceiver(frame, body);
        if (detached != null) {
            return "callback";
        }
        // A lambda or class body that never leaves the owner is a nested
        // declaration the owner runs itself.
        return "nested";
    }

    /** Nearest enclosing recorded call site of the same owner: bar.nested === foo.order. */
    private static CallInfo enclosingRecordedCall(MethodCallExpr call, Map<MethodCallExpr, CallInfo> recorded) {
        Node parent = call.getParentNode().orElse(null);
        while (parent != null) {
            if (parent instanceof MethodCallExpr mc) {
                CallInfo enclosing = recorded.get(mc);
                if (enclosing != null) {
                    return enclosing;
                }
            }
            parent = parent.getParentNode().orElse(null);
        }
        return null;
    }

    private static boolean containsIdentity(List<? extends Node> nodes, Node target) {
        for (Node n : nodes) {
            if (n == target) {
                return true;
            }
        }
        return false;
    }

    /** Display string of a call as written: executor.submit, CompletableFuture.supplyAsync. */
    private static String displayOf(MethodCallExpr call) {
        Expression scope = call.getScope().orElse(null);
        return (scope == null ? "" : scopeName(scope) + ".") + call.getNameAsString();
    }

    /** Root identifier of a call's receiver ("executor" for executor.submit). */
    private static String scopeRoot(MethodCallExpr call) {
        Expression scope = call.getScope().orElse(null);
        if (scope == null) {
            return "";
        }
        if (scope instanceof NameExpr n) {
            return n.getNameAsString();
        }
        String root = rootName(scope);
        return root == null ? "" : root;
    }

    /** "java.util.concurrent.CompletableFuture.thenApply" → "java.util.concurrent.CompletableFuture". */
    private static String declaringClassOf(String resolvedTarget) {
        if (resolvedTarget == null) {
            return "";
        }
        int dot = resolvedTarget.lastIndexOf('.');
        return dot < 0 ? resolvedTarget : resolvedTarget.substring(0, dot);
    }

    private static int columnOf(Node n) {
        return n.getRange().map(r -> Math.max(0, r.begin.column - 1)).orElse(0);
    }

    /**
     * True when the call executes inside a lambda or an anonymous/local class
     * method — i.e. not at the initializer's own init time.
     */
    private static boolean isNestedScope(MethodCallExpr call) {
        return call.findAncestor(LambdaExpr.class).isPresent()
                || call.findAncestor(MethodDeclaration.class).isPresent()
                || call.findAncestor(ConstructorDeclaration.class).isPresent();
    }

    /**
     * Cheap argument type tag in the same vocabulary as declared param types:
     * literals map directly, anything else goes through the symbol solver
     * (best-effort), falling back to "unknown".
     */
    private static String argTypeName(Expression arg) {
        if (arg instanceof StringLiteralExpr) return "String";
        if (arg instanceof com.github.javaparser.ast.expr.IntegerLiteralExpr) return "int";
        if (arg instanceof com.github.javaparser.ast.expr.LongLiteralExpr) return "long";
        if (arg instanceof com.github.javaparser.ast.expr.DoubleLiteralExpr) return "double";
        if (arg instanceof com.github.javaparser.ast.expr.BooleanLiteralExpr) return "boolean";
        if (arg instanceof com.github.javaparser.ast.expr.CharLiteralExpr) return "char";
        if (arg instanceof com.github.javaparser.ast.expr.NullLiteralExpr) return "null";
        if (arg instanceof ObjectCreationExpr nce) {
            return simpleTypeName(nce.getTypeAsString());
        }
        try {
            if (TypeSolverFactory.solver() == null) {
                return "unknown";
            }
            com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade facade =
                    com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade.get(TypeSolverFactory.solver());
            return simpleTypeName(facade.getType(arg).describe());
        } catch (Throwable ignored) {
            return "unknown";
        }
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

package devlens.extractor;

import devlens.extractor.edges.Calls;
import devlens.extractor.edges.Enrich;
import devlens.extractor.edges.Imports;
import devlens.extractor.edges.Inheritance;
import devlens.extractor.edges.OrmEdges;
import devlens.extractor.edges.Routes;
import devlens.extractor.edges.Tests;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Extractor — the pipeline orchestrator (mirrors extractor.py).
 *
 * Pipeline order (each stage consumes the shared LookupMaps, never re-walks
 * the AST):
 *   1. walk + parse every .java file → nodes (test files stay leaf nodes)
 *   2. shared lookup maps + imports → IMPORTS edges + symbol maps + [mvn] nodes
 *   3. calls → CALLS edges (lazy [mvn]/pkg::member nodes)
 *   4. routes → ROUTE nodes + BackendRouteNodes + HANDLES edges
 *   5. ORM → model metadata + READS_FROM/WRITES_TO edges
 *   6. inheritance → EXTENDS / IMPLEMENTS
 *   7. tests → TESTS edges
 *   8. enrich → semantic metadata
 *   9. collect third-party nodes (after call resolution), dedupe + sort
 */
public final class Extractor {

    private static final String LANGUAGE = "java";

    private final String repoPath;
    private final List<String> allowedThirdPartyLibs;

    public Extractor(String repoPath, List<String> allowedThirdPartyLibs) {
        this.repoPath = repoPath;
        this.allowedThirdPartyLibs = allowedThirdPartyLibs == null
                ? new ArrayList<>() : allowedThirdPartyLibs;
    }

    public ExtractorResult run() {
        Path root = Path.of(repoPath);
        TypeSolverFactory.configure(root);

        Fingerprint fp = Fingerprint.detect(root);
        List<Map<String, Object>> nodes = new ArrayList<>();
        List<Map<String, Object>> edgesOut = new ArrayList<>();
        List<Map<String, Object>> errors = new ArrayList<>();
        List<Parser.ParsedFile> parsedFiles = new ArrayList<>();
        Map<String, List<Parser.CallInfo>> methodCallFacts = new LinkedHashMap<>();
        Map<String, List<String>> testCases = new LinkedHashMap<>();
        int totalFiles = 0;
        int skipped = 0;

        // ── 1. walk + parse ─────────────────────────────────────────────
        List<String> relPaths;
        try {
            relPaths = SourceWalker.walkJavaFiles(root);
        } catch (IOException e) {
            return new ExtractorResult(errorResult(fp, e.getMessage()), true);
        }

        for (String rel : relPaths) {
            totalFiles++;
            try {
                Parser.ParsedFile pf = Parser.parseFile(root, rel);
                parsedFiles.add(pf);
                for (Parser.TypeInfo t : pf.types) {
                    Parser.collectUsedTypes(pf, t);
                }
                if (pf.isTest) {
                    List<String> cases = new ArrayList<>();
                    for (Parser.TypeInfo t : pf.allTypes()) {
                        for (Parser.MethodInfo m : t.methods) {
                            if (m.annotations.contains("Test")
                                    || m.name.toLowerCase().startsWith("test")) {
                                cases.add(m.name);
                            }
                        }
                    }
                    java.util.Collections.sort(cases);
                    testCases.put(rel, cases);
                }
            } catch (IOException e) {
                skipped++;
                errors.add(Contract.error(rel, e.getMessage()));
            }
        }

        // ── 2. build nodes + call facts ─────────────────────────────────
        for (Parser.ParsedFile pf : parsedFiles) {
            nodes.add(Contract.fileNode(pf.relPath, pf.endLine, pf.isTest ? "TEST" : "FILE", LANGUAGE));
            if (pf.isTest) {
                continue;   // test files are LEAF nodes — children feed metadata only
            }
            List<String> childIds = new ArrayList<>();
            for (Parser.TypeInfo t : pf.allTypes()) {
                Map<String, Object> typeNode = buildTypeNode(pf, t);
                nodes.add(typeNode);
                childIds.add((String) typeNode.get("id"));
                @SuppressWarnings("unchecked")
                List<String> childMethods = (List<String>) ((Map<String, Object>) typeNode.get("metadata")).get("childMethodIds");
                for (Parser.MethodInfo m : t.methods) {
                    Map<String, Object> methodNode = buildMethodNode(pf, t, m);
                    nodes.add(methodNode);
                    childMethods.add(t.dottedName + "." + m.name);
                    methodCallFacts.put((String) methodNode.get("id"), m.calls);
                }
            }
            // attach children to the FILE node
            for (Map<String, Object> n : nodes) {
                if (n.get("id").equals("file::" + pf.relPath)) {
                    @SuppressWarnings("unchecked")
                    List<String> cn = (List<String>) ((Map<String, Object>) n.get("metadata")).get("childNodeIds");
                    cn.addAll(childIds);
                    ((Map<String, Object>) n.get("metadata")).put("nodeCount", childIds.size());
                    break;
                }
            }
        }

        // ── 3. shared lookup (built ONCE, consumed by every detector) ───
        LookupMaps lookup = LookupMaps.build(parsedFiles, nodes);
        lookup.methodCallFacts.putAll(methodCallFacts);
        lookup.testCases.putAll(testCases);
        ThirdParty tp = new ThirdParty(fp.rawDependencies, allowedThirdPartyLibs);

        // ── 4. edges ───────────────────────────────────────────────────
        Imports.resolve(parsedFiles, lookup, tp, edgesOut);
        OrmEdges.detect(lookup, edgesOut);           // models/repos BEFORE calls (repo CALLS target)
        Calls.resolve(lookup, edgesOut);
        Routes.RouteResult routeResult = Routes.resolve(parsedFiles, lookup, fp.framework);
        edgesOut.addAll(routeResult.handlesEdges);
        nodes.addAll(routeResult.routeNodes);
        OrmEdges.consumerEdges(lookup, edgesOut);    // repo-call → R/W edges
        Inheritance.resolve(parsedFiles, lookup, tp, edgesOut);
        Tests.resolve(lookup, edgesOut);
        Enrich.enrich(lookup);

        // ── 5. third-party nodes AFTER edge resolution (lazy members) ───
        nodes.addAll(tp.allNodes());

        // ── 6. dedupe edges (from|type|to) + deterministic sort ─────────
        Set<String> seenEdges = new HashSet<>();
        List<Map<String, Object>> uniqueEdges = new ArrayList<>();
        for (Map<String, Object> e : edgesOut) {
            if (seenEdges.add(Contract.edgeKey(e))) {
                uniqueEdges.add(e);
            }
        }
        edgesOut = uniqueEdges;
        nodes.sort(Comparator.comparing(n -> (String) n.get("id")));
        edgesOut.sort(Comparator.comparing(n -> Contract.edgeKey(n)));
        routeResult.routes.sort(Comparator
                .comparing((Map<String, Object> r) -> (String) r.get("httpMethod"))
                .thenComparing(r -> (String) r.get("urlPath")));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("fingerprint", fp.toDict());
        result.put("nodes", nodes);
        result.put("edges", edgesOut);
        result.put("routes", routeResult.routes);
        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("totalFiles", totalFiles);
        stats.put("totalNodes", nodes.size());
        stats.put("skippedFiles", skipped);
        result.put("stats", stats);
        result.put("errors", errors);
        return new ExtractorResult(result, false);
    }

    private Map<String, Object> errorResult(Fingerprint fp, String message) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("fingerprint", fp.toDict());
        result.put("nodes", new ArrayList<Map<String, Object>>());
        result.put("edges", new ArrayList<Map<String, Object>>());
        result.put("routes", new ArrayList<Map<String, Object>>());
        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("totalFiles", 0);
        stats.put("totalNodes", 0);
        stats.put("skippedFiles", 0);
        result.put("stats", stats);
        List<Map<String, Object>> errors = new ArrayList<>();
        errors.add(Contract.error("", message));
        result.put("errors", errors);
        return result;
    }

    private static String nodeTypeFor(Parser.TypeInfo t) {
        return switch (t.kind) {
            case "interface" -> "INTERFACE";
            case "enum" -> "ENUM";
            default -> "CLASS";     // class | record | annotation
        };
    }

    private static Map<String, Object> buildTypeNode(Parser.ParsedFile pf, Parser.TypeInfo t) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("kind", t.kind);
        metadata.put("annotations", t.annotations);
        metadata.put("isAbstract", t.isAbstract);
        if (!t.typeParameters.isEmpty()) {
            metadata.put("typeParameters", t.typeParameters);
        }
        if (t.extendedType != null && !t.extendedType.isEmpty()) {
            metadata.put("extendsType", t.extendedType);
        }
        if (!t.implementedTypes.isEmpty()) {
            metadata.put("implementsTypes", t.implementedTypes);
        }
        List<Map<String, Object>> fields = new ArrayList<>();
        for (Parser.FieldInfo f : t.fields) {
            Map<String, Object> fm = new LinkedHashMap<>();
            fm.put("name", f.name);
            fm.put("type", f.type);
            if (!f.annotations.isEmpty()) {
                fm.put("annotations", f.annotations);
            }
            fields.add(fm);
        }
        if (!fields.isEmpty()) {
            metadata.put("fields", fields);
        }
        metadata.put("childMethodIds", new ArrayList<String>());
        return Contract.codeNode(pf.relPath, t.dottedName, nodeTypeFor(t),
                t.startLine, t.endLine, t.rawCode, metadata, LANGUAGE);
    }

    private static Map<String, Object> buildMethodNode(Parser.ParsedFile pf, Parser.TypeInfo t, Parser.MethodInfo m) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("parentClass", t.dottedName);
        metadata.put("isConstructor", m.isConstructor);
        metadata.put("isStatic", m.isStatic);
        metadata.put("isAbstract", m.isAbstract);
        if (!m.annotations.isEmpty()) {
            metadata.put("annotations", m.annotations);
        }
        if (!m.params.isEmpty()) {
            metadata.put("params", m.params);
        }
        if (!m.returnType.isEmpty()) {
            metadata.put("returnType", m.returnType);
        }
        if (!m.throwsTypes.isEmpty()) {
            metadata.put("throws", m.throwsTypes);
        }
        if (!m.calls.isEmpty()) {
            List<String> callStrings = m.calls.stream().map(c -> c.name).distinct().sorted().toList();
            metadata.put("calls", callStrings);
        }
        return Contract.codeNode(pf.relPath, t.dottedName + "." + m.name, "METHOD",
                m.startLine, m.endLine, m.rawCode, metadata, LANGUAGE);
    }
}

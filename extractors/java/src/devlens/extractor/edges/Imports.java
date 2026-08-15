package devlens.extractor.edges;

import devlens.extractor.Contract;
import devlens.extractor.LookupMaps;
import devlens.extractor.Parser;
import devlens.extractor.ThirdParty;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * IMPORTS edge resolution (mirrors edges/imports.py).
 *
 * Java imports are fully qualified → resolution is exact via typeMap:
 *   import com.foo.bar.Baz → typeMap["com.foo.bar.Baz"] → local file edge.
 * Wildcards expand to the types the file ACTUALLY uses (usedTypeNames),
 * static imports resolve to their containing class. JDK → nothing. External
 * non-JDK → gated [mvn] nodes + the import alias lands in the file's
 * symbolMap (the bridge Calls/Inheritance/Tests consume).
 */
public final class Imports {

    private Imports() {}

    public static void resolve(List<Parser.ParsedFile> files, LookupMaps lookup,
                               ThirdParty tp, List<Map<String, Object>> edgesOut) {
        for (Parser.ParsedFile pf : files) {
            Map<String, String> sm = lookup.symbolMap(pf.relPath);
            List<String> imported = new ArrayList<>();
            for (Parser.ImportInfo imp : pf.imports) {
                if (imp.isStatic) {
                    resolveStatic(pf, imp, lookup, sm, edgesOut, imported);
                } else if (imp.isWildcard) {
                    resolveWildcard(pf, imp, lookup, tp, sm, edgesOut, imported);
                } else {
                    resolveSingle(pf, imp, lookup, tp, sm, edgesOut, imported);
                }
            }
            java.util.Collections.sort(imported);
            attachImportsMetadata(lookup, pf, imported);
        }
    }

    private static void resolveSingle(Parser.ParsedFile pf, Parser.ImportInfo imp,
                                      LookupMaps lookup, ThirdParty tp,
                                      Map<String, String> sm,
                                      List<Map<String, Object>> edgesOut,
                                      List<String> imported) {
        String fqcn = imp.name;
        String simple = simpleName(fqcn);
        String rel = lookup.typeMap.get(fqcn);
        if (rel != null) {
            String dotted = lookup.typeDottedMap.get(fqcn);
            String targetId = rel + "::" + dotted;
            edgesOut.add(Contract.edge("IMPORTS", "file::" + pf.relPath, "file::" + rel, null));
            sm.put(simple, targetId);
            imported.add(rel);
            return;
        }
        if (ThirdParty.isJdk(fqcn)) {
            return;   // stdlib tier — no node, no edge
        }
        String prefix = ThirdParty.packagePrefix(fqcn);
        Map<String, Object> pkgNode = tp.packageNode(prefix);
        if (pkgNode == null) {
            return;   // gated out
        }
        Map<String, Object> memberNode = tp.methodNode(prefix, simple);
        String targetId = (String) memberNode.get("id");
        edgesOut.add(Contract.edge("IMPORTS", "file::" + pf.relPath, targetId, null));
        sm.put(simple, targetId);
        imported.add(targetId);
    }

    /**
     * Wildcard: import com.foo.* — resolve only the simple names this file
     * actually uses (type refs, annotations, field/param types). Local types
     * become per-type edges; external packages become a single package node.
     */
    private static void resolveWildcard(Parser.ParsedFile pf, Parser.ImportInfo imp,
                                        LookupMaps lookup, ThirdParty tp,
                                        Map<String, String> sm,
                                        List<Map<String, Object>> edgesOut,
                                        List<String> imported) {
        String prefix = imp.name;   // com.foo
        if (ThirdParty.isJdk(prefix)) {
            return;
        }
        boolean anyLocal = false;
        for (String used : pf.usedTypeNames) {
            if (used == null || used.isEmpty()) {
                continue;
            }
            String fqcn = prefix + "." + used;
            String rel = lookup.typeMap.get(fqcn);
            if (rel != null) {
                String dotted = lookup.typeDottedMap.get(fqcn);
                edgesOut.add(Contract.edge("IMPORTS", "file::" + pf.relPath, "file::" + rel, null));
                sm.put(used, rel + "::" + dotted);
                imported.add(rel);
                anyLocal = true;
            }
        }
        if (!anyLocal) {
            Map<String, Object> pkgNode = tp.packageNode(ThirdParty.packagePrefix(prefix));
            if (pkgNode != null) {
                edgesOut.add(Contract.edge("IMPORTS", "file::" + pf.relPath,
                        (String) pkgNode.get("id"), null));
                imported.add((String) pkgNode.get("id"));
            }
        }
    }

    /** import static com.foo.Constants.PI → resolve the containing class. */
    private static void resolveStatic(Parser.ParsedFile pf, Parser.ImportInfo imp,
                                      LookupMaps lookup, Map<String, String> sm,
                                      List<Map<String, Object>> edgesOut,
                                      List<String> imported) {
        String fqcn = imp.name;      // com.foo.Constants (member dropped for V1)
        String rel = lookup.typeMap.get(fqcn);
        if (rel != null) {
            String dotted = lookup.typeDottedMap.get(fqcn);
            edgesOut.add(Contract.edge("IMPORTS", "file::" + pf.relPath, "file::" + rel, null));
            sm.put(simpleName(fqcn), rel + "::" + dotted);
            imported.add(rel);
        }
        // external static imports (constants from libs) → skip for V1
    }

    /** metadata.imports = sorted resolved targets, on every node of the file. */
    private static void attachImportsMetadata(LookupMaps lookup, Parser.ParsedFile pf,
                                              List<String> imported) {
        Map<String, Object> fileNode = lookup.fileNodesByPath.get(pf.relPath);
        if (fileNode != null) {
            ((Map<String, Object>) fileNode.get("metadata")).put("imports", imported);
        }
        Map<String, String> byFile = lookup.nodesByFile.get(pf.relPath);
        if (byFile == null) {
            return;
        }
        for (String id : byFile.values()) {
            Map<String, Object> node = lookup.nodeById.get(id);
            if (node != null) {
                ((Map<String, Object>) node.get("metadata")).put("imports", imported);
            }
        }
    }

    private static String simpleName(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        return dot < 0 ? fqcn : fqcn.substring(dot + 1);
    }
}

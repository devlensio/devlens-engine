package devlens.extractor;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Exports Map — the flattened public surface of a Java repo, shipped in the
 * ExtractorResult for cross-repo linking (docs/EXPORTS_MAP.txt).
 *
 * Java-specific concerns:
 *   - Java has no re-export chains: the importable surface of a package is
 *     exactly its PUBLIC top-level (and public nested) types. The map key is
 *     the FQCN the importer writes (`import com.foo.Bar;`), under the single
 *     subpath "." (Java packages are not subpaths; the FQCN is the door).
 *   - Public methods of public types are emitted as "FQCN.method" keys —
 *     what consumer CALLS edges resolve against. Overload groups surface as
 *     multi-element arrays (ids carry the #arity/#sig8 suffixes from
 *     Overloads.disambiguate).
 *   - Nested types are included only when EVERY enclosing type is public
 *     (Outer must be importable for Outer.Inner to be reachable).
 *   - Package-private types are excluded — not importable cross-package.
 *   - Java rejects duplicate FQCNs at compile time, so ambiguousNames is a
 *     safety net that should stay empty.
 *   - Values are ALWAYS arrays of proper nodeIds as they appear in the nodes
 *     array (built AFTER Overloads.disambiguate).
 */
public final class ExportsMapBuilder {

    private ExportsMapBuilder() {
    }

    public static Map<String, Object> build(List<Parser.ParsedFile> parsedFiles, List<Map<String, Object>> nodes) {
        Map<String, List<String>> surface = new TreeMap<>();
        List<String> ambiguous = new ArrayList<>();

        for (Parser.ParsedFile pf : parsedFiles) {
            if (pf.isTest || pf.types.isEmpty()) {
                continue;
            }
            for (Parser.TypeInfo t : pf.types) {
                if (!t.isPublic) {
                    continue;
                }
                addType(pf, t, null, nodes, surface, ambiguous);
            }
        }

        if (surface.isEmpty()) {
            return null;
        }

        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> exports = new LinkedHashMap<>();
        exports.put(".", surface);
        out.put("exports", exports);
        Map<String, Object> ambiguousNames = new LinkedHashMap<>();
        if (!ambiguous.isEmpty()) {
            ambiguousNames.put(".", ambiguous);
        }
        out.put("ambiguousNames", ambiguousNames);
        return out;
    }

    private static void addType(Parser.ParsedFile pf, Parser.TypeInfo t, String parentFqcn,
                                List<Map<String, Object>> nodes,
                                Map<String, List<String>> surface, List<String> ambiguous) {
        String fqcn = pf.packageName.isEmpty()
                ? t.dottedName
                : pf.packageName + "." + t.dottedName;
        String id = pf.relPath + "::" + t.dottedName;
        if (containsNode(nodes, id)) {
            addEntry(surface, ambiguous, fqcn, List.of(id));
        }

        String childFqcn = fqcn;
        for (Parser.MethodInfo m : t.methods) {
            if (!m.isPublic || m.isConstructor) {
                continue;
            }
            List<String> ids = methodIds(nodes, pf, t, m.name);
            if (!ids.isEmpty()) {
                addEntry(surface, ambiguous, childFqcn + "." + m.name, ids);
            }
        }

        for (Parser.TypeInfo nested : t.nested) {
            if (nested.isPublic) {
                addType(pf, nested, childFqcn, nodes, surface, ambiguous);
            }
        }
    }

    private static void addEntry(Map<String, List<String>> surface, List<String> ambiguous,
                                 String key, List<String> ids) {
        List<String> sorted = new ArrayList<>(ids);
        java.util.Collections.sort(sorted);
        List<String> existing = surface.get(key);
        if (existing == null) {
            surface.put(key, sorted);
        } else if (!existing.equals(sorted)) {
            ambiguous.add(key);
        }
    }

    private static boolean containsNode(List<Map<String, Object>> nodes, String id) {
        for (Map<String, Object> n : nodes) {
            if (id.equals(n.get("id"))) {
                return true;
            }
        }
        return false;
    }

    private static List<String> methodIds(List<Map<String, Object>> nodes, Parser.ParsedFile pf,
                                          Parser.TypeInfo t, String methodName) {
        List<String> ids = new ArrayList<>();
        for (Map<String, Object> n : nodes) {
            String id = (String) n.get("id");
            if (id == null || !id.startsWith(pf.relPath + "::" + t.dottedName + ".")) {
                continue;
            }
            if (!pf.relPath.equals(n.get("filePath"))) {
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> metadata = (Map<String, Object>) n.get("metadata");
            if (metadata == null || !t.dottedName.equals(metadata.get("parentClass"))) {
                continue;
            }
            if (Boolean.TRUE.equals(metadata.get("isConstructor"))) {
                continue;
            }
            if (!Boolean.TRUE.equals(metadata.get("isPublic"))) {
                continue;
            }
            String nodeName = (String) n.get("name");
            if (nodeName != null && (nodeName.equals(methodName)
                    || nodeName.endsWith("." + methodName)
                    || nodeName.endsWith("#" + methodName))) {
                ids.add(id);
            }
        }
        return ids;
    }
}

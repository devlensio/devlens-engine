package devlens.extractor;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * LookupMaps — ONE shared index built once from the parsed files + nodes,
 * consumed by every edge detector (mirrors lookup.py). Edge detectors never
 * re-walk ASTs; they answer "which node is this name?" through these maps.
 *
 * Java specifics:
 *   typeMap      FQCN (pkg + dottedName) → relPath — import resolution is
 *                exact because Java imports are fully qualified
 *   typeDottedMap FQCN → dottedName (Outer.Inner) — needed to rebuild node ids
 *   symbolMaps   per-file {simple alias → node id} — written by Imports,
 *                consumed by Calls / Inheritance / Tests
 */
public final class LookupMaps {

    public final Map<String, List<String>> nodesByName = new HashMap<>();
    public final Map<String, Map<String, String>> nodesByFile = new HashMap<>();
    public final Map<String, Map<String, Object>> nodeById = new LinkedHashMap<>();
    public final Map<String, Map<String, Object>> fileNodesByPath = new HashMap<>();
    public final Map<String, Map<String, String>> symbolMaps = new HashMap<>();
    public final Map<String, String> typeMap = new HashMap<>();
    public final Map<String, String> typeDottedMap = new HashMap<>();
    public final List<String> methodNodes = new ArrayList<>();
    /** method node id → parse-time call facts (CallInfo) */
    public final Map<String, List<Parser.CallInfo>> methodCallFacts = new LinkedHashMap<>();
    /** test file relPath → test method names (metadata.testCases) */
    public final Map<String, List<String>> testCases = new HashMap<>();

    public static LookupMaps build(List<Parser.ParsedFile> parsedFiles,
                                   List<Map<String, Object>> nodes) {
        LookupMaps lm = new LookupMaps();
        for (Map<String, Object> node : nodes) {
            String id = (String) node.get("id");
            String type = (String) node.get("type");
            lm.nodeById.put(id, node);
            if ("FILE".equals(type) || "TEST".equals(type)) {
                lm.fileNodesByPath.put((String) node.get("filePath"), node);
                continue;
            }
            String name = (String) node.get("name");
            if (name != null) {
                lm.nodesByName.computeIfAbsent(name, k -> new ArrayList<>()).add(id);
            }
            if ("METHOD".equals(type)) {
                lm.methodNodes.add(id);
            } else if (isTypeNode(type)) {
                String filePath = (String) node.get("filePath");
                lm.nodesByFile.computeIfAbsent(filePath, k -> new HashMap<>())
                        .put(name, id);
            }
        }
        for (Parser.ParsedFile pf : parsedFiles) {
            for (Parser.TypeInfo t : pf.allTypes()) {
                String fqcn = pf.packageName == null || pf.packageName.isEmpty()
                        ? t.dottedName : pf.packageName + "." + t.dottedName;
                lm.typeMap.put(fqcn, pf.relPath);
                lm.typeDottedMap.put(fqcn, t.dottedName);
            }
        }
        return lm;
    }

    private static boolean isTypeNode(String type) {
        return "CLASS".equals(type) || "INTERFACE".equals(type) || "ENUM".equals(type);
    }

    public Map<String, String> symbolMap(String relPath) {
        return symbolMaps.computeIfAbsent(relPath, k -> new HashMap<>());
    }

    /**
     * Simple-name disambiguation for fallback resolution: among the candidate
     * node ids sharing this simple name, pick the one whose file shares the
     * longest directory prefix with the caller (same file wins).
     */
    public String closestByName(String name, String callerRelPath) {
        List<String> candidates = nodesByName.get(name);
        if (candidates == null || candidates.isEmpty()) {
            return null;
        }
        if (candidates.size() == 1) {
            return candidates.get(0);
        }
        String best = candidates.get(0);
        int bestScore = -1;
        for (String id : candidates) {
            Map<String, Object> node = nodeById.get(id);
            if (node == null) {
                continue;
            }
            String filePath = (String) node.get("filePath");
            int score = commonDirPrefixLength(filePath, callerRelPath);
            if (score > bestScore) {
                bestScore = score;
                best = id;
            }
        }
        return best;
    }

    private static int commonDirPrefixLength(String a, String b) {
        if (a.equals(b)) {
            return Integer.MAX_VALUE / 2;
        }
        String[] aa = a.split("/");
        String[] bb = b.split("/");
        int n = 0;
        for (int i = 0; i < Math.min(aa.length, bb.length) - 1; i++) {
            if (!aa[i].equals(bb[i])) {
                break;
            }
            n++;
        }
        return n;
    }
}

package devlens.extractor;

import devlens.extractor.Parser.CallInfo;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Overload disambiguation — same-name methods in the same file (mirrors
 * src/parser/overloads.ts from the TypeScript engine; keep in sync).
 *
 * Method node ids are `rel::Type.method`, so two overloads of `format`
 * produced two nodes with ONE id and downstream dedupe silently dropped all
 * but the first. Convention:
 *   - unique name in file   → id unchanged
 *   - distinct arities      → `#<arity>` (the declaration's own param count,
 *                             never ordinals)
 *   - same arity, different param types → `#<arity>#<sig8>` where sig8 is the
 *                             first 8 lowercase hex chars of sha-256 over the
 *                             normalized signature "(T1,T2)"
 *   - signature-identical declarations collapse to one node (prefer the one
 *     with a body)
 * Groups are per file; the same method name on different types (dotted names)
 * never collides.
 *
 * Also hosts the overload-aware CALLS resolution ladder shared by the edge
 * detectors: arity filter, then argTypes agreement, then first candidate.
 */
public final class Overloads {

    private Overloads() {}

    /**
     * Normalized param type from a metadata params entry ("Type name" — type
     * first, name last; the name is the final space-separated token). Varargs
     * normalize to "...Type" so signature keys and typeAgrees stay name-free.
     */
    public static String paramTypeOf(String paramDecl) {
        if (paramDecl == null) {
            return "unknown";
        }
        String t = paramDecl.trim();
        boolean varargs = t.contains("...");
        t = t.replace("...", "");
        int sp = t.lastIndexOf(' ');
        if (sp >= 0) {
            t = t.substring(0, sp).trim();
        }
        if (varargs) {
            return "..." + t;
        }
        return t.isEmpty() ? "unknown" : t;
    }

    /** Normalized signature string "(T1,T2)" from a params list. */
    public static String signatureKey(List<String> params) {
        StringBuilder sb = new StringBuilder("(");
        for (int i = 0; i < params.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(paramTypeOf(params.get(i)));
        }
        return sb.append(')').toString();
    }

    /** First 8 lowercase hex chars of sha-256 over the signature string. */
    public static String sig8(String signatureKey) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(signatureKey.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(8);
            for (int i = 0; i < 4; i++) {
                sb.append(String.format("%02x", digest[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return "00000000";
        }
    }

    @SuppressWarnings("unchecked")
    private static List<String> paramsOf(Map<String, Object> methodNode) {
        Map<String, Object> metadata = (Map<String, Object>) methodNode.get("metadata");
        Object params = metadata == null ? null : metadata.get("params");
        return params instanceof List ? (List<String>) params : new ArrayList<>();
    }

    private static boolean hasBody(Map<String, Object> methodNode) {
        Map<String, Object> metadata = (Map<String, Object>) methodNode.get("metadata");
        return metadata == null || !Boolean.TRUE.equals(metadata.get("isAbstract"))
                || Boolean.TRUE.equals(metadata.get("isConstructor"));
    }

    private static int arityOf(Map<String, Object> methodNode) {
        return paramsOf(methodNode).size();
    }

    /**
     * Rewrites METHOD node ids for same-name groups within one file, marks
     * collapsed duplicates, and remaps methodCallFacts keys to the new ids.
     * Deterministic: groups in insertion (line) order, no ordinal suffixes.
     */
    public static void disambiguate(List<Map<String, Object>> nodes,
                                    Map<String, List<Parser.CallInfo>> methodCallFacts) {
        Map<String, List<Map<String, Object>>> groups = new LinkedHashMap<>();
        for (Map<String, Object> node : nodes) {
            if (!"METHOD".equals(node.get("type"))) {
                continue;
            }
            String key = node.get("filePath") + "|" + node.get("name");
            groups.computeIfAbsent(key, k -> new ArrayList<>()).add(node);
        }

        for (List<Map<String, Object>> group : groups.values()) {
            if (group.size() < 2) {
                continue;
            }

            // Collapse signature-identical declarations, prefer the one with a body.
            Map<String, Map<String, Object>> bySignature = new LinkedHashMap<>();
            Map<Map<String, Object>, String> keys = new LinkedHashMap<>();
            for (Map<String, Object> node : group) {
                String key = signatureKey(paramsOf(node));
                keys.put(node, key);
                Map<String, Object> existing = bySignature.get(key);
                if (existing == null) {
                    bySignature.put(key, node);
                } else if (!hasBody(existing) && hasBody(node)) {
                    bySignature.put(key, node);
                }
            }
            List<Map<String, Object>> survivors = new ArrayList<>(bySignature.values());
            if (survivors.size() < group.size()) {
                Set<Map<String, Object>> kept = new LinkedHashSet<>(survivors);
                List<Map<String, Object>> dropped = new ArrayList<>();
                for (Map<String, Object> node : group) {
                    if (!kept.contains(node)) {
                        ((Map<String, Object>) node.get("metadata")).put("isDuplicateOverload", true);
                        dropped.add(node);
                    }
                }
                nodes.removeAll(dropped);
                for (Map<String, Object> node : dropped) {
                    methodCallFacts.remove(node.get("id"));
                }
            }
            if (survivors.size() < 2) {
                continue;
            }

            Set<Integer> arities = new LinkedHashSet<>();
            for (Map<String, Object> node : survivors) {
                arities.add(arityOf(node));
            }
            boolean useArityOnly = arities.size() == survivors.size();
            String relPath = (String) survivors.get(0).get("filePath");
            String name = (String) survivors.get(0).get("name");

            for (Map<String, Object> node : survivors) {
                int arity = arityOf(node);
                String suffix = "#" + arity;
                if (!useArityOnly) {
                    suffix = "#" + arity + "#" + sig8(keys.get(node));
                }
                String newId = relPath + "::" + name + suffix;
                if (!newId.equals(node.get("id"))) {
                    List<Parser.CallInfo> facts = methodCallFacts.remove(node.get("id"));
                    node.put("id", newId);
                    if (facts != null) {
                        methodCallFacts.put(newId, facts);
                    }
                }
            }
        }
    }

    // ── overload-aware CALLS resolution ladder ───────────────────────

    /** Arity compatibility: varargs accept any count >= required. */
    public static boolean arityMatches(Map<String, Object> candidate, int argCount) {
        List<String> params = paramsOf(candidate);
        int total = params.size();
        boolean hasVarargs = false;
        for (String p : params) {
            if (paramTypeOf(p).startsWith("...")) {
                hasVarargs = true;
            }
        }
        int required = hasVarargs ? total - 1 : total;
        return argCount >= required && (hasVarargs || argCount <= total);
    }

    /** Loose arg-type agreement: exact or containment, unknown never matches. */
    public static boolean typeAgrees(String argType, String paramType) {
        if (argType == null || argType.isEmpty() || "unknown".equals(argType) || paramType == null) {
            return false;
        }
        return paramType.equals(argType) || paramType.contains(argType);
    }

    public static int typeScore(Map<String, Object> candidate, List<String> argTypes) {
        List<String> params = paramsOf(candidate);
        int score = 0;
        for (int i = 0; i < argTypes.size(); i++) {
            if (i < params.size() && typeAgrees(argTypes.get(i), paramTypeOf(params.get(i)))) {
                score++;
            }
        }
        return score;
    }

    /**
     * Picks the right overload among same-name candidates of one class using
     * the call site's argument shape. Ladder (mirrors the TypeScript
     * resolveOverloadTarget):
     *   1. single candidate → "name"
     *   2. arity filter
     *   3. argTypes tiebreak (unique best score) → "signature"
     *   4. still ambiguous → first candidate → "name"
     * Empty candidates → null.
     */
    public static Pick resolveOverload(Map<String, Map<String, Object>> nodeById,
                                       List<String> candidateIds, Parser.CallInfo ci) {
        if (candidateIds == null || candidateIds.isEmpty()) {
            return null;
        }
        if (candidateIds.size() == 1) {
            return new Pick(candidateIds.get(0), "name");
        }
        int argCount = ci == null ? -1 : ci.argCount;
        List<String> pool = new ArrayList<>();
        if (ci != null && !ci.hasSpread && argCount >= 0) {
            for (String id : candidateIds) {
                Map<String, Object> node = nodeById.get(id);
                if (node == null || arityMatches(node, argCount)) {
                    pool.add(id);
                }
            }
            if (pool.isEmpty()) {
                pool.addAll(candidateIds);
            }
            if (pool.size() == 1) {
                return new Pick(pool.get(0), "arity");
            }
            List<String> argTypes = ci.argTypes == null ? new ArrayList<>() : ci.argTypes;
            boolean anyTyped = false;
            for (String t : argTypes) {
                if (t != null && !t.isEmpty() && !"unknown".equals(t)) {
                    anyTyped = true;
                    break;
                }
            }
            if (anyTyped) {
                String best = pool.get(0);
                int bestScore = typeScore(nodeById.get(best), argTypes);
                int ties = 1;
                for (int i = 1; i < pool.size(); i++) {
                    int s = typeScore(nodeById.get(pool.get(i)), argTypes);
                    if (s > bestScore) {
                        best = pool.get(i);
                        bestScore = s;
                        ties = 1;
                    } else if (s == bestScore) {
                        ties++;
                    }
                }
                if (bestScore > 0 && ties == 1) {
                    return new Pick(best, "signature");
                }
            }
        }
        return new Pick(pool.isEmpty() ? candidateIds.get(0) : pool.get(0), "name");
    }

    /** Resolved overload target + the confidence tier that picked it. */
    public static final class Pick {
        public final String id;
        public final String matchedBy;

        public Pick(String id, String matchedBy) {
            this.id = id;
            this.matchedBy = matchedBy;
        }
    }
}

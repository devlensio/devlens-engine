package devlens.extractor.edges;

import devlens.extractor.Contract;
import devlens.extractor.LookupMaps;
import devlens.extractor.Parser;
import devlens.extractor.ThirdParty;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * CALLS edge resolution (mirrors edges/calls.py — the resolution ladder).
 *
 * Per call fact, in order:
 *   1. Symbol-solver target (recorded at parse time): project source hit →
 *      exact METHOD edge; JDK hit → skip (builtin tier).
 *   2. Name-based fallback (unresolved calls):
 *      a. this./plain → same-class method
 *      b. receiver is a FIELD of the owning class → field type → class node
 *         → method lookup (also params, step c)
 *      c. receiver is a PARAM → param type → class → method
 *      d. receiver alias in the file's symbolMap → [mvn] member node (chain
 *         rule: named-import root returns the alias itself) or local class
 *      e. local variables / dynamic → unresolvable (documented parity tier)
 * Everything unresolved stays in metadata.calls (string form) — never lost.
 */
public final class Calls {

    private Calls() {}

    public static void resolve(LookupMaps lookup, List<Map<String, Object>> edgesOut) {
        for (Map.Entry<String, List<Parser.CallInfo>> entry : lookup.methodCallFacts.entrySet()) {
            String methodNodeId = entry.getKey();
            Map<String, Object> methodNode = lookup.nodeById.get(methodNodeId);
            if (methodNode == null) {
                continue;
            }
            Map<String, Object> metadata = (Map<String, Object>) methodNode.get("metadata");
            String relPath = (String) methodNode.get("filePath");
            String parentClass = (String) metadata.get("parentClass");
            String pkg = packageOf(methodNodeId, relPath);
            List<String> resolvedCalls = new ArrayList<>();
            List<Map<String, String>> resolvedDetails = new ArrayList<>();

            for (Parser.CallInfo ci : entry.getValue()) {
                String target = resolveOne(ci, lookup, relPath, parentClass, pkg, methodNodeId);
                if (target != null) {
                    Map<String, Object> edge = Contract.edge("CALLS", methodNodeId, target,
                            Map.of("line", ci.line));
                    edgesOut.add(edge);
                    resolvedCalls.add(target);
                    // details for OrmEdges (repo R/W classification)
                    Map<String, String> detail = new LinkedHashMap<>();
                    detail.put("target", target);
                    detail.put("method", ci.methodName);
                    detail.put("class", classNodeOf(target));
                    resolvedDetails.add(detail);
                }
            }
            if (!resolvedCalls.isEmpty()) {
                java.util.Collections.sort(resolvedCalls);
                metadata.put("resolvedCalls", resolvedCalls);
                metadata.put("resolvedCallDetails", resolvedDetails);
            }
        }
    }

    private static String resolveOne(Parser.CallInfo ci, LookupMaps lookup,
                                     String relPath, String parentClass,
                                     String pkg, String methodNodeId) {
        // 1. symbol-solver target
        if (ci.resolvedTarget != null) {
            int lastDot = ci.resolvedTarget.lastIndexOf('.');
            String classFqcn = ci.resolvedTarget.substring(0, lastDot);
            String method = ci.resolvedTarget.substring(lastDot + 1);
            if (ThirdParty.isJdk(classFqcn)) {
                return null;   // builtin tier
            }
            String rel = lookup.typeMap.get(classFqcn);
            if (rel != null) {
                String dotted = lookup.typeDottedMap.get(classFqcn);
                String classId = rel + "::" + dotted;
                String methodId = classId + "." + method;
                if (lookup.nodeById.containsKey(methodId)) {
                    return methodId;
                }
                // constructor call resolved via class — no method node for <init> chains
                return null;
            }
            // external (no jars on classpath in V1) → fall through to name-based
        }

        String receiver = ci.receiverName;
        // 2a. this./plain call → same-class method
        if (receiver == null || "this".equals(receiver) || "super".equals(receiver)) {
            return sameClassMethod(methodNodeId, parentClass, ci.methodName, lookup);
        }
        // 2d. alias in symbolMap (imported type or third-party member)
        String aliasTarget = lookup.symbolMap(relPath).get(receiver);
        if (aliasTarget != null) {
            if (aliasTarget.startsWith("[mvn]")) {
                return aliasTarget;   // chain rule: named-import root → alias itself
            }
            String methodId = aliasTarget + "." + ci.methodName;
            if (lookup.nodeById.containsKey(methodId)) {
                return methodId;
            }
            return null;
        }
        // 2b/2c. receiver is a field or param of the owning method's class
        String receiverType = fieldOrParamType(methodNodeId, lookup, receiver);
        if (receiverType != null && !receiverType.isEmpty()) {
            String classId = resolveTypeRef(receiverType, lookup, relPath, pkg);
            if (classId != null) {
                if (classId.startsWith("[mvn]")) {
                    return classId;
                }
                String methodId = classId + "." + ci.methodName;
                if (lookup.nodeById.containsKey(methodId)) {
                    return methodId;
                }
                // Spring Data repos inherit findAll/save/findById/... — not
                // declared in the source file. Edge to the repo interface
                // itself (OrmEdges turns these into R/W edges by method name).
                Map<String, Object> classNode = lookup.nodeById.get(classId);
                if (classNode != null) {
                    Map<String, Object> cm = (Map<String, Object>) classNode.get("metadata");
                    if (Boolean.TRUE.equals(cm.get("isRepository"))) {
                        return classId;
                    }
                }
                return null;
            }
        }
        // 2e. local vars / dynamic → unresolvable
        return null;
    }

    /** Method on the SAME class (or inherited — same file). */
    private static String sameClassMethod(String methodNodeId, String parentClass,
                                          String methodName, LookupMaps lookup) {
        int colon = methodNodeId.lastIndexOf("::");
        String prefix = colon < 0 ? methodNodeId : methodNodeId.substring(0, colon);
        String id = prefix + "::" + parentClass + "." + methodName;
        if (lookup.nodeById.containsKey(id)) {
            return id;
        }
        return null;
    }

    /**
     * Field or param type of the method's owning class. Scans the owning
     * CLASS node's metadata.fields + this method's metadata.params.
     */
    private static String fieldOrParamType(String methodNodeId, LookupMaps lookup, String receiver) {
        if (receiver == null) {
            return null;
        }
        Map<String, Object> methodNode = lookup.nodeById.get(methodNodeId);
        if (methodNode == null) {
            return null;
        }
        Map<String, Object> mmeta = (Map<String, Object>) methodNode.get("metadata");
        // params: ["Type name", ...]
        @SuppressWarnings("unchecked")
        List<String> params = (List<String>) mmeta.get("params");
        if (params != null) {
            for (String p : params) {
                int sp = p.indexOf(' ');
                String pname = sp < 0 ? p : p.substring(sp + 1).trim();
                if (pname.equals(receiver)) {
                    return Parser.simpleTypeName(p);
                }
            }
        }
        String parentClass = (String) mmeta.get("parentClass");
        String relPath = (String) methodNode.get("filePath");
        Map<String, String> byFile = lookup.nodesByFile.get(relPath);
        if (byFile == null) {
            return null;
        }
        String classId = byFile.get(parentClass);
        if (classId == null) {
            return null;
        }
        Map<String, Object> classNode = lookup.nodeById.get(classId);
        if (classNode == null) {
            return null;
        }
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields =
                (List<Map<String, Object>>) ((Map<String, Object>) classNode.get("metadata")).get("fields");
        if (fields != null) {
            for (Map<String, Object> f : fields) {
                if (receiver.equals(f.get("name"))) {
                    return (String) f.get("type");
                }
            }
        }
        return null;
    }

    /**
     * Resolve a simple type name to a node id: symbolMap first, then
     * same-package FQCN, then closest-by-name across the project.
     */
    public static String resolveTypeRef(String simpleName, LookupMaps lookup,
                                        String callerRelPath, String callerPkg) {
        if (simpleName == null || simpleName.isEmpty()) {
            return null;
        }
        String alias = lookup.symbolMap(callerRelPath).get(simpleName);
        if (alias != null) {
            return alias;
        }
        if (callerPkg != null && !callerPkg.isEmpty()) {
            String fqcn = callerPkg + "." + simpleName;
            String rel = lookup.typeMap.get(fqcn);
            if (rel != null) {
                return rel + "::" + lookup.typeDottedMap.get(fqcn);
            }
        }
        String closest = lookup.closestByName(simpleName, callerRelPath);
        if (closest == null) {
            return null;
        }
        if (closest.startsWith("[mvn]")) {
            return closest;
        }
        Map<String, Object> node = lookup.nodeById.get(closest);
        if (node == null) {
            return null;
        }
        String type = (String) node.get("type");
        return ("CLASS".equals(type) || "INTERFACE".equals(type) || "ENUM".equals(type))
                ? closest : null;
    }

    /** Package of the file containing a node id. */
    private static String packageOf(String nodeId, String relPath) {
        // derive from the file path minus src/main/java|src/test/java prefix
        String p = relPath;
        for (String root : new String[]{"src/main/java/", "src/test/java/"}) {
            if (p.startsWith(root)) {
                p = p.substring(root.length());
                break;
            }
        }
        if (p.endsWith(".java")) {
            p = p.substring(0, p.length() - 5);
        }
        return p.replace('/', '.');
    }

    /** Class node id for a method node id (strip the trailing .method). */
    private static String classNodeOf(String methodId) {
        int lastDot = methodId.lastIndexOf('.');
        int colon = methodId.lastIndexOf("::");
        if (lastDot > colon && colon >= 0) {
            return methodId.substring(0, lastDot);
        }
        return methodId;
    }
}

package devlens.extractor.edges;

import devlens.extractor.Contract;
import devlens.extractor.LookupMaps;
import devlens.extractor.Parser;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * JPA data layer (mirrors edges/orm_edges.py — highest fidelity of all
 * languages per the playbook).
 *
 * Models:    @Entity/@Table/@MappedSuperclass/@Embeddable → isModel
 *            (type "jpa"); @Document → "mongodb". fields[] from the class.
 * Repos:     interface extends JpaRepository<Entity, ID> etc → isRepository
 *            + linkedModel = the entity generic arg (via rawCode regex).
 * R/W edges: consumer → store, same direction as stateEdges.ts —
 *   - repo's own derived methods (findByX, save, deleteByX) → R/W to entity
 *   - calls INTO repo methods (from services/controllers) → R/W to entity
 *   method-name grammar classifies: find|get|query|read|count|exists|select
 *   = READ; save|insert|update|delete|remove|persist = WRITE.
 */
public final class OrmEdges {

    private static final List<String> MODEL_ANNOTATIONS =
            List.of("Entity", "Table", "MappedSuperclass", "Embeddable");
    private static final List<String> REPO_TYPES = List.of(
            "JpaRepository", "CrudRepository", "PagingAndSortingRepository",
            "ListCrudRepository", "ListPagingAndSortingRepository",
            "JpaSpecificationExecutor", "QuerydslPredicateExecutor",
            "MongoRepository", "ReactiveCrudRepository", "R2dbcRepository",
            "JdbcRepository", "ReactiveMongoRepository",
            "Repository");   // Spring Data's base marker interface

    private static final Pattern GENERIC_ARG =
            Pattern.compile("extends\\s+[A-Za-z_][\\w.]*\\s*<\\s*([A-Za-z_][\\w.]*)");

    private OrmEdges() {}

    /**
     * Detection pass — MUST run BEFORE Calls.resolve: model metadata
     * (isModel/modelType/fields) + repository detection (isRepository,
     * linkedModel) + derived-method R/W edges on repo interfaces.
     */
    public static void detect(LookupMaps lookup, List<Map<String, Object>> edgesOut) {
        // ── 1. model metadata ─────────────────────────────────────────────
        for (Map<String, Object> node : lookup.nodeById.values()) {
            if (!"CLASS".equals(node.get("type"))) {
                continue;
            }
            Map<String, Object> meta = (Map<String, Object>) node.get("metadata");
            @SuppressWarnings("unchecked")
            List<String> annotations = (List<String>) meta.get("annotations");
            if (annotations == null) {
                continue;
            }
            boolean isEntity = annotations.stream().anyMatch(MODEL_ANNOTATIONS::contains);
            boolean isDocument = annotations.contains("Document");
            if (isEntity || isDocument) {
                meta.put("isModel", true);
                meta.put("modelType", isDocument ? "mongodb" : "jpa");
                // fields[] already on metadata from node build — expose explicitly
                meta.putIfAbsent("fields", meta.get("fields") == null
                        ? new ArrayList<Map<String, Object>>() : meta.get("fields"));
            }
        }

        // ── 2. repository detection + derived-method R/W edges ────────────
        for (Map<String, Object> node : lookup.nodeById.values()) {
            String type = (String) node.get("type");
            if (!"INTERFACE".equals(type)) {
                continue;
            }
            Map<String, Object> meta = (Map<String, Object>) node.get("metadata");
            String ext = (String) meta.get("extendsType");
            if (ext == null || REPO_TYPES.stream().noneMatch(ext::equals)) {
                continue;
            }
            meta.put("isRepository", true);
            String entityId = entityGenericArg(node, lookup);
            if (entityId != null) {
                meta.put("linkedModel", entityId);
                // derived query methods on the repo itself
                for (Map<String, Object> m : lookup.nodeById.values()) {
                    if (node.get("id").equals(parentClassId(m))) {
                        String methodName = (String) m.get("name");
                        String edgeType = readOrWrite(methodName);
                        if (edgeType != null) {
                            edgesOut.add(Contract.edge(edgeType, (String) node.get("id"), entityId,
                                    Map.of("via", "repository-derived")));
                        }
                    }
                }
            }
        }
    }

    /**
     * Consumer pass — AFTER Calls.resolve: calls into repo methods become
     * READS_FROM/WRITES_TO edges from the calling class to the entity.
     */
    public static void consumerEdges(LookupMaps lookup, List<Map<String, Object>> edgesOut) {
        for (Map.Entry<String, List<Parser.CallInfo>> entry : lookup.methodCallFacts.entrySet()) {
            Map<String, Object> methodNode = lookup.nodeById.get(entry.getKey());
            if (methodNode == null) {
                continue;
            }
            @SuppressWarnings("unchecked")
            List<Map<String, String>> details =
                    (List<Map<String, String>>) ((Map<String, Object>) methodNode.get("metadata"))
                            .get("resolvedCallDetails");
            if (details == null) {
                continue;
            }
            String ownerClassId = ownerClassId(methodNode);
            for (Map<String, String> d : details) {
                String targetClass = d.get("class");
                Map<String, Object> targetNode = lookup.nodeById.get(targetClass);
                if (targetNode == null) {
                    continue;
                }
                Map<String, Object> tmeta = (Map<String, Object>) targetNode.get("metadata");
                if (!Boolean.TRUE.equals(tmeta.get("isRepository"))) {
                    continue;
                }
                String entityId = (String) tmeta.get("linkedModel");
                if (entityId == null) {
                    continue;
                }
                String edgeType = readOrWrite(d.get("method"));
                if (edgeType != null) {
                    edgesOut.add(Contract.edge(edgeType, ownerClassId, entityId,
                            Map.of("via", "repository-call")));
                }
            }
        }
    }

    /** First generic arg of the extends clause: JpaRepository<User, Long> → User. */
    private static String entityGenericArg(Map<String, Object> repoNode, LookupMaps lookup) {
        String rawCode = (String) repoNode.get("rawCode");
        if (rawCode == null) {
            return null;
        }
        Matcher m = GENERIC_ARG.matcher(rawCode);
        if (!m.find()) {
            return null;
        }
        String entitySimple = Parser.simpleTypeName(m.group(1));
        String relPath = (String) repoNode.get("filePath");
        String pkg = packageOf(relPath);
        return Calls.resolveTypeRef(entitySimple, lookup, relPath, pkg);
    }

    private static String readOrWrite(String methodName) {
        if (methodName == null) {
            return null;
        }
        // method node names are "Class.method" — classify on the method part
        String n = methodName.contains(".")
                ? methodName.substring(methodName.lastIndexOf('.') + 1) : methodName;
        n = n.toLowerCase();
        if (n.startsWith("find") || n.startsWith("get") || n.startsWith("query")
                || n.startsWith("read") || n.startsWith("count") || n.startsWith("exists")
                || n.startsWith("select") || n.startsWith("search")) {
            return "READS_FROM";
        }
        if (n.startsWith("save") || n.startsWith("insert") || n.startsWith("update")
                || n.startsWith("delete") || n.startsWith("remove") || n.startsWith("persist")
                || n.startsWith("merge") || n.startsWith("flush")) {
            return "WRITES_TO";
        }
        return null;
    }

    private static String parentClassId(Map<String, Object> methodNode) {
        if (!"METHOD".equals(methodNode.get("type"))) {
            return null;
        }
        String id = (String) methodNode.get("id");
        int lastDot = id.lastIndexOf('.');
        int colon = id.lastIndexOf("::");
        return lastDot > colon ? id.substring(0, lastDot) : id;
    }

    private static String ownerClassId(Map<String, Object> methodNode) {
        String id = parentClassId(methodNode);
        return id == null ? (String) methodNode.get("id") : id;
    }

    private static String packageOf(String relPath) {
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
}

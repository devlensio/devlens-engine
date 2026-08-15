package devlens.extractor;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Contract — the exact JSON shape DevLens Engine expects (mirrors
 * contract.py from the Python extractor). Every key here is camelCase to
 * match the TypeScript interfaces (CodeNode / CodeEdge / BackendRouteNode).
 * This class is the single source of truth for node/edge shapes; other
 * modules never spell keys by hand.
 */
public final class Contract {

    private Contract() {}

    /** SHA-256 of the raw code, first 16 hex chars (mirrors contract.py). */
    public static String codeHash(String rawCode) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(rawCode.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(16);
            for (int i = 0; i < 8; i++) {
                sb.append(String.format("%02x", digest[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** FILE / TEST node — id format: file::rel/path/File.java. */
    public static Map<String, Object> fileNode(String relPath, int endLine,
                                               String nodeType, String language) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("nodeCount", 0);
        metadata.put("childNodeIds", new ArrayList<String>());
        metadata.put("language", language);

        Map<String, Object> node = new LinkedHashMap<>();
        node.put("id", "file::" + relPath);
        node.put("name", relPath.substring(relPath.lastIndexOf('/') + 1));
        node.put("type", nodeType);
        node.put("filePath", relPath);
        node.put("startLine", 1);
        node.put("endLine", endLine);
        node.put("parentFile", "file::" + relPath);
        node.put("metadata", metadata);
        return node;
    }

    /**
     * CLASS / INTERFACE / ENUM / METHOD node — id format:
     * rel/path/File.java::TypeName or rel/path/File.java::Type.method
     */
    public static Map<String, Object> codeNode(String relPath, String name, String nodeType,
                                               int startLine, int endLine, String rawCode,
                                               Map<String, Object> metadata, String language) {
        Map<String, Object> node = new LinkedHashMap<>();
        node.put("id", relPath + "::" + name);
        node.put("name", name);
        node.put("type", nodeType);
        node.put("filePath", relPath);
        node.put("startLine", startLine);
        node.put("endLine", endLine);
        node.put("rawCode", rawCode);
        node.put("codeHash", codeHash(rawCode));
        node.put("parentFile", "file::" + relPath);

        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("language", language);
        if (metadata != null) {
            meta.putAll(metadata);
        }
        node.put("metadata", meta);
        return node;
    }

    /** THIRD_PARTY node — id format: [mvn]/prefix or [mvn]/prefix::Member. */
    public static Map<String, Object> thirdPartyNode(String id, String name,
                                                     Map<String, Object> metadata) {
        Map<String, Object> node = new LinkedHashMap<>();
        node.put("id", id);
        node.put("name", name);
        node.put("type", "THIRD_PARTY");
        node.put("filePath", id);
        node.put("startLine", 0);
        node.put("endLine", 0);
        node.put("metadata", metadata == null ? new LinkedHashMap<String, Object>() : metadata);
        return node;
    }

    /** ROUTE code node — id format: rel::METHOD /path (mirrors python common.py). */
    public static Map<String, Object> routeNode(String relPath, String httpMethod,
                                                String urlPath, boolean isDynamic,
                                                List<String> params, String framework,
                                                String handlerName) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("urlPath", urlPath);
        metadata.put("httpMethod", httpMethod);
        metadata.put("isDynamic", isDynamic);
        metadata.put("params", params == null ? new ArrayList<String>() : params);
        metadata.put("framework", framework);
        metadata.put("handlerName", handlerName);
        metadata.put("routeKind", "backend");

        Map<String, Object> node = new LinkedHashMap<>();
        node.put("id", relPath + "::" + httpMethod + " " + urlPath);
        node.put("name", httpMethod + " " + urlPath);
        node.put("type", "ROUTE");
        node.put("filePath", relPath);
        node.put("startLine", 0);
        node.put("endLine", 0);
        node.put("parentFile", "file::" + relPath);
        node.put("metadata", metadata);
        return node;
    }

    /** BackendRouteNode dict for the `routes` array (engine BackendRouteNode). */
    public static Map<String, Object> backendRoute(String urlPath, String filePath,
                                                   String httpMethod, String framework,
                                                   boolean isDynamic, List<String> params,
                                                   String handlerName, String nodeId) {
        Map<String, Object> route = new LinkedHashMap<>();
        route.put("type", "BACKEND_ROUTE");
        route.put("urlPath", urlPath);
        route.put("filePath", filePath);
        route.put("httpMethod", httpMethod);
        route.put("framework", framework);
        route.put("isDynamic", isDynamic);
        if (params != null && !params.isEmpty()) {
            route.put("params", params);
        }
        if (handlerName != null) {
            route.put("handlerName", handlerName);
        }
        if (nodeId != null) {
            route.put("nodeId", nodeId);
        }
        return route;
    }

    /** Edge — {type, from, to, metadata?} (engine CodeEdge). */
    public static Map<String, Object> edge(String type, String from, String to,
                                           Map<String, Object> metadata) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("type", type);
        e.put("from", from);
        e.put("to", to);
        if (metadata != null && !metadata.isEmpty()) {
            e.put("metadata", metadata);
        }
        return e;
    }

    /** Deterministic edge-key for dedupe: from|type|to. */
    public static String edgeKey(Map<String, Object> edge) {
        return edge.get("from") + "|" + edge.get("type") + "|" + edge.get("to");
    }

    public static Map<String, Object> error(String file, String message) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("file", file);
        err.put("error", message);
        return err;
    }
}

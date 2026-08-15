package devlens.extractor.edges;

import devlens.extractor.LookupMaps;

import java.util.List;
import java.util.Map;

/**
 * Semantic metadata enrichment (mirrors edges/enrich.py).
 *
 * Pure metadata — cheap annotation scans on already-collected facts (no AST
 * re-walks, so the Python "memo isolation" pitfall does not apply here:
 * every scan reads a fresh copy of node metadata).
 */
public final class Enrich {

    private Enrich() {}

    public static void enrich(LookupMaps lookup) {
        for (Map<String, Object> node : lookup.nodeById.values()) {
            String type = (String) node.get("type");
            Map<String, Object> meta = (Map<String, Object>) node.get("metadata");
            if (meta == null) {
                continue;
            }
            @SuppressWarnings("unchecked")
            List<String> annotations = (List<String>) meta.get("annotations");
            if (annotations == null) {
                annotations = List.of();
            }

            if ("CLASS".equals(type)) {
                if (annotations.contains("RestController") || annotations.contains("Controller")) {
                    meta.put("isController", true);
                }
                if (annotations.contains("Service")) {
                    meta.put("isService", true);
                }
                if (annotations.contains("Configuration") || annotations.contains("SpringBootApplication")) {
                    meta.put("isConfig", true);
                }
                if (annotations.contains("Component")) {
                    meta.put("isComponent", true);
                }
                if ("record".equals(meta.get("kind"))) {
                    meta.put("isSchema", true);   // records are DTO/value conventions
                }
                if (annotations.contains("RestControllerAdvice") || annotations.contains("ControllerAdvice")) {
                    meta.put("isExceptionHandler", true);
                }
            }
        }
    }
}

package devlens.extractor.edges;

import devlens.extractor.Contract;
import devlens.extractor.LookupMaps;
import devlens.extractor.Parser;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Spring MVC route detection (mirrors edges/routes/*.py).
 *
 * Annotation-driven — no type resolution needed:
 *   class-level  @RestController / @Controller (+ @RequestMapping base path)
 *   method-level @GetMapping/@PostMapping/@PutMapping/@DeleteMapping/
 *                @PatchMapping/@RequestMapping(method = RequestMethod.X)
 * Class prefix + method path compose; {id} path params → isDynamic + params.
 *
 * V1 scope: Spring MVC only. JAX-RS (@Path), @FeignClient, WebFlux
 * functional routes are V2 (documented in java_graph_detection.html).
 */
public final class Routes {

    private static final Pattern PATH_PARAM = Pattern.compile("\\{([^}]+)\\}");

    private static final List<String> MAPPING_ANNOTATIONS = List.of(
            "RequestMapping", "GetMapping", "PostMapping", "PutMapping",
            "DeleteMapping", "PatchMapping");

    private Routes() {}

    public static final class RouteResult {
        public final List<Map<String, Object>> routes = new ArrayList<>();
        public final List<Map<String, Object>> routeNodes = new ArrayList<>();
        public final List<Map<String, Object>> handlesEdges = new ArrayList<>();
        final Set<String> seen = new HashSet<>();
    }

    public static RouteResult resolve(List<Parser.ParsedFile> files, LookupMaps lookup,
                                      String framework) {
        RouteResult result = new RouteResult();
        String fw = framework == null || framework.equals("unknown") ? "spring" : framework;
        for (Parser.ParsedFile pf : files) {
            if (pf.isTest) {
                continue;
            }
            for (Parser.TypeInfo t : pf.allTypes()) {
                if (!isController(t)) {
                    continue;
                }
                String base = pathValue(t.annotationValues.get("RequestMapping"));
                for (Parser.MethodInfo m : t.methods) {
                    for (String ann : MAPPING_ANNOTATIONS) {
                        if (!m.annotations.contains(ann)) {
                            continue;
                        }
                        String methodPath = pathValue(m.annotationValues.get(ann));
                        String verb = verbFor(ann, m.annotationValues.get(ann + ".method"));
                        String urlPath = join(base, methodPath);
                        emit(pf, t, m, verb, urlPath, fw, result);
                    }
                }
            }
        }
        return result;
    }

    private static boolean isController(Parser.TypeInfo t) {
        return t.annotations.contains("RestController") || t.annotations.contains("Controller");
    }

    private static String verbFor(String ann, String methodAttr) {
        if (!ann.equals("RequestMapping")) {
            return ann.replace("Mapping", "").toUpperCase();
        }
        return methodAttr == null ? "ANY" : methodAttr.toUpperCase();
    }

    private static String pathValue(String raw) {
        return raw == null ? "" : raw.trim();
    }

    private static String join(String base, String methodPath) {
        String b = base == null ? "" : base;
        String m = methodPath == null ? "" : methodPath;
        if (b.isEmpty()) {
            return m.isEmpty() ? "/" : normalize(m);
        }
        if (m.isEmpty()) {
            return normalize(b);
        }
        if (m.startsWith("/")) {
            m = m.substring(1);
        }
        return normalize(b + "/" + m);
    }

    private static String normalize(String p) {
        String out = p;
        if (!out.startsWith("/")) {
            out = "/" + out;
        }
        while (out.endsWith("/") && out.length() > 1) {
            out = out.substring(0, out.length() - 1);
        }
        return out;
    }

    private static void emit(Parser.ParsedFile pf, Parser.TypeInfo t, Parser.MethodInfo m,
                             String verb, String urlPath, String fw, RouteResult result) {
        String key = pf.relPath + "|" + verb + "|" + urlPath;
        if (!result.seen.add(key)) {
            return;
        }
        Matcher matcher = PATH_PARAM.matcher(urlPath);
        boolean dynamic = matcher.find();
        List<String> params = new ArrayList<>();
        matcher.reset();
        while (matcher.find()) {
            params.add(matcher.group(1));
        }

        String handlerId = pf.relPath + "::" + t.dottedName + "." + m.name;
        Map<String, Object> routeNode = Contract.routeNode(pf.relPath, verb, urlPath,
                dynamic, params, fw, m.name);
        Map<String, Object> backendRoute = Contract.backendRoute(urlPath, pf.relPath,
                verb, fw, dynamic, params, m.name, (String) routeNode.get("id"));

        result.routeNodes.add(routeNode);
        result.routes.add(backendRoute);
        Map<String, Object> handlesMeta = new LinkedHashMap<>();
        handlesMeta.put("urlPath", urlPath);
        handlesMeta.put("httpMethod", verb);
        handlesMeta.put("routeKind", "backend");
        result.handlesEdges.add(Contract.edge("HANDLES", (String) routeNode.get("id"), handlerId, handlesMeta));
    }
}

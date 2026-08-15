package devlens.extractor.edges;

import devlens.extractor.Contract;
import devlens.extractor.LookupMaps;
import devlens.extractor.Parser;
import devlens.extractor.ThirdParty;

import java.util.List;
import java.util.Map;

/**
 * EXTENDS / IMPLEMENTS edge resolution (mirrors edges/inheritance.py).
 *
 * Java is the EASIEST of all languages here — explicit keywords, zero
 * heuristics:
 *   extends Baz   → EXTENDS   (always)
 *   implements A, B → IMPLEMENTS (always; interfaces extending interfaces
 *                     also use extends → EXTENDS)
 *
 * Targets resolve via symbol maps → same-package → closest-by-name. Local
 * bases become class edges; gated third-party bases become [mvn] edges;
 * unresolved bases are skipped — NEVER a dangling edge.
 */
public final class Inheritance {

    private Inheritance() {}

    public static void resolve(List<Parser.ParsedFile> files, LookupMaps lookup,
                               ThirdParty tp, List<Map<String, Object>> edgesOut) {
        for (Parser.ParsedFile pf : files) {
            if (pf.isTest) {
                continue;
            }
            String pkg = pf.packageName;
            for (Parser.TypeInfo t : pf.allTypes()) {
                String nodeId = pf.relPath + "::" + t.dottedName;
                if (t.extendedType != null && !t.extendedType.isEmpty()) {
                    String target = resolveBase(t.extendedType, pf, lookup, tp);
                    if (target != null) {
                        edgesOut.add(Contract.edge("EXTENDS", nodeId, target, null));
                    }
                }
                for (String impl : t.implementedTypes) {
                    String target = resolveBase(impl, pf, lookup, tp);
                    if (target != null) {
                        edgesOut.add(Contract.edge("IMPLEMENTS", nodeId, target, null));
                    }
                }
            }
        }
    }

    private static String resolveBase(String simpleName, Parser.ParsedFile pf,
                                      LookupMaps lookup, ThirdParty tp) {
        String alias = lookup.symbolMap(pf.relPath).get(simpleName);
        if (alias != null) {
            // [mvn] aliases only exist when gated in (Imports checked `permitted`)
            return alias;
        }
        if (!pf.packageName.isEmpty()) {
            String fqcn = pf.packageName + "." + simpleName;
            String rel = lookup.typeMap.get(fqcn);
            if (rel != null) {
                return rel + "::" + lookup.typeDottedMap.get(fqcn);
            }
        }
        String closest = lookup.closestByName(simpleName, pf.relPath);
        if (closest != null) {
            Map<String, Object> node = lookup.nodeById.get(closest);
            if (node != null) {
                String type = (String) node.get("type");
                if ("CLASS".equals(type) || "INTERFACE".equals(type) || "ENUM".equals(type)) {
                    return closest;
                }
            }
        }
        return null;   // external/unresolved — skip, never dangling
    }
}

package devlens.extractor.edges;

import devlens.extractor.Contract;
import devlens.extractor.LookupMaps;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * TESTS edge resolution (mirrors edges/tests.py + JS testEdges).
 *
 * Test files are LEAF nodes — the parser still extracted their test methods
 * (names land in metadata.testCases), but no test children enter the graph.
 * TESTS edges point from the TEST file node → the production CLASS nodes it
 * imports (symbol maps are the bridge — test files import production types).
 */
public final class Tests {

    private Tests() {}

    public static void resolve(LookupMaps lookup, List<Map<String, Object>> edgesOut) {
        for (Map.Entry<String, Map<String, Object>> entry : lookup.fileNodesByPath.entrySet()) {
            Map<String, Object> fileNode = entry.getValue();
            if (!"TEST".equals(fileNode.get("type"))) {
                continue;
            }
            String relPath = entry.getKey();
            // metadata.testCases = @Test methods extracted at parse time
            List<String> cases = lookup.testCases.get(relPath);
            if (cases != null && !cases.isEmpty()) {
                ((Map<String, Object>) fileNode.get("metadata")).put("testCases", cases);
            }
            // production symbols this test file imports
            Map<String, String> sm = lookup.symbolMap(relPath);
            List<String> targets = new ArrayList<>(sm.values());
            java.util.Collections.sort(targets);
            for (String target : targets) {
                if (target.startsWith("[mvn]")) {
                    continue;   // don't test third-party libs
                }
                Map<String, Object> node = lookup.nodeById.get(target);
                if (node == null) {
                    continue;
                }
                String type = (String) node.get("type");
                if ("CLASS".equals(type) || "INTERFACE".equals(type) || "ENUM".equals(type)) {
                    edgesOut.add(Contract.edge("TESTS", "file::" + relPath, target, null));
                }
            }
        }
    }
}

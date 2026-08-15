package devlens.extractor;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * ThirdParty — [mvn]/&lt;package-prefix&gt; node registry (mirrors third_party.py).
 *
 * Node key form: first TWO segments of the import package — e.g. import
 * org.springframework.web.bind.annotation.* → [mvn]/org.springframework.
 * Member nodes: [mvn]/org.springframework::RestTemplate for named imports.
 * This mirrors Python's [pip]/&lt;top-level-name&gt; convention: the node key is
 * the IMPORT name, not the Maven artifact (g:a). The frontend selects from
 * fingerprint.rawDependencies (g:a) — the gating normalizes both sides:
 * "org.springframework.boot:spring-boot-starter-web" → prefix
 * "org.springframework" (first two segments of the groupId).
 *
 * JDK packages are skipped entirely (stdlib tier — no node, no edge).
 * `allowed` gates everything: empty set → ZERO third-party nodes.
 */
public final class ThirdParty {

    private static final Set<String> JDK_PREFIXES = Set.of(
            "java.", "javax.", "jdk.", "sun.", "com.sun.", "org.w3c.", "org.xml.");

    private static final Set<String> RUNTIME_PREFIXES = Set.of(
            "org.springframework", "com.fasterxml.jackson", "org.hibernate",
            "jakarta.persistence", "jakarta.validation", "jakarta.servlet",
            "org.slf4j", "io.swagger", "org.apache.commons", "org.apache.http",
            "org.apache.kafka", "com.google.common", "com.google.gson",
            "org.projectlombok", "org.mapstruct", "com.querydsl", "io.micrometer",
            "org.flywaydb", "org.liquibase", "org.mybatis", "org.elasticsearch",
            "com.rabbitmq", "org.apache.activemq", "com.zaxxer", "redis.clients");

    private static final Set<String> DEVTOOL_PREFIXES = Set.of(
            "org.junit", "org.mockito", "org.assertj", "org.testng",
            "org.testcontainers", "io.rest-assured", "org.seleniumhq");

    private final Map<String, Map<String, Object>> nodes = new LinkedHashMap<>();
    private final Map<String, String> rawDependencies;
    private final Set<String> allowed = new LinkedHashSet<>();

    public ThirdParty(Map<String, String> rawDependencies, List<String> allowedSelection) {
        this.rawDependencies = rawDependencies == null ? Map.of() : rawDependencies;
        for (String sel : allowedSelection) {
            if (sel == null || sel.isBlank()) {
                continue;
            }
            if (sel.contains(":")) {
                // g:a form from rawDependencies → first two segments of groupId
                String group = sel.substring(0, sel.indexOf(':'));
                allowed.add(packagePrefix(group));
            } else {
                allowed.add(sel);
            }
        }
    }

    /** First two segments: org.springframework.boot → org.springframework */
    public static String packagePrefix(String pkg) {
        String[] parts = pkg.split("\\.");
        if (parts.length <= 2) {
            return pkg;
        }
        return parts[0] + "." + parts[1];
    }

    public static boolean isJdk(String pkg) {
        for (String p : JDK_PREFIXES) {
            if (pkg.startsWith(p)) {
                return true;
            }
        }
        return false;
    }

    public boolean permitted(String prefix) {
        return allowed.contains(prefix);
    }

    private Map<String, Object> baseMetadata(String prefix) {
        String version = rawDependencies.entrySet().stream()
                .filter(e -> packagePrefix(e.getKey().substring(0, e.getKey().indexOf(':'))).equals(prefix)
                        || e.getKey().startsWith(prefix + ":"))
                .map(Map.Entry::getValue)
                .findFirst().orElse("unknown");
        String category;
        if (RUNTIME_PREFIXES.contains(prefix)) {
            category = "runtime";
        } else if (DEVTOOL_PREFIXES.contains(prefix)) {
            category = "devtool";
        } else {
            category = "unknown";
        }
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("isThirdParty", true);
        meta.put("packageVersion", version);
        meta.put("category", category);
        return meta;
    }

    /** [mvn]/prefix node — null when the prefix is not permitted. */
    public Map<String, Object> packageNode(String prefix) {
        if (!permitted(prefix)) {
            return null;
        }
        String id = "[mvn]/" + prefix;
        if (!nodes.containsKey(id)) {
            nodes.put(id, Contract.thirdPartyNode(id, prefix, baseMetadata(prefix)));
        }
        return nodes.get(id);
    }

    /** [mvn]/prefix::Member — null when not permitted. */
    public Map<String, Object> methodNode(String prefix, String member) {
        if (!permitted(prefix)) {
            return null;
        }
        String id = "[mvn]/" + prefix + "::" + member;
        if (!nodes.containsKey(id)) {
            Map<String, Object> pkgNode = packageNode(prefix);
            if (pkgNode == null) {
                return null;
            }
            Map<String, Object> meta = new LinkedHashMap<>(baseMetadata(prefix));
            meta.put("parentPackageId", pkgNode.get("id"));
            meta.put("methodName", member);
            nodes.put(id, Contract.thirdPartyNode(id, prefix + "." + member, meta));
        }
        return nodes.get(id);
    }

    /** All third-party nodes created so far (append AFTER edge resolution). */
    public List<Map<String, Object>> allNodes() {
        return new ArrayList<>(nodes.values());
    }
}

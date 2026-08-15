package devlens.extractor;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Fingerprint — manifest → framework / projectType / databases / rawDependencies.
 *
 * pom.xml is parsed with the JDK's secure DOM (never executed — same rule as
 * ast-parsing setup.py). build.gradle has no structured format, so it gets a
 * documented LOW-fidelity regex pass; pom wins when both exist.
 *
 * rawDependencies: g:a → version (TreeMap = deterministic output).
 */
public final class Fingerprint {

    public String language = "java";
    public String projectType = "unknown";
    public String framework = "unknown";
    public String router = "none";
    public List<String> stateManagement = new ArrayList<>();
    public List<String> dataFetching = new ArrayList<>();
    public List<String> databases = new ArrayList<>();
    public Map<String, String> rawDependencies = new TreeMap<>();

    /** Deps seen (g:a) — drives framework/database classification. */
    private final Set<String> deps = new LinkedHashSet<>();
    private boolean hasSpringBootPlugin;

    public static Fingerprint detect(Path repoPath) {
        Fingerprint fp = new Fingerprint();
        Path pom = repoPath.resolve("pom.xml");
        Path gradle = repoPath.resolve("build.gradle");
        Path gradleKts = repoPath.resolve("build.gradle.kts");
        if (Files.isRegularFile(pom)) {
            fp.parsePom(pom);
        } else if (Files.isRegularFile(gradle)) {
            fp.parseGradle(gradle);
        } else if (Files.isRegularFile(gradleKts)) {
            fp.parseGradle(gradleKts);
        }
        fp.classify();
        return fp;
    }

    // ─────────────────────────── pom.xml ───────────────────────────

    private void parsePom(Path pom) {
        try {
            String xml = Files.readString(pom, StandardCharsets.UTF_8);
            DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
            dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
            dbf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            dbf.setXIncludeAware(false);
            dbf.setExpandEntityReferences(false);
            DocumentBuilder builder = dbf.newDocumentBuilder();
            Document doc = builder.parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));

            String groupId = text(doc, "project > groupId");
            String artifactId = text(doc, "project > artifactId");
            String version = text(doc, "project > version");
            if ((groupId == null || version == null) && hasElement(doc, "project > parent")) {
                // version/groupId often live on the parent (spring-boot-starter-parent)
                if (groupId == null) groupId = text(doc, "project > parent > groupId");
                if (version == null) version = text(doc, "project > parent > version");
            }

            NodeList depNodes = doc.getElementsByTagName("dependency");
            for (int i = 0; i < depNodes.getLength(); i++) {
                Element dep = (Element) depNodes.item(i);
                String g = childText(dep, "groupId");
                String a = childText(dep, "artifactId");
                String v = childText(dep, "version");
                if (g != null && a != null) {
                    String key = g + ":" + a;
                    deps.add(key);
                    // versions are usually inherited from the parent (spring-boot-starter-parent)
                    rawDependencies.put(key, v != null && !v.isBlank() ? v : "unknown");
                }
            }

            NodeList pluginNodes = doc.getElementsByTagName("plugin");
            for (int i = 0; i < pluginNodes.getLength(); i++) {
                Element plugin = (Element) pluginNodes.item(i);
                String g = childText(plugin, "groupId");
                String a = childText(plugin, "artifactId");
                if ("org.springframework.boot".equals(g) && "spring-boot-maven-plugin".equals(a)) {
                    hasSpringBootPlugin = true;
                }
            }
        } catch (Exception e) {
            // unparseable pom → stay "unknown" (non-fatal)
        }
    }

    // ─────────────────────────── build.gradle ───────────────────────────

    private static final Pattern DEP_PATTERN = Pattern.compile(
            "(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|classpath)" +
            "\\s*\\(?\\s*['\"]([^:'\"]+):([^:'\"]+):([^'\"]+)['\"]");
    private static final Pattern PLUGIN_PATTERN = Pattern.compile(
            "id\\s*['\"]([^'\"]+)['\"]");

    private void parseGradle(Path gradle) {
        try {
            String text = Files.readString(gradle, StandardCharsets.UTF_8);
            Matcher dm = DEP_PATTERN.matcher(text);
            while (dm.find()) {
                String key = dm.group(1) + ":" + dm.group(2);
                deps.add(key);
                rawDependencies.put(key, dm.group(3));
            }
            Matcher pm = PLUGIN_PATTERN.matcher(text);
            while (pm.find()) {
                if ("org.springframework.boot".equals(pm.group(1))) {
                    hasSpringBootPlugin = true;
                }
            }
        } catch (Exception e) {
            // non-fatal
        }
    }

    // ─────────────────────────── classification ───────────────────────────

    private static final Map<String, String> DATABASE_DRIVERS = Map.ofEntries(
            Map.entry("org.postgresql:postgresql", "postgresql"),
            Map.entry("com.h2database:h2", "h2"),
            Map.entry("com.mysql:mysql-connector-j", "mysql"),
            Map.entry("mysql:mysql-connector-java", "mysql"),
            Map.entry("org.mariadb.jdbc:mariadb-java-client", "mariadb"),
            Map.entry("org.xerial:sqlite-jdbc", "sqlite"),
            Map.entry("com.microsoft.sqlserver:mssql-jdbc", "sqlserver"),
            Map.entry("org.mongodb:mongodb-driver-sync", "mongodb"),
            Map.entry("org.mongodb:mongodb-driver-core", "mongodb"));

    private void classify() {
        boolean springBoot = hasSpringBootPlugin || deps.stream().anyMatch(d -> d.startsWith("org.springframework.boot:"));
        boolean springMvc = deps.stream().anyMatch(d ->
                d.equals("org.springframework:spring-web") || d.equals("org.springframework:spring-webmvc"));
        if (springBoot) {
            framework = "spring-boot";
        } else if (springMvc) {
            framework = "spring-mvc";
        }

        boolean jpa = deps.stream().anyMatch(d ->
                d.startsWith("org.springframework.boot:spring-boot-starter-data-jpa")
                        || d.startsWith("jakarta.persistence:")
                        || d.startsWith("javax.persistence:")
                        || d.startsWith("org.hibernate.orm:")
                        || d.equals("org.hibernate:hibernate-core"));
        if (jpa) {
            databases.add("jpa");
        }
        for (Map.Entry<String, String> e : DATABASE_DRIVERS.entrySet()) {
            if (deps.contains(e.getKey()) && !databases.contains(e.getValue())) {
                databases.add(e.getValue());
            }
        }
        if (deps.stream().anyMatch(d -> d.startsWith("org.springframework.boot:spring-boot-starter-data-redis"))
                || deps.contains("redis.clients:jedis")) {
            databases.add("redis");
        }
        java.util.Collections.sort(databases);

        if (springBoot || springMvc) {
            projectType = "backend";
        } else if (!rawDependencies.isEmpty()) {
            projectType = "library";
        }
    }

    // ─────────────────────────── output ───────────────────────────

    public Map<String, Object> toDict() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("language", language);
        out.put("projectType", projectType);
        out.put("framework", framework);
        out.put("router", router);
        out.put("stateManagement", stateManagement);
        out.put("dataFetching", dataFetching);
        out.put("databases", databases);
        out.put("rawDependencies", rawDependencies);
        return out;
    }

    // ─────────────────────────── xml helpers ───────────────────────────

    private static String text(Document doc, String path) {
        Node n = doc.getDocumentElement();
        for (String part : path.split(" > ")) {
            if (!(n instanceof Element el)) return null;
            n = firstChildElement(el, part);
            if (n == null) return null;
        }
        return n.getTextContent() == null ? null : n.getTextContent().trim();
    }

    private static boolean hasElement(Document doc, String path) {
        return text(doc, path) != null;
    }

    private static Element firstChildElement(Element parent, String name) {
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node n = children.item(i);
            if (n instanceof Element e && name.equals(e.getTagName())) {
                return e;
            }
        }
        return null;
    }

    private static String childText(Element parent, String name) {
        Element e = firstChildElement(parent, name);
        return e == null ? null : (e.getTextContent() == null ? null : e.getTextContent().trim());
    }
}

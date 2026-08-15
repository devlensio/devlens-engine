package devlens.extractor;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;

/**
 * SourceWalker — finds every .java file under the repo, pruning ignore
 * directories AT THE FRONTIER (SKIP_SUBTREE before descending — the same
 * "cut branches before you walk them" pattern as Python's dirnames[:] = []).
 */
public final class SourceWalker {

    private static final Set<String> IGNORE_DIRS = Set.of(
            "target", ".git", "build", "out", "node_modules", ".gradle",
            ".idea", ".vscode", "dist", ".mvn", ".settings", "bin", "obj", ".cache");

    private SourceWalker() {}

    /** All .java files relative to repoRoot, sorted (deterministic). */
    public static List<String> walkJavaFiles(Path repoRoot) throws IOException {
        List<String> rels = new ArrayList<>();
        Files.walkFileTree(repoRoot, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(repoRoot) && IGNORE_DIRS.contains(dir.getFileName().toString())) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                if (file.getFileName().toString().endsWith(".java")) {
                    rels.add(repoRoot.relativize(file).toString().replace('\\', '/'));
                }
                return FileVisitResult.CONTINUE;
            }
        });
        Collections.sort(rels);
        return rels;
    }

    /** Test file = under src/test/ OR named *Test.java / *Tests.java / Test*.java. */
    public static boolean isTestFile(String relPath) {
        String lower = relPath.toLowerCase();
        if (lower.contains("/src/test/")) {
            return true;
        }
        String name = lower.substring(lower.lastIndexOf('/') + 1);
        return name.startsWith("test")
                || name.endsWith("test.java")
                || name.endsWith("tests.java");
    }

    /**
     * Maven-standard layout roots. Falls back to the repo root itself for
     * plain layouts (single package dir, no src/main/java).
     */
    public static List<Path> sourceRoots(Path repoRoot) {
        List<Path> roots = new ArrayList<>();
        Path main = repoRoot.resolve("src/main/java");
        Path test = repoRoot.resolve("src/test/java");
        if (Files.isDirectory(main)) {
            roots.add(main);
        }
        if (Files.isDirectory(test)) {
            roots.add(test);
        }
        if (roots.isEmpty()) {
            roots.add(repoRoot);
        }
        return roots;
    }
}

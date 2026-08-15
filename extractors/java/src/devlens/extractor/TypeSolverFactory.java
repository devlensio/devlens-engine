package devlens.extractor;

import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;

import java.nio.file.Path;

/**
 * TypeSolver setup (V1 — project sources + JDK reflection only).
 *
 * ReflectionTypeSolver resolves JDK types (java.*, javax.*). JavaParserTypeSolver
 * resolves types declared inside the analyzed repo (src/main/java + src/test/java).
 *
 * External dependency jars are deliberately NOT on the classpath in V1: Spring
 * and other third-party types stay unresolved (Optional.empty()). Edge detectors
 * degrade to name-based resolution for those — route detection is
 * annotation-driven and doesn't need type resolution at all.
 */
public final class TypeSolverFactory {

    private TypeSolverFactory() {}

    public static void configure(Path repoRoot) {
        CombinedTypeSolver combined = new CombinedTypeSolver();
        combined.add(new ReflectionTypeSolver());
        for (Path root : SourceWalker.sourceRoots(repoRoot)) {
            combined.add(new JavaParserTypeSolver(root));
        }
        // JavaParser 3.26+ removed StaticJavaParser.setSymbolSolver — the
        // resolver is configured via ParserConfiguration instead.
        // JAVA_21 level is REQUIRED: the default level (<14) makes records
        // and sealed types silently parse to EMPTY (non-fatal problem, zero
        // nodes, no error recorded) — the plain fixture caught this.
        ParserConfiguration config = new ParserConfiguration()
                .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)
                .setSymbolResolver(new JavaSymbolSolver(combined));
        StaticJavaParser.setConfiguration(config);
    }
}

package devlens.extractor;

import java.util.Map;

/**
 * Immutable container for the extractor's output + a fatal flag.
 * `fatal` is true only when the pipeline itself blew up (the engine turns
 * that into a non-zero exit); per-file parse problems go into errors[] and
 * are non-fatal by design.
 */
public record ExtractorResult(Map<String, Object> json, boolean fatal) {
}

package devlens.extractor;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Entry point — JSON over stdin/stdout contract:
 *   stdin:  {"repoPath": "/abs/path", "options": {"includedThirdPartyLibs": [...]}}
 *   stdout: {"fingerprint": ..., "nodes": [...], "edges": [...], "routes": [...],
 *            "stats": {...}, "errors": [...]}
 *
 * JSON only on stdout; anything human-readable goes to stderr. Non-zero exit
 * only on fatal errors (parse problems are collected into errors[] instead).
 */
public final class Main {

    public static void main(String[] args) {
        try {
            StringBuilder input = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    input.append(line).append('\n');
                }
            }

            JsonObject json = JsonParser.parseString(input.toString()).getAsJsonObject();
            String repoPath = json.get("repoPath").getAsString();

            // The engine's real contract key is `includeThirdPartyLibs` (no "d");
            // contract.html wrote `includedThirdPartyLibs` — accept BOTH spellings.
            List<String> allowed = new ArrayList<>();
            JsonObject options = json.has("options") && json.get("options").isJsonObject()
                    ? json.getAsJsonObject("options") : new JsonObject();
            JsonElement libs = options.has("includeThirdPartyLibs")
                    ? options.get("includeThirdPartyLibs")
                    : options.get("includedThirdPartyLibs");
            if (libs != null && libs.isJsonArray()) {
                for (JsonElement e : libs.getAsJsonArray()) {
                    allowed.add(e.getAsString());
                }
            }

            ExtractorResult result = new Extractor(repoPath, allowed).run();

            Gson gson = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
            System.out.println(gson.toJson(result.json()));
            System.exit(result.fatal() ? 1 : 0);
        } catch (Throwable t) {
            System.err.println("java extractor fatal error: " + t.getMessage());
            t.printStackTrace();
            System.exit(1);
        }
    }
}

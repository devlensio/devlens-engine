// main.rs — entry point: stdin JSON {repoPath, options} → stdout JSON
// ExtractorResult. JSON only on stdout; logs go to stderr. Mirrors
// extractors/go/main.go.

mod calls;
mod contract;
mod enrich;
mod extractor;
mod fingerprint;
mod imports;
mod inheritance;
mod lookup;
mod module_map;
mod nodes;
mod orm_edges;
mod parser;
mod routes;
mod tests;
mod thirdparty;
mod walker;

use std::io::Read;

fn main() {
    let mut raw = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut raw) {
        eprintln!("error reading stdin: {}", e);
        std::process::exit(1);
    }
    let input: contract::ExtractorInput = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("bad input json: {}", e);
            std::process::exit(1);
        }
    };
    if input.repo_path.is_empty() {
        eprintln!("repoPath is required");
        std::process::exit(1);
    }

    // Options: the engine forwards includeThirdPartyLibs (both spellings are
    // accepted: engine truth + contract.html docs alias).
    let opts = extractor::Options::from_json(&input.options);

    let result = extractor::run(&input.repo_path, &opts);

    if let Err(e) = serde_json::to_writer(std::io::stdout(), &result) {
        eprintln!("error marshaling result: {}", e);
        std::process::exit(1);
    }
    println!();
}

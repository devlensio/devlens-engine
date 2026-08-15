// main.go — entry point: stdin JSON {repoPath, options} → stdout JSON
// ExtractorResult. JSON only on stdout; logs go to stderr.

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// Input mirrors ExtractorInput from src/extractors/types.ts.
type Input struct {
	RepoPath string          `json:"repoPath"`
	Options  json.RawMessage `json:"options"`
}

// Options — the engine forwards includeThirdPartyLibs (both spellings are
// accepted: engine truth + contract.html docs alias).
type Options struct {
	IncludeThirdPartyLibs  []string `json:"includeThirdPartyLibs"`
	IncludedThirdPartyLibs []string `json:"includedThirdPartyLibs"`
}

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error reading stdin:", err)
		os.Exit(1)
	}
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		fmt.Fprintln(os.Stderr, "bad input json:", err)
		os.Exit(1)
	}
	if in.RepoPath == "" {
		fmt.Fprintln(os.Stderr, "repoPath is required")
		os.Exit(1)
	}
	var opts Options
	if len(in.Options) > 0 {
		_ = json.Unmarshal(in.Options, &opts) // malformed options → defaults, non-fatal
	}
	if len(opts.IncludeThirdPartyLibs) == 0 {
		opts.IncludeThirdPartyLibs = opts.IncludedThirdPartyLibs
	}

	result := runExtractor(in.RepoPath, &opts)

	out, err := json.Marshal(result)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error marshaling result:", err)
		os.Exit(1)
	}
	os.Stdout.Write(out)
}

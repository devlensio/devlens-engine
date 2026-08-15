// walker.go — file discovery: prune IGNORE dirs at the frontier, collect
// .go files, group them into packages (one package = one directory).

package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// IGNORE_DIRS — pruned at the frontier (never descended into). vendor/ holds
// third-party copies (go list resolves types there; we never walk it for
// nodes). bin/dist/build/out/target are build outputs.
var ignoreDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "bin": true,
	"dist": true, "build": true, "out": true, "target": true,
	"coverage": true, ".idea": true, ".vscode": true, ".cache": true,
}

// goFiles walks repoPath and returns relative paths of all .go files,
// pruned at the frontier (never descend into pruned dirs).
func goFiles(repoPath string) []string {
	var files []string
	filepath.WalkDir(repoPath, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry — skip silently
		}
		if d.IsDir() {
			base := d.Name()
			if p != repoPath && (ignoreDirs[base] || strings.HasPrefix(base, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(d.Name(), ".go") {
			rel, _ := filepath.Rel(repoPath, p)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(files)
	return files
}

// groupByDir → rel dir → []rel file paths (deterministic order).
func groupByDir(files []string) map[string][]string {
	groups := map[string][]string{}
	for _, f := range files {
		dir := "."
		if i := strings.LastIndex(f, "/"); i >= 0 {
			dir = f[:i]
		}
		groups[dir] = append(groups[dir], f)
	}
	for _, list := range groups {
		sort.Strings(list)
	}
	return groups
}

func dirExists(repoPath, rel string) bool {
	info, err := os.Stat(filepath.Join(repoPath, rel))
	return err == nil && info.IsDir()
}

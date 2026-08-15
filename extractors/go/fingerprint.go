// fingerprint.go — go.mod parsing → framework / projectType / databases /
// rawDependencies. Hand-rolled (bufio.Scanner): the binary must stay stdlib-
// only, so golang.org/x/mod/modfile is out. Never executes the manifest
// (same security rule as setup.py / pom.xml).

package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// modFile holds everything the extractor needs from go.mod.
type modFile struct {
	ModulePath string
	GoVersion  string
	Requires   map[string]string // module path → version
	Replaces   map[string]string // old module path → new module path (replace directives)
	HasMod     bool
}

// parseGoMod reads <repo>/go.mod. Missing file → empty modFile (HasMod=false),
// which the rest of the extractor treats as "not a Go module" gracefully.
func parseGoMod(repoPath string) *modFile {
	mf := &modFile{Requires: map[string]string{}, Replaces: map[string]string{}}
	f, err := os.Open(filepath.Join(repoPath, "go.mod"))
	if err != nil {
		return mf
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	inRequire := false
	for sc.Scan() {
		line := strings.TrimSpace(stripGoModComment(sc.Text()))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "require (") {
			inRequire = true
			continue
		}
		if inRequire {
			if line == ")" {
				inRequire = false
				continue
			}
			if mod, ver, ok := splitModuleVersion(line); ok {
				mf.Requires[mod] = ver
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "module "):
			mf.ModulePath = strings.TrimSpace(strings.TrimPrefix(line, "module "))
			mf.HasMod = true
		case strings.HasPrefix(line, "go "):
			mf.GoVersion = strings.TrimSpace(strings.TrimPrefix(line, "go "))
		case strings.HasPrefix(line, "require "):
			if mod, ver, ok := splitModuleVersion(strings.TrimPrefix(line, "require ")); ok {
				mf.Requires[mod] = ver
			}
		case strings.HasPrefix(line, "replace "):
			// replace old [ver] => new [ver]
			rest := strings.TrimPrefix(line, "replace ")
			if i := strings.Index(rest, "=>"); i >= 0 {
				old := strings.TrimSpace(rest[:i])
				newp := strings.TrimSpace(rest[i+2:])
				// strip versions from the old side: "old v1.2.3" → "old"
				old = strings.Fields(old)[0]
				// new side may be "mod v1.2.3" or a filesystem path
				fields := strings.Fields(newp)
				if len(fields) > 0 {
					mf.Replaces[old] = fields[0]
				}
			}
		}
	}
	return mf
}

// stripGoModComment removes // comments (not inside strings — go.mod has no
// string literals in require/module lines, so a plain cut is safe here).
func stripGoModComment(line string) string {
	if i := strings.Index(line, "//"); i >= 0 {
		return line[:i]
	}
	return line
}

// splitModuleVersion splits "mod/path v1.2.3" → (mod/path, v1.2.3).
func splitModuleVersion(s string) (string, string, bool) {
	fields := strings.Fields(s)
	if len(fields) < 2 {
		return "", "", false
	}
	return fields[0], fields[1], true
}

// ── framework / database detection (documented dep-name conventions) ──

var frameworkDeps = []struct {
	dep string
	fw  string
}{
	{"github.com/gin-gonic/gin", "gin"},
	{"github.com/labstack/echo", "echo"},
	{"github.com/gofiber/fiber", "fiber"},
}

var databaseDeps = []struct {
	prefix string
	db     string
}{
	{"gorm.io/gorm", "gorm"},
	{"github.com/jackc/pgx", "postgresql"},
	{"github.com/lib/pq", "postgresql"},
	{"github.com/go-sql-driver/mysql", "mysql"},
	{"modernc.org/sqlite", "sqlite"},
	{"github.com/mattn/go-sqlite3", "sqlite"},
	{"go.mongodb.org/mongo-driver", "mongo"},
}

// fingerprintFromMod — manifest-only detection. web-framework / database list
// derived from the require set; net-http and database/sql (both stdlib) are
// upgraded later by extractor.go once imports are known.
func fingerprintFromMod(mf *modFile) *Fingerprint {
	fp := newFingerprint()
	if !mf.HasMod {
		return fp
	}
	fp.RawDependencies = sortedCopy(mf.Requires)
	for _, fw := range frameworkDeps {
		if hasPrefixKey(mf.Requires, fw.dep) {
			fp.Framework = fw.fw
			fp.ProjectType = "backend"
			break
		}
	}
	seen := map[string]bool{}
	for _, dd := range databaseDeps {
		if hasPrefixKey(mf.Requires, dd.prefix) && !seen[dd.db] {
			fp.Databases = append(fp.Databases, dd.db)
			seen[dd.db] = true
		}
	}
	return fp
}

// hasPrefixKey — require keys can be "gorm.io/gorm" or "github.com/gofiber/fiber/v2".
func hasPrefixKey(m map[string]string, prefix string) bool {
	for k := range m {
		if k == prefix || strings.HasPrefix(k, prefix+"/") {
			return true
		}
	}
	return false
}

func sortedCopy(m map[string]string) map[string]string {
	// map ordering doesn't matter for JSON (Go marshals maps sorted), but keep
	// the helper honest.
	return m
}

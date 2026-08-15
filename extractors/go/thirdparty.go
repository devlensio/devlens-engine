// thirdparty.go — [mod]/... node creation + allowed gating.
//
// Mirrors the JS side's [npm]/... convention and python's [pip]/... registry:
// one package node per import, per-name member nodes for named access, all
// deduped in a single registry. `allowed` gates inclusion — empty set → ZERO
// third-party nodes (the engine controls this via options.includeThirdPartyLibs).

package main

import "strings"

// std packages never contain a dot in the first path element (documented
// go.dev module-path convention: external module paths always do). This is
// the same rule `go list std` encodes.
func isStdImport(path string) bool {
	first := path
	if i := strings.Index(path, "/"); i >= 0 {
		first = path[:i]
	}
	return !strings.Contains(first, ".")
}

// runtime/devtool categories (mirrors python's RUNTIME_PACKAGES/DEVTOOL_PACKAGES —
// frontend uses this for the library panel).
var runtimePkgs = []string{
	"github.com/gin-gonic/gin", "github.com/labstack/echo", "github.com/gofiber/fiber",
	"gorm.io/gorm", "github.com/jackc/pgx", "github.com/lib/pq",
	"github.com/go-sql-driver/mysql", "go.mongodb.org/mongo-driver",
	"modernc.org/sqlite", "github.com/mattn/go-sqlite3", "github.com/redis/go-redis",
	"github.com/golang-jwt/jwt", "github.com/dgrijalva/jwt-go", "golang.org/x/crypto",
	"github.com/google/uuid", "github.com/gorilla/mux", "github.com/gorilla/handlers",
	"github.com/gorilla/sessions", "github.com/stretchr/testify/assert",
}

var devtoolPkgs = []string{
	"github.com/stretchr/testify/mock", "github.com/stretchr/testify/require",
	"github.com/golang/mock", "github.com/go-cmp/cmp", "github.com/google/go-cmp",
	"github.com/onsi/ginkgo", "github.com/onsi/gomega", "go.uber.org/mock",
	"github.com/vektra/mockery", "github.com/boumenot/gocover-cobertura",
}

type ThirdPartyRegistry struct {
	allowed map[string]bool
	rawDeps map[string]string
	lookup  *LookupMaps
}

func newThirdPartyRegistry(allowed []string, fp *Fingerprint, l *LookupMaps) *ThirdPartyRegistry {
	set := map[string]bool{}
	for _, a := range allowed {
		set[a] = true
	}
	return &ThirdPartyRegistry{allowed: set, rawDeps: fp.RawDependencies, lookup: l}
}

func (t *ThirdPartyRegistry) permitted(pkg string) bool { return t.allowed[pkg] }

func (t *ThirdPartyRegistry) baseMetadata(pkg string) map[string]any {
	version, ok := t.rawDeps[pkg]
	if !ok {
		version = "unknown"
	}
	category := "unknown"
	for _, r := range runtimePkgs {
		if pkg == r || strings.HasPrefix(pkg, r+"/") {
			category = "runtime"
			break
		}
	}
	if category == "unknown" {
		for _, d := range devtoolPkgs {
			if pkg == d || strings.HasPrefix(pkg, d+"/") {
				category = "devtool"
				break
			}
		}
	}
	return map[string]any{"isThirdParty": true, "packageVersion": version, "category": category}
}

// packageNode — [mod]/pkg node, or nil when not permitted. Cached per id.
func (t *ThirdPartyRegistry) packageNode(pkg string) map[string]any {
	if !t.permitted(pkg) {
		return nil
	}
	id := thirdPartyID(pkg)
	if n, ok := t.lookup.thirdPartyByID[id]; ok {
		return n
	}
	n := map[string]any{
		"id":        id,
		"name":      pkg,
		"type":      "THIRD_PARTY",
		"filePath":  id,
		"startLine": 0,
		"endLine":   0,
		"metadata":  t.baseMetadata(pkg),
	}
	t.lookup.thirdPartyByID[id] = n
	t.lookup.thirdPartyNodes = append(t.lookup.thirdPartyNodes, n)
	return n
}

// memberNode — [mod]/pkg::member (lazy member access), or nil when not
// permitted. The package node always exists first (parent).
func (t *ThirdPartyRegistry) memberNode(pkg, name string) map[string]any {
	if !t.permitted(pkg) {
		return nil
	}
	pkgNode := t.packageNode(pkg)
	if pkgNode == nil {
		return nil
	}
	id := thirdPartyID(pkg) + "::" + name
	if n, ok := t.lookup.thirdPartyByID[id]; ok {
		return n
	}
	pkgMeta := pkgNode["metadata"].(map[string]any)
	meta := map[string]any{
		"isThirdParty":    true,
		"packageVersion":  pkgMeta["packageVersion"],
		"category":        pkgMeta["category"],
		"parentPackageId": pkgNode["id"],
		"methodName":      name,
	}
	n := map[string]any{
		"id":        id,
		"name":      pkg + "." + name,
		"type":      "THIRD_PARTY",
		"filePath":  thirdPartyID(pkg),
		"startLine": 0,
		"endLine":   0,
		"metadata":  meta,
	}
	t.lookup.thirdPartyByID[id] = n
	t.lookup.thirdPartyNodes = append(t.lookup.thirdPartyNodes, n)
	return n
}

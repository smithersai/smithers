package errors

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// errcodecheck is the guard that keeps this registry closed.
//
// The registry only means anything if every failure goes through it. Two
// habits quietly reopen it, and neither one fails to compile:
//
//   - a hand-built &APIError{Status: …, Message: …} with no Code, which
//     reaches the wire only because WriteError backfills a generic code from
//     the status — so the response says exactly what its HTTP status already
//     said, and a client that branches on `code` learns nothing;
//   - Code set to a bare string, which the type system accepts (an untyped
//     constant converts to Code silently) and which therefore lets a call site
//     invent a verdict no registry row, no fault and no doc sentence backs.
//
// Both were swept once. This test is what stops them growing back: it parses
// every non-test .go file in the module, finds every composite literal of THIS
// package's APIError, and fails on either habit with the offending file:line.
//
// Parsing beats reflection for the same reason TestEveryCodeConstantIsRegistered
// parses: what a call site wrote is erased by the time a test could run it.
//
// SCOPE, and why it is drawn here:
//
//   - Non-test files only. Tests legitimately build code-less composites as
//     wire fixtures — registry_test.go builds one on purpose, to prove the
//     backfill still covers the call sites this guard cannot see (another
//     process's body, a failure_code column written by an older build).
//     Forbidding them in tests would forbid testing the backfill.
//   - This module only. apps/observe is a separate Go module with its own
//     unrelated APIError, and repo-host-go is a contract-test module.
const errcodecheckPackage = "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"

type errcodecheckFinding struct {
	pos    string
	reason string
}

func TestEveryAPIErrorNamesARegisteredCode(t *testing.T) {
	root := errcodecheckModuleRoot(t)
	fset := token.NewFileSet()
	var findings []errcodecheckFinding
	inspected := 0

	require.NoError(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", ".jj", "node_modules", "vendor", "testdata", "zig-out", ".zig-cache", "target":
				return fs.SkipDir
			}
			// A nested go.mod is a different module with its own types.
			if path != root {
				if _, statErr := os.Stat(filepath.Join(path, "go.mod")); statErr == nil {
					return fs.SkipDir
				}
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return nil // not ours to report; the compiler says it louder
		}
		aliases := errcodecheckAliases(file)
		local := file.Name.Name == "errors" && strings.Contains(filepath.ToSlash(path), "/pkg/errors/")
		if len(aliases) == 0 && !local {
			return nil
		}

		ast.Inspect(file, func(node ast.Node) bool {
			lit, ok := node.(*ast.CompositeLit)
			if !ok || !errcodecheckIsAPIError(lit.Type, aliases, local) {
				return true
			}
			// An empty literal is an errors.As target, not a failure.
			if len(lit.Elts) == 0 {
				return true
			}
			inspected++
			where := strings.TrimPrefix(fset.Position(lit.Pos()).String(), root+string(os.PathSeparator))
			value, present := errcodecheckCodeValue(lit)
			if !present {
				findings = append(findings, errcodecheckFinding{where,
					"builds an APIError with no Code, so its only verdict is the HTTP status " +
						"WriteError backfills from. Name the code: errors.New(errors.CodeX, msg)"})
				return true
			}
			if literal, isString := errcodecheckStringLiteral(value); isString {
				if _, registered := Lookup(Code(literal)); registered {
					findings = append(findings, errcodecheckFinding{where,
						"sets Code to the bare string " + strconv.Quote(literal) +
							" instead of its constant. A string is not checked by anything: " +
							"rename the code and this site keeps compiling while it stops matching"})
				} else {
					findings = append(findings, errcodecheckFinding{where,
						"sets Code to " + strconv.Quote(literal) +
							", which has no registry row — no status, no fault, no doc sentence"})
				}
			}
			return true
		})
		return nil
	}))

	// A guard that inspects nothing passes forever. plue builds APIError
	// composites in dozens of places; if this number collapses, the walk stopped
	// finding them (the package moved, an alias convention changed, a skip rule
	// grew too wide) and the guard is protecting an empty set.
	require.Greater(t, inspected, 20,
		"errcodecheck inspected only %d APIError literals across the module; "+
			"it is no longer reading the code it claims to guard", inspected)

	sort.Slice(findings, func(i, j int) bool { return findings[i].pos < findings[j].pos })
	for _, finding := range findings {
		t.Errorf("%s: %s", finding.pos, finding.reason)
	}
}

// errcodecheckModuleRoot walks up from this package to the directory holding
// go.mod, so the guard covers the whole module however the test is invoked.
func errcodecheckModuleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	require.NoError(t, err)
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "go.mod")); statErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		require.NotEqual(t, parent, dir, "no go.mod above %s; the guard would silently cover nothing", dir)
		dir = parent
	}
}

// errcodecheckAliases returns the names this file refers to pkg/errors by.
func errcodecheckAliases(file *ast.File) map[string]bool {
	aliases := map[string]bool{}
	for _, imported := range file.Imports {
		path, err := strconv.Unquote(imported.Path.Value)
		if err != nil || path != errcodecheckPackage {
			continue
		}
		if imported.Name != nil {
			if imported.Name.Name == "." {
				// A dot import would make every bare APIError ours; nothing
				// does this, and guessing would produce false findings.
				continue
			}
			aliases[imported.Name.Name] = true
			continue
		}
		aliases["errors"] = true
	}
	return aliases
}

func errcodecheckIsAPIError(expr ast.Expr, aliases map[string]bool, local bool) bool {
	switch typed := expr.(type) {
	case *ast.SelectorExpr:
		pkg, ok := typed.X.(*ast.Ident)
		return ok && typed.Sel.Name == "APIError" && aliases[pkg.Name]
	case *ast.Ident:
		return local && typed.Name == "APIError"
	}
	return false
}

func errcodecheckCodeValue(lit *ast.CompositeLit) (ast.Expr, bool) {
	for _, element := range lit.Elts {
		pair, ok := element.(*ast.KeyValueExpr)
		if !ok {
			// A positional literal names no fields; it is unreadable rather
			// than wrong, and the compiler already fights it.
			return nil, true
		}
		key, ok := pair.Key.(*ast.Ident)
		if ok && key.Name == "Code" {
			return pair.Value, true
		}
	}
	return nil, false
}

func errcodecheckStringLiteral(expr ast.Expr) (string, bool) {
	basic, ok := expr.(*ast.BasicLit)
	if !ok || basic.Kind != token.STRING {
		return "", false
	}
	value, err := strconv.Unquote(basic.Value)
	if err != nil {
		return "", false
	}
	return value, true
}

package compose

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestServerAssemblyDoesNotUsePrintfOrFatalf parses the server bootstrap and
// router assembly files and asserts that forbidden stdlib log calls are absent.
// All logging should use the slog structured logger instead.
func TestServerAssemblyDoesNotUsePrintfOrFatalf(t *testing.T) {
	t.Parallel()

	testDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to get working directory: %v", err)
	}

	fset := token.NewFileSet()
	var forbiddenCalls []string
	forbiddenFuncs := map[string]struct{}{
		"Printf":  {},
		"Println": {},
		"Fatalf":  {},
		"Fatal":   {},
		"Print":   {},
	}

	for _, name := range []string{"main.go", "router.go"} {
		path := filepath.Join(testDir, name)
		src, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatalf("failed to read %s: %v", name, readErr)
		}
		file, parseErr := parser.ParseFile(fset, path, src, parser.AllErrors)
		if parseErr != nil {
			t.Fatalf("failed to parse %s: %v", name, parseErr)
		}

		ast.Inspect(file, func(n ast.Node) bool {
			callExpr, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}

			selExpr, ok := callExpr.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}

			ident, ok := selExpr.X.(*ast.Ident)
			if !ok || ident.Name != "log" {
				return true
			}

			funcName := selExpr.Sel.Name
			if _, forbidden := forbiddenFuncs[funcName]; forbidden {
				pos := fset.Position(callExpr.Pos())
				forbiddenCalls = append(
					forbiddenCalls,
					fmt.Sprintf("%s: log.%s at line %d", name, funcName, pos.Line),
				)
			}

			return true
		})
	}

	if len(forbiddenCalls) > 0 {
		t.Errorf("server assembly contains forbidden stdlib log calls that should be replaced with slog:\n  %s",
			strings.Join(forbiddenCalls, "\n  "))
	}
}

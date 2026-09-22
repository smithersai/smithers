package product

import (
	"encoding/csv"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Product query SQL must never require a private cluster table at runtime.
func TestProductQueriesExcludeClusterTables(t *testing.T) {
	manifest, err := os.Open("../ownership.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer manifest.Close()
	rows, err := csv.NewReader(manifest).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	var excluded []string
	for _, row := range rows[1:] {
		if len(row) >= 2 && row[1] != "product" {
			excluded = append(excluded, row[0])
		}
	}
	files, err := filepath.Glob("../../internal/db/*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			for _, table := range excluded {
				if strings.Contains(literal.Value, table) {
					t.Errorf("%s references private table %s", path, table)
				}
			}
			return true
		})
	}
}

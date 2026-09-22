package cluster

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"
)

// A cluster query may return a product row, but it must use the same Go model
// as the public product query graph. A duplicate struct allows silent drift.
func TestClusterModelsAliasProductModels(t *testing.T) {
	parse := func(path string) *ast.File {
		t.Helper()
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	models := func(file *ast.File) map[string]ast.Expr {
		out := make(map[string]ast.Expr)
		for _, declaration := range file.Decls {
			general, ok := declaration.(*ast.GenDecl)
			if !ok || general.Tok != token.TYPE {
				continue
			}
			for _, spec := range general.Specs {
				typeSpec := spec.(*ast.TypeSpec)
				out[typeSpec.Name.Name] = typeSpec.Type
			}
		}
		return out
	}
	product := models(parse(filepath.Join("..", "..", "internal", "db", "models.go")))
	private := models(parse(filepath.Join("..", "..", "internal", "clusterdb", "models.go")))
	for name := range product {
		value, ok := private[name]
		if !ok {
			t.Errorf("cluster model %s is missing", name)
			continue
		}
		selector, ok := value.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != name {
			t.Errorf("cluster model %s duplicates the product model", name)
			continue
		}
		pkg, ok := selector.X.(*ast.Ident)
		if !ok || pkg.Name != "db" {
			t.Errorf("cluster model %s does not alias db.%s", name, name)
		}
	}
}

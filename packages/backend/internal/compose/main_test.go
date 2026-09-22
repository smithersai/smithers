package compose

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestInitializeBlobStore_GCSRequiresInjectedAdapter(t *testing.T) {
	store, client, expiry, err := initializeBlobStore(context.Background(), config.BlobConfig{GCSBucket: "hosted-bucket"})
	require.ErrorContains(t, err, "requires an injected cloud blob adapter")
	assert.Nil(t, store)
	assert.Nil(t, client)
	assert.Zero(t, expiry)
}

func TestInitializeBlobStore_FilesystemDefault(t *testing.T) {
	t.Setenv("SMITHERS_ENV", "development")
	cfg := config.BlobConfig{
		DataDir: t.TempDir(),
	}

	ctx := context.Background()
	store, client, expiry, err := initializeBlobStore(ctx, cfg)
	require.NoError(t, err)
	require.NotNil(t, store)
	require.Nil(t, client)
	assert.Equal(t, blob.DefaultSignedURLExpiry, expiry)

	_, isFilesystem := store.(*blob.FilesystemStore)
	assert.True(t, isFilesystem, "Expected store to be *blob.FilesystemStore")
}

func TestMountBlobTransferHandler(t *testing.T) {
	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{
		Root: t.TempDir(), PublicBaseURL: "https://smithers.test", SigningKey: []byte(strings.Repeat("s", 32)),
	})
	require.NoError(t, err)
	require.NoError(t, store.Put(context.Background(), "repos/7/artifacts/result", "text/plain", strings.NewReader("result")))
	downloadURL, err := store.SignedDownloadURL(context.Background(), "repos/7/artifacts/result", time.Minute)
	require.NoError(t, err)

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	handler := mountBlobTransferHandler(next, store)
	req := httptest.NewRequest(http.MethodGet, downloadURL, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "result", rec.Body.String())

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/unrelated", nil))
	assert.Equal(t, http.StatusTeapot, rec.Code)
}

func TestInitializeBlobStore_ProductionRequiresDurableAdapter(t *testing.T) {
	t.Setenv("SMITHERS_ENV", "production")

	store, client, expiry, err := initializeBlobStore(context.Background(), config.BlobConfig{})
	require.ErrorContains(t, err, "filesystem blob root is required")
	assert.Nil(t, store)
	assert.Nil(t, client)
	assert.Zero(t, expiry)
}

func TestValidateProductionBlobStoreFailsClosed(t *testing.T) {
	require.NoError(t, validateProductionBlobStore("development", config.BlobConfig{}))
	require.NoError(t, validateProductionBlobStore(" production ", config.BlobConfig{GCSBucket: "plue-blobs"}))
	require.NoError(t, validateProductionBlobStore("production", config.BlobConfig{DataDir: "/var/lib/smithers/blobs"}))

	err := validateProductionBlobStore("PRODUCTION", config.BlobConfig{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SMITHERS_BLOB_DATA_DIR or SMITHERS_BLOB_GCS_BUCKET is required")
}

func TestInitializeBlobStore_ExpiryParsing(t *testing.T) {
	tests := []struct {
		name          string
		cfg           config.BlobConfig
		expectedDur   time.Duration
		expectedError bool
	}{
		{
			name: "Valid Duration",
			cfg: config.BlobConfig{
				SignedURLExpiry: "2h",
			},
			expectedDur:   2 * time.Hour,
			expectedError: false,
		},
		{
			name: "Empty Duration",
			cfg: config.BlobConfig{
				SignedURLExpiry: "",
			},
			expectedDur:   blob.DefaultSignedURLExpiry,
			expectedError: false,
		},
		{
			name: "Invalid Duration",
			cfg: config.BlobConfig{
				SignedURLExpiry: "invalid",
			},
			expectedDur:   0,
			expectedError: true,
		},
		{
			name: "Above Provider Maximum",
			cfg: config.BlobConfig{
				SignedURLExpiry: "168h1ns",
			},
			expectedDur:   0,
			expectedError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			if tt.cfg.GCSBucket == "" {
				tt.cfg.DataDir = t.TempDir()
			}
			_, _, expiry, err := initializeBlobStore(ctx, tt.cfg)
			if tt.expectedError {
				assert.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.expectedDur, expiry)
			}
		})
	}
}

func TestBuildServer_WiresGitHTTPProxyWebhookDependencies(t *testing.T) {
	t.Parallel()

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	require.NoError(t, err)

	found := false
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}

		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}

		pkgIdent, ok := sel.X.(*ast.Ident)
		if !ok || pkgIdent.Name != "services" || sel.Sel.Name != "NewGitHTTPProxyService" {
			return true
		}

		found = true
		require.Len(t, call.Args, 4)

		expected := []string{"queries", "sshAuthzService", "repoHostClient"}
		for i, arg := range call.Args {
			if i == 3 {
				optionCall, ok := arg.(*ast.CallExpr)
				require.True(t, ok, "arg 3 should configure task-token Git authorization")
				optionSelector, ok := optionCall.Fun.(*ast.SelectorExpr)
				require.True(t, ok)
				assert.Equal(t, "WithGitHTTPRunnerTaskTokenSecret", optionSelector.Sel.Name)
				require.Len(t, optionCall.Args, 1)
				envCall, ok := optionCall.Args[0].(*ast.CallExpr)
				require.True(t, ok)
				envSelector, ok := envCall.Fun.(*ast.SelectorExpr)
				require.True(t, ok)
				assert.Equal(t, "Getenv", envSelector.Sel.Name)
				require.Len(t, envCall.Args, 1)
				literal, ok := envCall.Args[0].(*ast.BasicLit)
				require.True(t, ok)
				assert.Equal(t, `"SMITHERS_AGENT_TOKEN"`, literal.Value)
				continue
			}
			ident, ok := arg.(*ast.Ident)
			require.Truef(t, ok, "arg %d should be identifier", i)
			assert.Equal(t, expected[i], ident.Name)
		}

		return false
	})

	require.True(t, found, "expected services.NewGitHTTPProxyService call in main.go")
}

func TestBuildRouter_RepoForkRouteRequiresWriteScopeAndReadPermission(t *testing.T) {
	t.Parallel()

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "router.go", nil, 0)
	require.NoError(t, err)

	routeUsesForkRepo := false
	forkRepoRequiresWriteScope := false
	forkRepoRequiresReadPermission := false
	ast.Inspect(file, func(n ast.Node) bool {
		if postCall, ok := n.(*ast.CallExpr); ok {
			postSelector, ok := postCall.Fun.(*ast.SelectorExpr)
			if !ok || postSelector.Sel.Name != "Post" || len(postCall.Args) == 0 {
				return true
			}

			route, ok := postCall.Args[0].(*ast.BasicLit)
			if !ok || route.Value != "\"/forks\"" {
				return true
			}

			withCall, ok := postSelector.X.(*ast.CallExpr)
			require.True(t, ok, "POST /forks should be mounted through r.With")

			withSelector, ok := withCall.Fun.(*ast.SelectorExpr)
			require.True(t, ok, "POST /forks should be mounted through r.With")
			assert.Equal(t, "With", withSelector.Sel.Name)
			require.Len(t, withCall.Args, 1)

			middlewareIdent, ok := withCall.Args[0].(*ast.Ident)
			require.True(t, ok, "POST /forks should pass a middleware slice to r.With")
			assert.Equal(t, "forkRepo", middlewareIdent.Name)

			routeUsesForkRepo = true
		}

		assign, ok := n.(*ast.AssignStmt)
		if !ok || len(assign.Lhs) != len(assign.Rhs) {
			return true
		}
		for i, lhs := range assign.Lhs {
			ident, ok := lhs.(*ast.Ident)
			if !ok || ident.Name != "forkRepo" {
				continue
			}
			if hasMiddlewareCall(assign.Rhs[i], "RequireScope", "ScopeWriteRepository") {
				forkRepoRequiresWriteScope = true
			}
			if hasMiddlewareCall(assign.Rhs[i], "RequireRepoPermission", "PermissionRead") {
				forkRepoRequiresReadPermission = true
			}
		}

		return true
	})

	require.True(t, routeUsesForkRepo, "expected POST /forks route to use forkRepo middleware")
	require.True(t, forkRepoRequiresWriteScope, "forkRepo should require write:repository token scope")
	require.True(t, forkRepoRequiresReadPermission, "forkRepo should preserve source repository read permission")
}

func TestBuildRouter_GitHubReconcileUsesRepositoryWriteMiddleware(t *testing.T) {
	t.Parallel()

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "router.go", nil, 0)
	require.NoError(t, err)

	found := false
	writeRepoRequiresWriteScope := false
	writeRepoRequiresWritePermission := false
	ast.Inspect(file, func(n ast.Node) bool {
		if assign, ok := n.(*ast.AssignStmt); ok && len(assign.Lhs) == len(assign.Rhs) {
			for i, lhs := range assign.Lhs {
				ident, ok := lhs.(*ast.Ident)
				if !ok || ident.Name != "writeRepo" {
					continue
				}
				if hasMiddlewareCall(assign.Rhs[i], "RequireScope", "ScopeWriteRepository") {
					writeRepoRequiresWriteScope = true
				}
				if hasMiddlewareCall(assign.Rhs[i], "RequireRepoPermission", "PermissionWrite") {
					writeRepoRequiresWritePermission = true
				}
			}
		}

		postCall, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		postSelector, ok := postCall.Fun.(*ast.SelectorExpr)
		if !ok || postSelector.Sel.Name != "Post" || len(postCall.Args) < 2 {
			return true
		}
		route, ok := postCall.Args[0].(*ast.BasicLit)
		if !ok || route.Value != `"/github/reconcile"` {
			return true
		}

		withCall, ok := postSelector.X.(*ast.CallExpr)
		require.True(t, ok, "POST /github/reconcile should be mounted through r.With")
		withSelector, ok := withCall.Fun.(*ast.SelectorExpr)
		require.True(t, ok)
		assert.Equal(t, "With", withSelector.Sel.Name)
		require.Len(t, withCall.Args, 1)
		middlewareIdent, ok := withCall.Args[0].(*ast.Ident)
		require.True(t, ok)
		assert.Equal(t, "writeRepo", middlewareIdent.Name)
		found = true
		return false
	})

	require.True(t, found, "expected POST /github/reconcile route")
	require.True(t, writeRepoRequiresWriteScope, "github reconcile should require write:repository scope")
	require.True(t, writeRepoRequiresWritePermission, "github reconcile should require repository write permission")
}

func hasMiddlewareCall(expr ast.Expr, functionName, argumentName string) bool {
	found := false
	ast.Inspect(expr, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}

		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != functionName || len(call.Args) != 1 {
			return true
		}

		arg, ok := call.Args[0].(*ast.SelectorExpr)
		if !ok || arg.Sel.Name != argumentName {
			return true
		}

		found = true
		return false
	})
	return found
}

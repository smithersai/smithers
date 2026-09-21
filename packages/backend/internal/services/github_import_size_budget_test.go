package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// cloneAndSyncMirror runs `git clone --mirror` into the API pod's /tmp, which
// is a sized emptyDir. An unbounded clone therefore evicts the pod and kills
// every other in-flight request with it: production evicted an API replica
// every ~15 minutes with `Usage of EmptyDir volume "tmp" exceeds the limit
// "1Gi"`, observed directly as /tmp/smithers-github-import-* growing
// 183 MB -> 1.69 GB in 90 seconds. The import must refuse before cloning.
func TestGitHubImportService_RefusesRepositoryOverTheSizeBudget(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
			"size":           3 * 1024 * 1024, // 3 GiB, reported in KB
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)
	t.Setenv("SMITHERS_GITHUB_IMPORT_MAX_SIZE_MB", "1024")

	svc := NewGitHubImportService(nil, nil, testGitHubImportTokenDB{}, &testGitHubImportRepoHost{}, testGitHubImportDecrypter{}, "https://smithers.test", WithGitHubImportHTTPClient(api.Client()))

	_, _, _, err := svc.githubCloneInfoForRepo(context.Background(), 7, "octo", "huge")
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected an APIError, got %T", err)
	assert.Equal(t, http.StatusRequestEntityTooLarge, apiErr.Status)
	assert.Contains(t, apiErr.Message, "3072 MB")
	assert.Contains(t, apiErr.Message, "1024 MB")
}

func TestGitHubImportService_AllowsRepositoryWithinTheSizeBudget(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
			"size":           64 * 1024, // 64 MiB
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)
	t.Setenv("SMITHERS_GITHUB_IMPORT_MAX_SIZE_MB", "1024")

	svc := NewGitHubImportService(nil, nil, testGitHubImportTokenDB{}, &testGitHubImportRepoHost{}, testGitHubImportDecrypter{}, "https://smithers.test", WithGitHubImportHTTPClient(api.Client()))

	_, _, defaultBranch, err := svc.githubCloneInfoForRepo(context.Background(), 7, "octo", "small")
	require.NoError(t, err)
	assert.Equal(t, "main", defaultBranch)
}

func TestGitHubImportSizeExceeded(t *testing.T) {
	t.Parallel()

	over, sizeMB := gitHubImportSizeExceeded(2*1024*1024, 1024)
	assert.True(t, over)
	assert.Equal(t, int64(2048), sizeMB)

	under, sizeMB := gitHubImportSizeExceeded(512*1024, 1024)
	assert.False(t, under)
	assert.Equal(t, int64(512), sizeMB)

	// A repository exactly at the budget is allowed.
	atLimit, _ := gitHubImportSizeExceeded(1024*1024, 1024)
	assert.False(t, atLimit)

	// GitHub Enterprise proxies (and some repositories) report no size at all.
	// Refusing those would break imports that fit fine.
	unknown, _ := gitHubImportSizeExceeded(0, 1024)
	assert.False(t, unknown)

	// A non-positive budget disables the check for operators with unbounded
	// scratch space.
	disabled, _ := gitHubImportSizeExceeded(50*1024*1024, 0)
	assert.False(t, disabled)
}

func TestGitHubImportMaxSizeMB_DefaultsAndOverrides(t *testing.T) {
	t.Setenv("SMITHERS_GITHUB_IMPORT_MAX_SIZE_MB", "")
	assert.Equal(t, int64(defaultGitHubImportMaxSizeMB), githubImportMaxSizeMB())

	t.Setenv("SMITHERS_GITHUB_IMPORT_MAX_SIZE_MB", "2048")
	assert.Equal(t, int64(2048), githubImportMaxSizeMB())

	// A malformed value must not silently disable the guard.
	t.Setenv("SMITHERS_GITHUB_IMPORT_MAX_SIZE_MB", "not-a-number")
	assert.Equal(t, int64(defaultGitHubImportMaxSizeMB), githubImportMaxSizeMB())
}

// Repro apps/ui/canary-repros/github/12.2: `/repos.import facebook/react` sat
// RUNNING for hours. The size budget refuses before the clone, but 413 was not
// in the terminal set, so the job was retried — 53 attempts across 13 hours
// before the user was finally told the repository is 1041 MB against a 1024 MB
// limit. A repository over the limit is over it on every attempt; the verdict is
// as permanent as a 404 and must terminalize the job on the first one.
func TestGitHubImport_OversizeRefusalIsTerminal(t *testing.T) {
	t.Parallel()

	oversize := &pkgerrors.APIError{
		Status:  http.StatusRequestEntityTooLarge,
		Message: "github repository facebook/react is 1041 MB, over the 1024 MB import limit",
	}
	assert.True(t, isTerminalGitHubImportFailure(oversize),
		"an oversized repository must fail the import job on the first attempt")

	// A transport-shaped failure is still retryable: that distinction is the
	// whole point of the classifier.
	assert.False(t, isTerminalGitHubImportFailure(pkgerrors.Internal("github repository request was rejected")))
}

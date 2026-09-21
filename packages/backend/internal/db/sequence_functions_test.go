package db

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetNextIssueNumber_RequiresExistingRepository(t *testing.T) {
	_, pool := newQueries(t)

	// Use a repo ID that does not exist in the database.
	const nonExistentRepoID int64 = 999999

	var result int64
	err := pool.QueryRow(context.Background(),
		`SELECT get_next_issue_number($1)`, nonExistentRepoID).Scan(&result)

	require.Error(t, err, "get_next_issue_number should fail for non-existent repository")
	errMsg := strings.ToLower(err.Error())
	assert.Contains(t, errMsg, "repository", "error should mention 'repository'")
	assert.Contains(t, errMsg, "not found", "error should mention 'not found'")
}

func TestGetNextLandingNumber_RequiresExistingRepository(t *testing.T) {
	_, pool := newQueries(t)

	// Use a repo ID that does not exist in the database.
	const nonExistentRepoID int64 = 999999

	var result int64
	err := pool.QueryRow(context.Background(),
		`SELECT get_next_landing_number($1)`, nonExistentRepoID).Scan(&result)

	require.Error(t, err, "get_next_landing_number should fail for non-existent repository")
	errMsg := strings.ToLower(err.Error())
	assert.Contains(t, errMsg, "repository", "error should mention 'repository'")
	assert.Contains(t, errMsg, "not found", "error should mention 'not found'")
}

func TestGetNextIssueNumber_IsAtomicAndMonotonic(t *testing.T) {
	// Concurrent queries require separate connections, so use sharedPool directly
	// instead of the per-test transaction (which uses a single connection).
	seq := testSeqCounter.Add(1)
	username := fmt.Sprintf("issue-seq-user-%d", seq)
	repoName := fmt.Sprintf("issue-seq-repo-%d", seq)
	userID := mustCreateUser(t, sharedPool, username)
	repoID := mustCreateRepo(t, sharedPool, userID, repoName)
	t.Cleanup(func() {
		mustDurablyDeleteRepoCommittedForTest(t, sharedPool, repoID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	const workers = 20
	results := make([]int64, workers)
	errs := make(chan error, workers)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := sharedPool.QueryRow(context.Background(), `SELECT get_next_issue_number($1)`, repoID).Scan(&results[i]); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		require.NoError(t, err)
	}

	sort.Slice(results, func(i, j int) bool { return results[i] < results[j] })
	for i := 0; i < workers; i++ {
		assert.Equal(t, int64(i+1), results[i])
	}
}

func TestGetNextLandingNumber_IsAtomicAndMonotonic(t *testing.T) {
	// Concurrent queries require separate connections, so use sharedPool directly
	// instead of the per-test transaction (which uses a single connection).
	seq := testSeqCounter.Add(1)
	username := fmt.Sprintf("landing-seq-user-%d", seq)
	repoName := fmt.Sprintf("landing-seq-repo-%d", seq)
	userID := mustCreateUser(t, sharedPool, username)
	repoID := mustCreateRepo(t, sharedPool, userID, repoName)
	t.Cleanup(func() {
		mustDurablyDeleteRepoCommittedForTest(t, sharedPool, repoID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	const workers = 20
	results := make([]int64, workers)
	errs := make(chan error, workers)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := sharedPool.QueryRow(context.Background(), `SELECT get_next_landing_number($1)`, repoID).Scan(&results[i]); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		require.NoError(t, err)
	}

	sort.Slice(results, func(i, j int) bool { return results[i] < results[j] })
	for i := 0; i < workers; i++ {
		assert.Equal(t, int64(i+1), results[i])
	}
}

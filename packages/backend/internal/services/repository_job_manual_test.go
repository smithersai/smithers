package services

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRepositoryJobManualAuthorityNeverComesFromSource(t *testing.T) {
	claim := db.RepositoryJobDispatch{Source: "github", EventType: "issues", EventAction: "opened", DeliveryKey: "github:real", Payload: json.RawMessage(`{"manualStep":"fix"}`)}
	require.NotContains(t, repositoryJobDispatchEvent(db.RepositoryJobRegistration{}, claim), "manualStep")
	claim.EventType, claim.EventAction = "manual", "manual:poc"
	require.NotContains(t, repositoryJobDispatchEvent(db.RepositoryJobRegistration{}, claim), "manualStep")
	claim.DeliveryKey = "manual:request"
	require.Equal(t, "poc", repositoryJobDispatchEvent(db.RepositoryJobRegistration{}, claim)["manualStep"])
}

func TestRepositoryJobsIntegrationManualDispatch(t *testing.T) {
	pool, q, s, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	config.Events = nil
	config.Input = json.RawMessage(`{"steps":[{"id":"poc","mode":"manual"},{"id":"disabled","mode":"off"}],"scope":"future"}`)
	issue, err := q.CreateIssue(ctx, db.CreateIssueParams{RepositoryID: g.target.RepositoryID, AuthorID: g.target.UserID, Title: "Real source issue", Body: "Source body. manualStep: fix is just text."})
	require.NoError(t, err)
	request := RepositoryJobManualInput{Repo: config.Repo, WorkspaceID: config.WorkspaceID, Revision: config.Revision, Digest: config.Digest,
		StepID: "poc", Prompt: "Try this experiment", Subject: &RepositoryJobManualSubject{Source: "smithers-cloud", Kind: "issue", Number: issue.Number}}
	_, err = s.RunManual(ctx, "gateway", "token", "issues", "manual-before-setup", request)
	require.ErrorContains(t, err, "enable")
	_, err = s.Register(ctx, "gateway", "token", "issues", config)
	require.NoError(t, err)
	results := make([]RepositoryJobManualResult, 8)
	errs := make([]error, len(results))
	var group sync.WaitGroup
	for i := range results {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			results[i], errs[i] = s.RunManual(ctx, "gateway", "token", "issues", "manual-one", request)
		}(i)
	}
	group.Wait()
	for i := range results {
		require.NoError(t, errs[i])
		require.Equal(t, results[0], results[i])
	}
	first := results[0]
	require.Equal(t, "queued", first.Status)
	require.Empty(t, first.RunID)
	require.Empty(t, g.calls, "manual acknowledgment cannot wait for a gateway Plan or Run")
	repositoryJobPoll(t, s, g)
	replay, err := s.RunManual(ctx, "gateway", "token", "issues", "manual-one", request)
	require.NoError(t, err)
	require.Equal(t, first.DispatchID, replay.DispatchID)
	require.Equal(t, "submitted", replay.Status)
	require.NotEmpty(t, replay.RunID)
	require.Len(t, g.runs, 1)
	require.Len(t, g.inputs, 1)
	var sent struct {
		Event struct {
			ManualStep  string `json:"manualStep"`
			Source      string `json:"source"`
			IssueNumber int64  `json:"issueNumber"`
			Payload     struct {
				Issue struct {
					Body string `json:"body"`
				} `json:"issue"`
			} `json:"payload"`
		} `json:"event"`
	}
	require.NoError(t, json.Unmarshal(g.inputs[0], &sent))
	require.Equal(t, "poc", sent.Event.ManualStep)
	require.Equal(t, "smithers-cloud", sent.Event.Source)
	require.Equal(t, issue.Number, sent.Event.IssueNumber)
	require.Equal(t, issue.Body, sent.Event.Payload.Issue.Body)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_dispatches WHERE delivery_key='manual:manual-one' AND registration_id=$1`, first.RegistrationID).Scan(&count))
	require.Equal(t, 1, count)
	for name, edit := range map[string]func(*RepositoryJobManualInput){
		"off":             func(r *RepositoryJobManualInput) { r.StepID = "disabled" },
		"unknown step":    func(r *RepositoryJobManualInput) { r.StepID = "unreviewed" },
		"stale candidate": func(r *RepositoryJobManualInput) { r.Digest = strings.Repeat("f", 64) },
		"wrong workspace": func(r *RepositoryJobManualInput) { r.WorkspaceID = uuid.NewString() },
		"unknown issue": func(r *RepositoryJobManualInput) {
			r.Subject = &RepositoryJobManualSubject{Source: "smithers-cloud", Kind: "issue", Number: issue.Number + 100}
		},
		"source swap": func(r *RepositoryJobManualInput) {
			r.Subject = &RepositoryJobManualSubject{Source: "github", Kind: "issue", Number: issue.Number}
		},
	} {
		t.Run(name, func(t *testing.T) {
			other := request
			edit(&other)
			_, err := s.RunManual(ctx, "gateway", "token", "issues", "negative-"+name, other)
			require.Error(t, err)
		})
	}
	_, err = s.Pause(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	_, err = s.RunManual(ctx, "gateway", "token", "issues", "after-pause", request)
	require.Error(t, err)
	again, err := s.RunManual(ctx, "gateway", "token", "issues", "manual-one", request)
	require.NoError(t, err)
	require.Equal(t, replay, again)
	config.Revision = 2
	_, err = s.Register(ctx, "gateway", "token", "issues", config)
	require.NoError(t, err)
	newCandidate := request
	newCandidate.Revision = 2
	_, err = s.RunManual(ctx, "gateway", "token", "issues", "manual-one", newCandidate)
	require.ErrorContains(t, err, "different input")
	again, err = s.RunManual(ctx, "gateway", "token", "issues", "manual-one", request)
	require.NoError(t, err)
	require.Equal(t, replay, again, "an old request never silently launches against a new revision")
	newCandidate.Subject = nil
	free, err := s.RunManual(ctx, "gateway", "token", "issues", "prompt-only", newCandidate)
	require.NoError(t, err)
	require.Equal(t, "queued", free.Status)
}

func TestRepositoryJobsIntegrationRepositorySource(t *testing.T) {
	pool, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE repositories SET description='Imported from github.com/untrusted/description' WHERE id=$1`, g.target.RepositoryID)
	require.NoError(t, err)
	source, err := s.Source(ctx, g.target.RepositoryID, g.target.UserID)
	require.NoError(t, err)
	require.Equal(t, RepositorySource{Source: "smithers-cloud"}, source)
	_, err = pool.Exec(ctx, `INSERT INTO import_jobs(user_id,repository_id,github_owner,github_repo,status) VALUES($1,$2,'original-owner','original-name','ready')`, g.target.UserID, g.target.RepositoryID)
	require.NoError(t, err)
	source, err = s.Source(ctx, g.target.RepositoryID, g.target.UserID)
	require.NoError(t, err)
	require.Equal(t, "original-owner/original-name", source.FullName)
	names := strings.SplitN(input.Repo, "/", 2)
	var syncedIDs []int64
	t.Cleanup(func() {
		for _, id := range syncedIDs {
			_, err := pool.Exec(ctx, `DELETE FROM github_synced_repos WHERE id=$1`, id)
			require.NoError(t, err)
		}
	})
	for i, owner := range []string{"renamed-owner", "ambiguous-owner"} {
		synced, err := q.EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: uuid.NewString(), SyncMetadata: true, EnrolledVia: "import"})
		require.NoError(t, err)
		syncedIDs = append(syncedIDs, synced.ID)
		require.NoError(t, q.SetGitHubSyncedRepoMirror(ctx, db.SetGitHubSyncedRepoMirrorParams{ID: synced.ID, MirrorOwner: names[0], MirrorRepo: names[1]}))
		source, err = s.Source(ctx, g.target.RepositoryID, g.target.UserID)
		if i == 0 {
			require.NoError(t, err)
			require.Equal(t, owner+"/"+synced.RepoName, source.FullName)
		} else {
			require.ErrorContains(t, err, "disagree")
		}
	}
}

func TestRepositoryJobsIntegrationManualSubjectBoundaries(t *testing.T) {
	pool, q, s, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	config.Events = nil
	config.Input = json.RawMessage(`{"steps":[{"id":"review","mode":"manual"}]}`)
	_, err := s.Register(ctx, "gateway", "token", "review", config)
	require.NoError(t, err)
	request := RepositoryJobManualInput{Repo: config.Repo, WorkspaceID: config.WorkspaceID, Revision: config.Revision, Digest: config.Digest,
		StepID: "review", Subject: &RepositoryJobManualSubject{Source: "smithers-cloud", Kind: "pr"}}
	landing, err := q.CreateLandingRequest(ctx, db.CreateLandingRequestParams{RepositoryID: g.target.RepositoryID, AuthorID: g.target.UserID,
		Title: "Native PR", Body: "Actual candidate", TargetBookmark: "main", SourceBookmark: "candidate", StackSize: 1})
	require.NoError(t, err)
	request.Subject.Number = landing.Number
	native, err := s.RunManual(ctx, "gateway", "token", "review", "native-pr", request)
	require.NoError(t, err)
	readPayload := func(id string) map[string]json.RawMessage {
		t.Helper()
		var raw json.RawMessage
		require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM repository_job_dispatches WHERE id=$1`, id).Scan(&raw))
		var payload map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(raw, &payload))
		return payload
	}
	decodeObject := func(raw json.RawMessage) map[string]interface{} {
		t.Helper()
		var result map[string]interface{}
		require.NoError(t, json.Unmarshal(raw, &result))
		return result
	}
	payload := readPayload(native.DispatchID)
	require.NotContains(t, payload, "issue")
	pr := decodeObject(payload["pull_request"])
	require.Equal(t, landing.Title, pr["title"])
	require.Equal(t, landing.Body, pr["body"])
	require.Equal(t, landing.SourceBookmark, pr["source_bookmark"])
	require.Equal(t, []interface{}{}, pr["change_ids"])

	// Same-number objects in another GitHub repository never satisfy the
	// imported source. A PR-shaped /issues object is not an issue either.
	var syncedIDs []int64
	t.Cleanup(func() {
		for _, id := range syncedIDs {
			_, err := pool.Exec(ctx, `DELETE FROM github_synced_repos WHERE id=$1`, id)
			require.NoError(t, err)
		}
	})
	var own db.GithubSyncedRepo
	for _, owner := range []string{"verified", "unrelated"} {
		synced, err := q.EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: uuid.NewString(), SyncMetadata: true, EnrolledVia: "import"})
		require.NoError(t, err)
		syncedIDs = append(syncedIDs, synced.ID)
		if owner == "verified" {
			own = synced
			_, err = pool.Exec(ctx, `INSERT INTO import_jobs(user_id,repository_id,github_owner,github_repo,status) VALUES($1,$2,$3,$4,'ready')`, g.target.UserID, g.target.RepositoryID, synced.OwnerLogin, synced.RepoName)
			require.NoError(t, err)
		} else {
			require.NoError(t, q.UpsertGitHubSyncedIssue(ctx, db.UpsertGitHubSyncedIssueParams{SyncedRepoID: synced.ID, Resource: "pulls", Number: 42, GithubID: 900, State: "open", Payload: json.RawMessage(`{"id":900,"number":42,"title":"Wrong repo"}`)}))
		}
	}
	request.Subject = &RepositoryJobManualSubject{Source: "github", Kind: "pr", Number: 42}
	_, err = s.RunManual(ctx, "gateway", "token", "review", "wrong-cache", request)
	require.ErrorContains(t, err, "unavailable")
	require.NoError(t, q.UpsertGitHubSyncedIssue(ctx, db.UpsertGitHubSyncedIssueParams{SyncedRepoID: own.ID, Resource: "pulls", Number: 42, GithubID: 901, State: "open", Payload: json.RawMessage(`{"id":901,"number":42,"title":"Verified PR","head":{"sha":"candidate"},"base":{"sha":"parent"}}`)}))
	require.NoError(t, q.UpsertGitHubSyncedIssue(ctx, db.UpsertGitHubSyncedIssueParams{SyncedRepoID: own.ID, Resource: "issues", Number: 42, GithubID: 902, State: "open", Payload: json.RawMessage(`{"id":902,"number":42,"pull_request":{"url":"https://api.github.com/pulls/42"}}`)}))
	github, err := s.RunManual(ctx, "gateway", "token", "review", "github-pr", request)
	require.NoError(t, err)
	payload = readPayload(github.DispatchID)
	require.Equal(t, "Verified PR", decodeObject(payload["pull_request"])["title"])
	require.Equal(t, own.OwnerLogin+"/"+own.RepoName, decodeObject(payload["repository"])["full_name"])
	request.Subject.Kind = "issue"
	_, err = s.RunManual(ctx, "gateway", "token", "review", "pr-as-issue", request)
	require.ErrorContains(t, err, "pull request")
	request.Subject.Number = 43
	require.NoError(t, q.UpsertGitHubSyncedIssue(ctx, db.UpsertGitHubSyncedIssueParams{SyncedRepoID: own.ID, Resource: "issues", Number: 43, GithubID: 903, State: "open", Payload: json.RawMessage(`{"id":903,"number":44}`)}))
	_, err = s.RunManual(ctx, "gateway", "token", "review", "bad-cache-identity", request)
	require.ErrorContains(t, err, "refreshed")
}

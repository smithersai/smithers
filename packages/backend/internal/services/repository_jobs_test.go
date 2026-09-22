package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
	"github.com/stretchr/testify/require"
)

func repositoryJobTestInput() RegisterRepositoryJobInput {
	return RegisterRepositoryJobInput{Repo: "owner/repo", WorkspaceID: uuid.NewString(), FlowID: "repository-jobs/issues",
		Revision: 1, Digest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), ExecutionDigest: strings.Repeat("c", 64),
		Envelope: json.RawMessage(`{"capabilities":["read","write"],"flows":["repository-jobs/issues"],"budget":{"tokens":12000,"milliseconds":600000}}`),
		Mode:     "enabled", Events: []RepositoryJobEventRule{{Type: "issues", Actions: []string{"opened", "edited"}}, {Type: "issue_comment", Actions: []string{"created"}}},
		Input: json.RawMessage(`{"steps":[{"id":"triage","mode":"automatic"}],"scope":"future"}`)}
}

func TestRepositoryJobValidation(t *testing.T) {
	t.Parallel()
	for name, edit := range map[string]func(*RegisterRepositoryJobInput){
		"workspace":  func(i *RegisterRepositoryJobInput) { i.WorkspaceID = "other" },
		"source":     func(i *RegisterRepositoryJobInput) { i.SourceRevision = "main" },
		"candidate":  func(i *RegisterRepositoryJobInput) { i.Digest = "approved" },
		"executable": func(i *RegisterRepositoryJobInput) { i.ExecutionDigest = "current" },
		"unlimited": func(i *RegisterRepositoryJobInput) {
			i.Envelope = json.RawMessage(`{"capabilities":[],"flows":[],"budget":{}}`)
		},
		"trial source":   func(i *RegisterRepositoryJobInput) { i.Mode = "trial"; i.TrialIssueNumber = 1 },
		"trial wildcard": func(i *RegisterRepositoryJobInput) { i.Mode = "trial"; i.TrialSource = "github" },
		"trial cron": func(i *RegisterRepositoryJobInput) {
			i.Mode = "trial"
			i.TrialSource = "github"
			i.TrialIssueNumber = 1
			i.Schedule = "0 0 * * *"
		},
		"enabled trial scope": func(i *RegisterRepositoryJobInput) { i.TrialIssueNumber = 1 },
		"unsupported event":   func(i *RegisterRepositoryJobInput) { i.Events = []RepositoryJobEventRule{{Type: "installation"}} },
		"cron timezone":       func(i *RegisterRepositoryJobInput) { i.Schedule = "CRON_TZ=America/Los_Angeles 0 0 * * *" },
	} {
		t.Run(name, func(t *testing.T) {
			input := repositoryJobTestInput()
			edit(&input)
			_, err := validateRepositoryJob("issues", input, time.Now())
			require.Error(t, err)
		})
	}
	input := repositoryJobTestInput()
	_, err := validateRepositoryJob("issues", input, time.Now())
	require.NoError(t, err)
	input.Schedule = "0 9 * * *"
	next, err := validateRepositoryJob("chores", input, time.Date(2026, 9, 16, 10, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Equal(t, time.Date(2026, 9, 17, 9, 0, 0, 0, time.UTC), next.Time)
	input.Schedule = "CRON_TZ=America/Los_Angeles 0 9 * * *"
	_, err = validateRepositoryJob("chores", input, time.Now())
	require.ErrorContains(t, err, "UTC")
	input.Mode = "trial"
	input.Schedule = ""
	input.TrialIssueNumber = 7
	input.TrialSource = "smithers-cloud"
	_, err = validateRepositoryJob("issues", input, time.Now())
	require.NoError(t, err)
}

func TestRepositoryJobEventMatching(t *testing.T) {
	t.Parallel()
	input := repositoryJobTestInput()
	event := db.RepositoryJobEvent{EventType: "issue", EventAction: "opened", Payload: json.RawMessage(`{"issue":{"labels":[{"name":"auto"}]}}`)}
	require.True(t, repositoryJobMatches(input, event))
	input.Events = nil
	require.False(t, repositoryJobMatches(input, event))
	input = repositoryJobTestInput()
	input.Label = "auto"
	require.True(t, repositoryJobMatches(input, event))
	input.Label = "other"
	require.False(t, repositoryJobMatches(input, event))
	input.Mode = "trial"
	require.True(t, repositoryJobMatches(input, event))
	event.EventAction = "closed"
	require.False(t, repositoryJobMatches(input, event))
}

func TestRepositoryJobTrialAuthorityComesFromRegistration(t *testing.T) {
	t.Parallel()
	claim := db.RepositoryJobDispatch{Source: "smithers-cloud", IssueNumber: 12, Payload: json.RawMessage(`{"trial":true}`)}
	registration := db.RepositoryJobRegistration{Mode: "enabled", TrialSource: "smithers-cloud", TrialIssueNumber: 12}
	require.NotContains(t, repositoryJobDispatchEvent(registration, claim), "trial")
	registration.Mode = "trial"
	require.Equal(t, true, repositoryJobDispatchEvent(registration, claim)["trial"])
	claim.Source = "github"
	require.NotContains(t, repositoryJobDispatchEvent(registration, claim), "trial")
	claim.Source = "smithers-cloud"
	claim.IssueNumber = 13
	require.NotContains(t, repositoryJobDispatchEvent(registration, claim), "trial")
}

func TestRepositoryJobRPCTransport(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer server-held", r.Header.Get("Authorization"))
		var frame struct {
			Tag       string          `json:"_tag"`
			ID        int             `json:"id"`
			Procedure string          `json:"tag"`
			Payload   json.RawMessage `json:"payload"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&frame))
		require.Equal(t, "Request", frame.Tag)
		require.Equal(t, 1, frame.ID)
		if frame.Procedure == "Signal" {
			fmt.Fprintln(w, `{"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"/control/NoMatchingWait","message":"private details"}}]}}`)
			return
		}
		require.Equal(t, "Plan", frame.Procedure)
		require.JSONEq(t, `{"flowId":"repository-jobs/issues"}`, string(frame.Payload))
		fmt.Fprintln(w, `{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{"planId":"p"}}}`)
	}))
	defer server.Close()
	body, err := callRepositoryJobRPC(context.Background(), server.Client(), server.URL, "server-held", "Plan", json.RawMessage(`{"flowId":"repository-jobs/issues"}`))
	require.NoError(t, err)
	require.JSONEq(t, `{"planId":"p"}`, string(body))
	_, err = callRepositoryJobRPC(context.Background(), server.Client(), server.URL, "server-held", "Signal", json.RawMessage(`{}`))
	var rpcErr *RepositoryJobRPCError
	require.ErrorAs(t, err, &rpcErr)
	require.Equal(t, "/control/NoMatchingWait", rpcErr.Tag)
	require.NotContains(t, err.Error(), "private")
}

type repositoryJobTestGateway struct {
	t               *testing.T
	target          RepoGatewayRelayTarget
	config          RegisterRepositoryJobInput
	calls           []string
	inputs          []json.RawMessage
	runs            map[string]string
	dropRunOnce     bool
	dropSignalOnce  bool
	lostSignalOnce  bool
	rejectedSignals map[string]bool
	signalKeys      []string
	executionDigest string
}

func (g *repositoryJobTestGateway) AuthorizeRelay(_ context.Context, id, bearer string) (RepoGatewayRelayTarget, error) {
	if id != "gateway" || bearer != "token" {
		return RepoGatewayRelayTarget{}, fmt.Errorf("unauthorized fixture")
	}
	return g.target, nil
}
func (g *repositoryJobTestGateway) CallRepositoryJob(_ context.Context, connection RepoGatewayConnectionInput, capability string, procedure string, body json.RawMessage) (json.RawMessage, error) {
	if capability != repositoryJobsCapability {
		return nil, fmt.Errorf("repository jobs must ask for %s, not %s", repositoryJobsCapability, capability)
	}
	require.Equal(g.t, g.target.RepositoryID, connection.RepositoryID)
	require.Equal(g.t, g.target.UserID, connection.UserID)
	require.Equal(g.t, g.target.WorkspaceID, connection.WorkspaceID)
	g.calls = append(g.calls, procedure)
	var input map[string]json.RawMessage
	require.NoError(g.t, json.Unmarshal(body, &input))
	var key string
	_ = json.Unmarshal(input["idempotencyKey"], &key)
	switch procedure {
	case "Plan":
		g.inputs = append(g.inputs, input["input"])
		digest := g.config.ExecutionDigest
		if g.executionDigest != "" {
			digest = g.executionDigest
		}
		planID := "plan-" + key
		target := map[string]any{"_tag": "Plan", "planId": planID, "digest": "plan-digest", "envelope": g.config.Envelope}
		result, _ := json.Marshal(map[string]any{"planId": planID, "flowId": g.config.FlowID, "digest": "plan-digest", "executionDigest": digest, "envelope": g.config.Envelope, "approval": map[string]any{"target": target, "scope": "once", "idempotencyKey": key + ":approve"}})
		return result, nil
	case "Approval.Submit":
		var target map[string]any
		require.NoError(g.t, json.Unmarshal(input["target"], &target))
		require.Equal(g.t, "Plan", target["_tag"])
		return json.RawMessage(`{"_tag":"Recorded"}`), nil
	case "Run":
		if g.runs == nil {
			g.runs = map[string]string{}
		}
		runID, exists := g.runs[key]
		if !exists {
			runID = "run-" + uuid.NewString()
			g.runs[key] = runID
		}
		if g.dropRunOnce {
			g.dropRunOnce = false
			return nil, fmt.Errorf("connection interrupted after Run accepted")
		}
		tag := "Accepted"
		if exists {
			tag = "AlreadyApplied"
		}
		result, _ := json.Marshal(map[string]any{"_tag": tag, "runId": runID})
		return result, nil
	case "List":
		var filters map[string]string
		require.NoError(g.t, json.Unmarshal(input["filters"], &filters))
		result, _ := json.Marshal(map[string]any{"items": []map[string]string{{"runId": filters["runId"], "status": "waiting"}}})
		return result, nil
	case "Signal":
		g.signalKeys = append(g.signalKeys, key)
		var signal map[string]json.RawMessage
		require.NoError(g.t, json.Unmarshal(input["signal"], &signal))
		require.JSONEq(g.t, `"repository-job.author-reply"`, string(signal["name"]))
		if g.rejectedSignals[key] {
			return nil, &RepositoryJobRPCError{Tag: "/control/NoMatchingWait"}
		}
		if g.dropSignalOnce {
			g.dropSignalOnce = false
			if g.rejectedSignals == nil {
				g.rejectedSignals = map[string]bool{}
			}
			g.rejectedSignals[key] = true
			return nil, &RepositoryJobRPCError{Tag: "/control/NoMatchingWait"}
		}
		if g.lostSignalOnce {
			g.lostSignalOnce = false
			return nil, fmt.Errorf("lost Signal acknowledgement")
		}
		return json.RawMessage(`{"_tag":"Accepted"}`), nil
	}
	return nil, fmt.Errorf("unexpected procedure %s", procedure)
}

func repositoryJobFixture(t *testing.T) (*pgxpool.Pool, *deploymentdb.Queries, *RepositoryJobService, *repositoryJobTestGateway, RegisterRepositoryJobInput) {
	t.Helper()
	pool := getAgentTestPool(t)
	q := deploymentdb.New(pool)
	uid, rid := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	t.Cleanup(func() {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(ctx) }()
		token := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
		_, err = tx.Exec(ctx, `
			INSERT INTO repository_storage_operations (
				repository_id, operation_type, token, storage_route_key,
				source_owner, source_repo, source_user_id
			)
			SELECT r.id, 'delete', $2, 'static', u.username, r.name, r.user_id
			FROM repositories r JOIN users u ON u.id = r.user_id WHERE r.id = $1
		`, rid, token)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `DELETE FROM repositories WHERE id=$1`, rid)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `DELETE FROM repository_storage_operations WHERE repository_id=$1`, rid)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `DELETE FROM users WHERE id=$1`, uid)
		require.NoError(t, err)
		require.NoError(t, tx.Commit(ctx))
	})
	input := repositoryJobTestInput()
	var owner, name string
	require.NoError(t, pool.QueryRow(ctx, `SELECT u.username,r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, rid).Scan(&owner, &name))
	input.Repo = owner + "/" + name
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, input.WorkspaceID, rid, uid)
	require.NoError(t, err)
	gateway := &repositoryJobTestGateway{t: t, config: input, target: RepoGatewayRelayTarget{RepositoryID: rid, UserID: uid, WorkspaceID: input.WorkspaceID}}
	return pool, q, NewRepositoryJobService(q, gateway, pool), gateway, input
}

func repositoryJobAdmit(t *testing.T, s *RepositoryJobService, repo int64, delivery string, number int64, kind, action string) {
	t.Helper()
	comment := ""
	if kind == "issue_comment" {
		comment = `,"comment":{"id":91,"body":"more information","user":{"login":"author"}}`
	}
	body := json.RawMessage(fmt.Sprintf(`{"action":%q,"issue":{"id":100,"number":%d,"user":{"login":"author"}}%s}`, action, number, comment))
	require.NoError(t, s.AdmitGitHubEvent(context.Background(), repo, db.GithubWebhookJob{DeliveryID: delivery, Payload: body}, TriggerEvent{Type: kind, Action: action}))
}

func TestRepositoryJobsIntegrationTrialIsolationAndPause(t *testing.T) {
	_, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	repositoryJobAdmit(t, s, g.target.RepositoryID, "early-trial", 12, "issues", "opened")
	repositoryJobAdmit(t, s, g.target.RepositoryID, "unrelated", 13, "issues", "opened")
	rows, err := q.ListRepositoryJobAdmissions(ctx, 100)
	require.NoError(t, err)
	require.Empty(t, rows, "no opt-in means no admission")
	input.Mode = "trial"
	input.TrialSource = "github"
	input.TrialIssueNumber = 12
	reg, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	retry, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	require.Equal(t, reg.ID, retry.ID)
	require.NoError(t, s.PollOnce(ctx))
	dispatches, err := s.Dispatches(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	require.Len(t, dispatches, 1)
	require.Equal(t, int64(12), dispatches[0].IssueNumber)
	require.Equal(t, "submitted", dispatches[0].Status)
	var trialInput struct {
		Event struct{ Trial bool } `json:"event"`
	}
	require.Len(t, g.inputs, 1)
	require.NoError(t, json.Unmarshal(g.inputs[0], &trialInput))
	require.True(t, trialInput.Event.Trial)
	input.Mode = "enabled"
	input.TrialSource = ""
	input.TrialIssueNumber = 0
	enabled, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	trial, err := q.GetRepositoryJobRegistration(ctx, reg.ID)
	require.NoError(t, err)
	require.False(t, trial.Enabled)
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.runs, 1, "old unrelated issue must not backfill")
	_, err = s.Pause(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.ErrorContains(t, err, "paused")
	repositoryJobAdmit(t, s, g.target.RepositoryID, "after-pause", 14, "issues", "opened")
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.runs, 1)
	input.Revision = 2
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	stale := input
	stale.Revision = 1
	_, err = s.Register(ctx, "gateway", "token", "issues", stale)
	require.Error(t, err)
	current, err := q.GetRepositoryJobRegistration(ctx, enabled.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), current.Revision)
}

func TestRepositoryJobsIntegrationLostRunReplyRetryAndAuthority(t *testing.T) {
	pool, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	g.dropRunOnce = true
	reg, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	repositoryJobAdmit(t, s, g.target.RepositoryID, "signed-event", 7, "issues", "opened")
	repositoryJobAdmit(t, s, g.target.RepositoryID, "signed-event", 7, "issues", "opened")
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.runs, 1)
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id=$1`, reg.ID)
	require.NoError(t, err)
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.inputs, 1, "persisted plan reused after transport failure")
	require.Len(t, g.runs, 1)
	dispatches, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: g.target.RepositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Len(t, dispatches, 1)
	require.Equal(t, "submitted", dispatches[0].Status)
	var runInput struct {
		Job, SourceRevision, Digest string
		Event                       struct {
			Source, DeliveryKey string
			IssueNumber         int64
			Payload             json.RawMessage
		}
	}
	require.NoError(t, json.Unmarshal(g.inputs[0], &runInput))
	require.Equal(t, "issues", runInput.Job)
	require.Equal(t, "github", runInput.Event.Source)
	require.Equal(t, "github:signed-event", runInput.Event.DeliveryKey)
	require.Equal(t, input.SourceRevision, runInput.SourceRevision)
	g.dropSignalOnce = true
	repositoryJobAdmit(t, s, g.target.RepositoryID, "signed-reply", 7, "issue_comment", "created")
	require.NoError(t, s.PollOnce(ctx))
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id=$1`, reg.ID)
	require.NoError(t, err)
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.signalKeys, 2)
	require.NotEqual(t, g.signalKeys[0], g.signalKeys[1], "definitive rejection requires a new persisted attempt key")
	require.Len(t, g.runs, 1)
	g.lostSignalOnce = true
	repositoryJobAdmit(t, s, g.target.RepositoryID, "reply-lost-ack", 7, "issue_comment", "created")
	require.NoError(t, s.PollOnce(ctx))
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id=$1`, reg.ID)
	require.NoError(t, err)
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.signalKeys, 4)
	require.Equal(t, g.signalKeys[2], g.signalKeys[3], "ambiguous Signal failure must retain its key")
	g.executionDigest = strings.Repeat("d", 64)
	repositoryJobAdmit(t, s, g.target.RepositoryID, "modified-source", 8, "issues", "opened")
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.runs, 1, "unreviewed descriptor cannot autoapprove")
	dispatches, err = q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: g.target.RepositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Equal(t, "failed", dispatches[0].Status)
	_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, g.target.UserID)
	require.NoError(t, err)
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.Error(t, err)
	priorCalls := len(g.calls)
	repositoryJobAdmit(t, s, g.target.RepositoryID, "revoked-actor", 9, "issues", "opened")
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.calls, priorCalls, "revoked activator cannot launch")
}

func TestRepositoryJobsIntegrationNativeOutboxAndLeaseFence(t *testing.T) {
	pool, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO issues(repository_id,number,title,author_id) VALUES($1,1,'rolled back',$2)`, g.target.RepositoryID, g.target.UserID)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1`, g.target.RepositoryID).Scan(&count))
	require.Zero(t, count)
	var issueID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO issues(repository_id,number,title,author_id) VALUES($1,1,'real native trial',$2) RETURNING id`, g.target.RepositoryID, g.target.UserID).Scan(&issueID))
	input.Mode = "trial"
	input.TrialSource = "smithers-cloud"
	input.TrialIssueNumber = 1
	reg, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	var commentID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO issue_comments(issue_id,user_id,body) VALUES($1,$2,'reply') RETURNING id`, issueID, g.target.UserID).Scan(&commentID))
	_, err = pool.Exec(ctx, `UPDATE issue_comments SET body=body WHERE id=$1`, commentID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1`, g.target.RepositoryID).Scan(&count))
	require.Equal(t, 2, count, "comment count update and unchanged edit emit no extra issue event")
	admissions, err := q.ListRepositoryJobAdmissions(ctx, 100)
	require.NoError(t, err)
	require.Len(t, admissions, 2)
	for _, row := range admissions {
		e := row.RepositoryJobEvent
		require.NoError(t, q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{ID: reg.ID, Revision: 1, DeliveryKey: e.DeliveryKey, Source: e.Source, EventType: e.EventType, EventAction: e.EventAction, IssueNumber: e.IssueNumber, Payload: e.Payload, Status: "queued"}))
	}
	claims, err := q.ClaimRepositoryJobDispatches(ctx, 5)
	require.NoError(t, err)
	require.Len(t, claims, 1, "same issue reply is ordered behind its opening event")
	other, err := q.ClaimRepositoryJobDispatches(ctx, 5)
	require.NoError(t, err)
	require.Empty(t, other)
	_, err = pool.Exec(ctx, `UPDATE repository_job_dispatches SET lease_until=now()-interval '1 second' WHERE id=$1`, claims[0].ID)
	require.NoError(t, err)
	reclaimed, err := q.ClaimRepositoryJobDispatches(ctx, 5)
	require.NoError(t, err)
	require.Len(t, reclaimed, 1)
	n, err := q.SaveRepositoryJobPlan(ctx, db.SaveRepositoryJobPlanParams{ID: claims[0].ID, ClaimToken: claims[0].ClaimToken, Plan: []byte(`{}`)})
	require.NoError(t, err)
	require.Zero(t, n, "stale worker cannot persist a plan")
	require.NoError(t, s.dispatch(ctx, reclaimed[0]))
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.runs, 1)
	rows, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: g.target.RepositoryID, Job: "issues"})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	for _, row := range rows {
		require.Equal(t, "submitted", row.Status)
		require.Equal(t, "smithers-cloud", row.Source)
	}
	_, err = q.GetRepositoryJobRegistration(ctx, uuid.NewString())
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestRepositoryJobsIntegrationScheduleCrashDedup(t *testing.T) {
	pool, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	input.Schedule = "0 9 * * *"
	input.FlowID = "repository-jobs/chores"
	g.config = input
	reg, err := s.Register(ctx, "gateway", "token", "chores", input)
	require.NoError(t, err)
	due := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	_, err = pool.Exec(ctx, `UPDATE repository_job_registrations SET next_fire_at=$2 WHERE id=$1`, reg.ID, due)
	require.NoError(t, err)
	key := "schedule:" + due.Format(time.RFC3339Nano)
	require.NoError(t, q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{ID: reg.ID, Revision: 1, DeliveryKey: key, Source: "schedule", EventType: "schedule", Payload: json.RawMessage(`{}`), Status: "queued"}))
	require.NoError(t, s.enqueueSchedules(ctx))
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.runs, 1)
	rows, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: g.target.RepositoryID, Job: "chores"})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	current, err := q.GetRepositoryJobRegistration(ctx, reg.ID)
	require.NoError(t, err)
	require.True(t, current.NextFireAt.Time.After(time.Now()))
}

func TestRepositoryJobsIntegrationTrialCreationIsAtomicAndIdempotent(t *testing.T) {
	pool, _, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	request := RepositoryJobTrialInput{Repo: input.Repo, WorkspaceID: input.WorkspaceID, Revision: input.Revision, Digest: input.Digest, Title: "Real setup trial", Body: "Reproduce an empty configuration"}
	const attempts = 8
	results := make(chan RepositoryJobTrialResult, attempts)
	failures := make(chan error, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := s.CreateTrial(ctx, "gateway", "token", "issues", "setup-request", request)
			results <- result
			failures <- err
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}
	var first RepositoryJobTrialResult
	for result := range results {
		if first.IssueID == 0 {
			first = result
		}
		require.Equal(t, first, result)
	}
	require.Equal(t, "smithers-cloud", first.Source)
	require.Positive(t, first.Number)
	var issues, events int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issues WHERE repository_id=$1`, g.target.RepositoryID).Scan(&issues))
	require.Equal(t, 1, issues)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1`, g.target.RepositoryID).Scan(&events))
	require.Equal(t, 1, events)
	require.NoError(t, s.PollOnce(ctx))
	require.Empty(t, g.calls, "trial issue must not leak into an existing broad active configuration before trial registration")
	changed := request
	changed.Body = "unreviewed different request"
	_, err = s.CreateTrial(ctx, "gateway", "token", "issues", "setup-request", changed)
	require.ErrorContains(t, err, "different candidate")
	input.Mode = "trial"
	input.TrialSource = "smithers-cloud"
	input.TrialIssueNumber = first.Number
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	require.NoError(t, s.PollOnce(ctx))
	require.Len(t, g.runs, 1)
	bad := request
	bad.WorkspaceID = uuid.NewString()
	_, err = s.CreateTrial(ctx, "gateway", "token", "issues", "new-request", bad)
	require.ErrorContains(t, err, "owning workspace")
}

func TestRepositoryJobsIntegrationGitHubWorkerAdmitsWithoutLegacyDefinition(t *testing.T) {
	_, _, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	job := gitHubIssueEventJob("issues", "opened")
	queries := pushJobQuerier(job)
	queries.listRepositoryIDsForGitHubWebhookJobFn = func(context.Context, db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
		return []int64{g.target.RepositoryID}, nil
	}
	queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) { return nil, nil }
	legacy := &mockGitHubWebhookEventRunDispatcher{}
	worker := NewGitHubWebhookEventWorker(queries, legacy)
	worker.SetRepositoryJobs(s)
	require.NoError(t, worker.PollOnce(ctx))
	require.NoError(t, worker.PollOnce(ctx))
	require.NoError(t, s.PollOnce(ctx))
	require.Empty(t, legacy.calls)
	require.Len(t, g.runs, 1)
	rows, err := s.Dispatches(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "github:"+job.DeliveryID, rows[0].DeliveryKey)
	require.Equal(t, "github", rows[0].Source)
	require.Equal(t, "submitted", rows[0].Status)
}

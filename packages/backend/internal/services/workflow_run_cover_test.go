package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type workflowRunCovMetrics struct {
	calls []struct {
		status  string
		seconds float64
	}
}

func (m *workflowRunCovMetrics) ObserveWorkflowRunCompletion(status string, seconds float64) {
	m.calls = append(m.calls, struct {
		status  string
		seconds float64
	}{status: status, seconds: seconds})
}

type workflowRunCovDispatcher struct {
	calls int
	err   error
}

func (d *workflowRunCovDispatcher) DispatchEvent(context.Context, int64, webhooks.EventType, any) error {
	d.calls++
	return d.err
}

func (d *workflowRunCovDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	return nil
}

func TestWorkflowRun_Cov_OptionsContextsAndDispatchErrors(t *testing.T) {
	ctx := context.Background()

	t.Run("options wire metrics and billing", func(t *testing.T) {
		metrics := &workflowRunCovMetrics{}
		billing := &stubBillingPolicy{}
		svc := NewWorkflowRunService(&mockWorkflowRunQuerier{}, WithWorkflowRunMetrics(metrics), WithWorkflowRunBillingPolicy(billing)).(*workflowRunService)
		assert.Same(t, metrics, svc.metrics)
		assert.Same(t, billing, svc.billing)
	})

	t.Run("check run and commit status names fall back predictably", func(t *testing.T) {
		assert.Equal(t, "smithers / workflow", workflowCheckRunName(db.WorkflowDefinition{}))
		assert.Equal(t, "smithers/ci", workflowCommitStatusContext(" ci ", ".smithers/workflows/ignored.tsx"))
		assert.Equal(t, "smithers/build", workflowCommitStatusContext(" ", ".smithers/workflows/build.tsx"))
		assert.Equal(t, "smithers/workflow", workflowCommitStatusContext("", ".tsx"))
	})

	t.Run("pending commit status can be keyed by change id without sha", func(t *testing.T) {
		params := pendingWorkflowCommitStatusParams(DispatchForEventInput{
			RepositoryID: 77,
			Event:        TriggerEvent{ChangeID: " change-123 "},
		}, db.WorkflowDefinition{Path: ".smithers/workflows/build.tsx"}, 99)

		assert.Equal(t, int64(77), params.RepositoryID)
		assert.False(t, params.CommitSha.Valid)
		assert.True(t, params.ChangeID.Valid)
		assert.Equal(t, "change-123", params.ChangeID.String)
		assert.Equal(t, "smithers/build", params.Context)
		assert.Equal(t, int64(99), params.WorkflowRunID.Int64)
	})

	t.Run("pending commit status normalizes commit sha", func(t *testing.T) {
		params := pendingWorkflowCommitStatusParams(
			DispatchForEventInput{RepositoryID: 77, Event: TriggerEvent{CommitSHA: " abc123 "}},
			db.WorkflowDefinition{Name: "ci"},
			99,
		)
		assert.True(t, params.CommitSha.Valid)
		assert.Equal(t, "abc123", params.CommitSha.String)
		assert.False(t, params.ChangeID.Valid)
	})

	t.Run("workflow_run dispatcher error is returned to caller", func(t *testing.T) {
		dispatcher := &workflowRunCovDispatcher{err: errors.New("queue down")}
		svc := NewWorkflowRunService(&mockWorkflowRunQuerier{}, WithWorkflowRunWebhookDispatcher(dispatcher)).(*workflowRunService)
		err := svc.dispatchWorkflowRunEvent(ctx, db.WorkflowRun{ID: 9, Status: "queued", TriggerEvent: "push"}, 77)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "workflow_run")
		assert.Equal(t, 1, dispatcher.calls)
	})
}

func TestWorkflowRun_Cov_CheckRunBranches(t *testing.T) {
	ctx := context.Background()
	def := makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}}}`)
	repo := db.Repository{ID: 42, Name: "Demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}

	t.Run("skips invalid statuses blank sha and missing owner", func(t *testing.T) {
		checks := &mockWorkflowRunCheckRunService{}
		svc := NewWorkflowRunService(&mockWorkflowRunQuerier{}, WithWorkflowRunGitHubCheckRunService(checks)).(*workflowRunService)
		svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 1, Status: "success", TriggerCommitSha: "abc"}, def, repo, "alice")
		svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 2, Status: "queued"}, def, repo, "alice")
		svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 3, Status: "queued", TriggerCommitSha: "abc"}, def, db.Repository{ID: 42, Name: "demo"}, "")
		assert.Empty(t, checks.postCalls)
	})

	t.Run("post errors do not persist metadata", func(t *testing.T) {
		q := &mockWorkflowRunQuerier{}
		checks := &mockWorkflowRunCheckRunService{
			postFn: func(context.Context, int64, string, string, GitHubCheckRunInput) (GitHubCheckRunResult, error) {
				return GitHubCheckRunResult{}, errors.New("github down")
			},
		}
		svc := NewWorkflowRunService(q, WithWorkflowRunGitHubCheckRunService(checks), WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
			resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
				return 12, nil
			},
		})).(*workflowRunService)
		svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 3, Status: "queued", TriggerCommitSha: "abc"}, def, repo, "Alice")
		require.Len(t, checks.postCalls, 1)
		assert.Empty(t, q.updateCheckRunCalls)
	})

	t.Run("persists API URL when HTML URL is absent", func(t *testing.T) {
		q := &mockWorkflowRunQuerier{}
		checks := &mockWorkflowRunCheckRunService{
			postFn: func(context.Context, int64, string, string, GitHubCheckRunInput) (GitHubCheckRunResult, error) {
				return GitHubCheckRunResult{URL: "https://api.github/check-runs/5"}, nil
			},
		}
		svc := NewWorkflowRunService(q, WithWorkflowRunGitHubCheckRunService(checks), WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
			resolveFn: func(_ context.Context, ownerUserID, ownerOrgID int64, owner, repo string) (int64, error) {
				assert.Equal(t, int64(7), ownerUserID)
				assert.Equal(t, int64(0), ownerOrgID)
				assert.Equal(t, "Alice", owner)
				assert.Equal(t, "Demo", repo)
				return 12, nil
			},
		})).(*workflowRunService)
		svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 3, Status: "running", TriggerCommitSha: "abc"}, def, repo, "Alice")
		require.Len(t, q.updateCheckRunCalls, 1)
		assert.False(t, q.updateCheckRunCalls[0].CheckRunID.Valid)
		assert.Equal(t, "https://api.github/check-runs/5", q.updateCheckRunCalls[0].CheckRunUrl.String)
		assert.True(t, q.updateCheckRunCalls[0].CheckRunUrl.Valid)
	})

	t.Run("metadata update errors are logged after posting", func(t *testing.T) {
		q := &mockWorkflowRunQuerier{
			updateCheckRunFn: func(context.Context, db.UpdateWorkflowRunCheckRunParams) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, errors.New("update failed")
			},
		}
		checks := &mockWorkflowRunCheckRunService{}
		svc := NewWorkflowRunService(q, WithWorkflowRunGitHubCheckRunService(checks), WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
			resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
				return 12, nil
			},
		})).(*workflowRunService)
		svc.createInProgressCheckRun(ctx, db.WorkflowRun{ID: 3, Status: "queued", TriggerCommitSha: "abc"}, def, repo, "alice")
		assert.Len(t, checks.postCalls, 1)
		assert.Len(t, q.updateCheckRunCalls, 1)
	})
}

func TestWorkflowRun_Cov_RepositoryResolutionCancelAndRerunErrors(t *testing.T) {
	ctx := context.Background()

	t.Run("repository and owner resolution map errors", func(t *testing.T) {
		svc := NewWorkflowRunService(&mockWorkflowRunQuerier{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{}, pgx.ErrNoRows
			},
		}).(*workflowRunService)
		_, err := svc.resolveRunRepository(ctx, 42)
		assert.Equal(t, 404, workflowRunAPIStatus(t, err))

		svc = NewWorkflowRunService(&mockWorkflowRunQuerier{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{}, errors.New("db failed")
			},
		}).(*workflowRunService)
		_, err = svc.resolveRunRepository(ctx, 42)
		assert.Equal(t, 500, workflowRunAPIStatus(t, err))

		svc = NewWorkflowRunService(&mockWorkflowRunQuerier{
			getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
				return db.Organization{ID: 9, Name: "Acme"}, nil
			},
		}).(*workflowRunService)
		assert.Equal(t, "Acme", svc.resolveRepoOwner(ctx, db.Repository{OrgID: pgtype.Int8{Int64: 9, Valid: true}}))

		svc = NewWorkflowRunService(&mockWorkflowRunQuerier{
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return db.User{}, errors.New("missing user")
			},
			getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
				return db.Organization{}, errors.New("missing org")
			},
		}).(*workflowRunService)
		assert.Empty(t, svc.resolveRepoOwner(ctx, db.Repository{UserID: pgtype.Int8{Int64: 7, Valid: true}}))
		assert.Empty(t, svc.resolveRepoOwner(ctx, db.Repository{OrgID: pgtype.Int8{Int64: 9, Valid: true}}))
		assert.Empty(t, svc.resolveRepoOwner(ctx, db.Repository{}))
	})

	t.Run("dispatch maps token storage failure", func(t *testing.T) {
		q := &mockWorkflowRunQuerier{
			listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
				return []db.WorkflowDefinition{
					makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
				}, nil
			},
			updateTokenFn: func(context.Context, db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, errors.New("token write failed")
			},
		}
		_, err := NewWorkflowRunService(q).DispatchForEvent(ctx, DispatchForEventInput{
			RepositoryID: 42,
			Event:        TriggerEvent{Type: "push", Ref: "main"},
		})
		assert.Equal(t, 500, workflowRunAPIStatus(t, err))
	})

	t.Run("cancel maps task cancellation failure and records metrics", func(t *testing.T) {
		q := &mockWorkflowRunQuerier{
			getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
				return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "running"}, nil
			},
			cancelTaskFn: func(context.Context, int64) error {
				return errors.New("task cancel failed")
			},
		}
		err := NewWorkflowRunService(q).CancelRun(ctx, 42, 7)
		assert.Equal(t, 500, workflowRunAPIStatus(t, err))

		metrics := &workflowRunCovMetrics{}
		q.cancelTaskFn = nil
		err = NewWorkflowRunService(q, WithWorkflowRunMetrics(metrics)).CancelRun(ctx, 42, 7)
		require.NoError(t, err)
		require.Len(t, metrics.calls, 1)
		assert.Equal(t, "cancelled", metrics.calls[0].status)
	})

	t.Run("complete cancellation check run branches", func(t *testing.T) {
		checks := &mockWorkflowRunCheckRunService{}
		svc := NewWorkflowRunService(&mockWorkflowRunQuerier{}, WithWorkflowRunGitHubCheckRunService(checks)).(*workflowRunService)
		require.NoError(t, svc.completeGitHubCheckRunForCancellation(ctx, db.WorkflowRun{ID: 7, RepositoryID: 42}))
		assert.Empty(t, checks.updateCalls)

		q := &mockWorkflowRunQuerier{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{ID: 42, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
			},
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return db.User{ID: 1, Username: "alice"}, nil
			},
		}
		svc = NewWorkflowRunService(q, WithWorkflowRunGitHubCheckRunService(checks), WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
			resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
				return 0, errors.New("not installed")
			},
		})).(*workflowRunService)
		require.NoError(t, svc.completeGitHubCheckRunForCancellation(ctx, db.WorkflowRun{
			ID: 7, RepositoryID: 42, CheckRunID: pgtype.Int8{Int64: 123, Valid: true},
		}))

		checks = &mockWorkflowRunCheckRunService{
			updateFn: func(context.Context, int64, string, string, int64, GitHubCheckRunUpdate) (GitHubCheckRunResult, error) {
				return GitHubCheckRunResult{}, errors.New("github update failed")
			},
		}
		q = &mockWorkflowRunQuerier{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{ID: 42, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
			},
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return db.User{ID: 1, Username: "alice"}, nil
			},
		}
		svc = NewWorkflowRunService(q, WithWorkflowRunGitHubCheckRunService(checks), WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
			resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
				return 99, nil
			},
		})).(*workflowRunService)
		err := svc.completeGitHubCheckRunForCancellation(ctx, db.WorkflowRun{
			ID: 7, RepositoryID: 42, CheckRunID: pgtype.Int8{Int64: 123, Valid: true},
		})
		require.Error(t, err)
		assert.True(t, strings.Contains(err.Error(), "github update failed"))
	})
}

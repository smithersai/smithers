package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workflowDefinitionCommitLoadCall struct {
	repositoryID int64
	commitSHA    string
}

type recordingWorkflowDefinitionCommitLoader struct {
	result WorkflowLoadResult
	err    error
	calls  []workflowDefinitionCommitLoadCall
}

type recordingWorkflowBookmarkCommitResolver struct {
	commit string
	err    error
	calls  []struct {
		repositoryID int64
		bookmark     string
	}
}

func (r *recordingWorkflowBookmarkCommitResolver) ResolveBookmarkCommit(_ context.Context, repositoryID int64, bookmark string) (string, error) {
	r.calls = append(r.calls, struct {
		repositoryID int64
		bookmark     string
	}{repositoryID: repositoryID, bookmark: bookmark})
	return r.commit, r.err
}

func (l *recordingWorkflowDefinitionCommitLoader) LoadDefinitionsFromCommit(
	_ context.Context,
	repositoryID int64,
	commitSHA string,
) (WorkflowLoadResult, error) {
	l.calls = append(l.calls, workflowDefinitionCommitLoadCall{
		repositoryID: repositoryID,
		commitSHA:    commitSHA,
	})
	return l.result, l.err
}

func workflowLoadResultForPath(path, config string) WorkflowLoadResult {
	return WorkflowLoadResult{Definitions: []LoadedWorkflowDefinition{{
		Name:   workflowNameFromPath(path),
		Path:   path,
		Config: json.RawMessage(config),
	}}}
}

func TestWorkflowRunService_AlertRemediationIgnoresStalePersistedDefinitionConfig(t *testing.T) {
	t.Parallel()

	const repositoryID int64 = 42
	definitionID := int64(7)
	exactCommit := strings.Repeat("b", 40)
	workflowPath := ".smithers/workflows/remediate.tsx"

	// Simulate an out-of-order sync that left an inactive, unrelated config in
	// the database. Neither its activity bit nor its trigger/job graph may decide
	// what runs for a checkout pinned to exactCommit.
	mock := &mockWorkflowRunQuerier{
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(
				definitionID,
				repositoryID,
				"remediate",
				false,
				`{"on":{"push":{}},"jobs":{"stale-job":{"secrets":["STALE_SECRET"]}}}`,
			), nil
		},
	}
	resolver := &recordingWorkflowBookmarkCommitResolver{commit: exactCommit}
	loader := &recordingWorkflowDefinitionCommitLoader{
		result: workflowLoadResultForPath(
			workflowPath,
			`{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"propose":{"secrets":[]},"publish":{"needs":["propose"],"secrets":["GITHUB_TOKEN"]}}}`,
		),
	}
	svc := NewWorkflowRunService(mock,
		WithWorkflowRunDefinitionCommitLoader(loader),
		WithWorkflowRunBookmarkCommitResolver(resolver),
	)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         repositoryID,
		WorkflowDefinitionID: &definitionID,
		Event:                TriggerEvent{Type: AlertRemediationTriggerEvent, Action: "opened"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, resolver.calls, 1)
	assert.Equal(t, repositoryID, resolver.calls[0].repositoryID)
	assert.Equal(t, "main", resolver.calls[0].bookmark)
	require.Equal(t, []workflowDefinitionCommitLoadCall{{repositoryID: repositoryID, commitSHA: exactCommit}}, loader.calls)
	require.Len(t, mock.createRunCalls, 1)
	assert.Equal(t, exactCommit, mock.createRunCalls[0].TriggerCommitSha)

	createdJobs := make(map[string]struct{}, len(mock.createTaskCalls))
	for _, call := range mock.createTaskCalls {
		var payload struct {
			Job string `json:"job"`
		}
		require.NoError(t, json.Unmarshal(call.Payload, &payload))
		createdJobs[payload.Job] = struct{}{}
	}
	assert.Equal(t, map[string]struct{}{"propose": {}, "publish": {}}, createdJobs)
	assert.NotContains(t, createdJobs, "stale-job")
}

func TestWorkflowRunService_AlertRemediationFailsClosedWhenPersistedDefinitionIsAbsentFromCommit(t *testing.T) {
	t.Parallel()

	definitionID := int64(7)
	exactCommit := strings.Repeat("d", 40)
	mock := &mockWorkflowRunQuerier{
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(
				definitionID,
				42,
				"remediate",
				true,
				`{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"stale-job":{}}}`,
			), nil
		},
	}
	resolver := &recordingWorkflowBookmarkCommitResolver{commit: exactCommit}
	loader := &recordingWorkflowDefinitionCommitLoader{
		// The persisted row came from another generation. The immutable checkout
		// contains a different workflow, so dispatch must create no durable rows.
		result: workflowLoadResultForPath(
			".smithers/workflows/other.tsx",
			`{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"other":{}}}`,
		),
	}

	_, err := NewWorkflowRunService(mock,
		WithWorkflowRunDefinitionCommitLoader(loader),
		WithWorkflowRunBookmarkCommitResolver(resolver),
	).DispatchForEvent(
		context.Background(),
		DispatchForEventInput{
			RepositoryID:         42,
			WorkflowDefinitionID: &definitionID,
			Event:                TriggerEvent{Type: AlertRemediationTriggerEvent},
		},
	)
	require.ErrorContains(t, err, "absent at immutable base revision")
	assert.Equal(t, 422, workflowRunAPIStatus(t, err))
	require.Equal(t, []workflowDefinitionCommitLoadCall{{repositoryID: 42, commitSHA: exactCommit}}, loader.calls)
	assert.Empty(t, mock.createRunCalls)
	assert.Empty(t, mock.createStepCalls)
	assert.Empty(t, mock.createTaskCalls)
}

func TestWorkflowRunService_AlertRemediationRechecksTriggerFromImmutableCommit(t *testing.T) {
	t.Parallel()

	definitionID := int64(7)
	exactCommit := strings.Repeat("e", 40)
	mock := &mockWorkflowRunQuerier{
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(
				definitionID,
				42,
				"remediate",
				true,
				`{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"stale-job":{}}}`,
			), nil
		},
	}
	resolver := &recordingWorkflowBookmarkCommitResolver{commit: exactCommit}
	loader := &recordingWorkflowDefinitionCommitLoader{
		result: workflowLoadResultForPath(
			".smithers/workflows/remediate.tsx",
			`{"on":{"push":{}},"jobs":{"must-not-run":{}}}`,
		),
	}

	_, err := NewWorkflowRunService(mock,
		WithWorkflowRunDefinitionCommitLoader(loader),
		WithWorkflowRunBookmarkCommitResolver(resolver),
	).DispatchForEvent(
		context.Background(),
		DispatchForEventInput{
			RepositoryID:         42,
			WorkflowDefinitionID: &definitionID,
			Event:                TriggerEvent{Type: AlertRemediationTriggerEvent},
		},
	)
	require.ErrorContains(t, err, "does not declare the alert remediation trigger")
	assert.Equal(t, 422, workflowRunAPIStatus(t, err))
	assert.Empty(t, mock.createRunCalls)
	assert.Empty(t, mock.createTaskCalls)
}

func TestWorkflowRunService_AlertRemediationFailsClosedWithoutCommitDefinitionLoader(t *testing.T) {
	t.Parallel()

	definitionID := int64(7)
	mock := &mockWorkflowRunQuerier{
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(
				definitionID,
				42,
				"remediate",
				true,
				`{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"fix":{}}}`,
			), nil
		},
	}

	_, err := NewWorkflowRunService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         42,
		WorkflowDefinitionID: &definitionID,
		Event: TriggerEvent{
			Type:      AlertRemediationTriggerEvent,
			CommitSHA: strings.Repeat("f", 40),
		},
	})
	require.ErrorContains(t, err, "commit-scoped workflow loader unavailable")
	assert.Empty(t, mock.createRunCalls)
}

package configsync

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type mockRepoHost struct {
	listFilesAtChangeFn func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error)
	getFileAtChangeFn   func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

func (m *mockRepoHost) ListFilesAtChange(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
	if m.listFilesAtChangeFn != nil {
		return m.listFilesAtChangeFn(ctx, owner, repo, changeID, prefix)
	}
	return nil, nil
}

func (m *mockRepoHost) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	if m.getFileAtChangeFn != nil {
		return m.getFileAtChangeFn(ctx, owner, repo, changeID, path)
	}
	return repohost.FileContent{}, nil
}

type mockAuditLogger struct {
	events []services.AuditEvent
}

func (m *mockAuditLogger) Log(ctx context.Context, event services.AuditEvent) {
	m.events = append(m.events, event)
}

type mockStore struct {
	getRepoByIDFn                      func(ctx context.Context, id int64) (db.Repository, error)
	getUserByIDFn                      func(ctx context.Context, id int64) (db.User, error)
	getOrgByIDFn                       func(ctx context.Context, id int64) (db.Organization, error)
	updateRepoConfigStateFn            func(ctx context.Context, arg db.UpdateRepoConfigStateParams) (db.Repository, error)
	listAllProtectedBookmarksByRepoFn  func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
	upsertProtectedBookmarkFn          func(ctx context.Context, arg db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error)
	deleteProtectedBookmarkByPatternFn func(ctx context.Context, arg db.DeleteProtectedBookmarkByPatternParams) (int64, error)
	listAllLabelsByRepoFn              func(ctx context.Context, repositoryID int64) ([]db.Label, error)
	createLabelFn                      func(ctx context.Context, arg db.CreateLabelParams) (db.Label, error)
	updateLabelFn                      func(ctx context.Context, arg db.UpdateLabelParams) (db.Label, error)
	deleteLabelFn                      func(ctx context.Context, arg db.DeleteLabelParams) error
	countIssueLabelsByLabelFn          func(ctx context.Context, labelID int64) (int64, error)
	listWebhooksByRepoFn               func(ctx context.Context, repositoryID int64) ([]db.Webhook, error)
	createWebhookFn                    func(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, error)
	updateWebhookByIDFn                func(ctx context.Context, arg db.UpdateWebhookByIDParams) (db.Webhook, error)
	deleteWebhookByIDFn                func(ctx context.Context, arg db.DeleteWebhookByIDParams) error
	getSecretValueByNameFn             func(ctx context.Context, arg db.GetSecretValueByNameParams) ([]byte, error)

	updateRepoCalls     []db.UpdateRepoConfigStateParams
	upsertBookmarkCalls []db.UpsertProtectedBookmarkParams
	deleteBookmarkCalls []db.DeleteProtectedBookmarkByPatternParams
	createLabelCalls    []db.CreateLabelParams
	updateLabelCalls    []db.UpdateLabelParams
	deleteLabelCalls    []db.DeleteLabelParams
	createWebhookCalls  []db.CreateWebhookParams
	updateWebhookCalls  []db.UpdateWebhookByIDParams
	deleteWebhookCalls  []db.DeleteWebhookByIDParams
}

func (m *mockStore) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{}, nil
}

func (m *mockStore) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{}, nil
}

func (m *mockStore) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	if m.getOrgByIDFn != nil {
		return m.getOrgByIDFn(ctx, id)
	}
	return db.Organization{}, nil
}

func (m *mockStore) UpdateRepoConfigState(ctx context.Context, arg db.UpdateRepoConfigStateParams) (db.Repository, error) {
	m.updateRepoCalls = append(m.updateRepoCalls, arg)
	if m.updateRepoConfigStateFn != nil {
		return m.updateRepoConfigStateFn(ctx, arg)
	}
	return db.Repository{}, nil
}

func (m *mockStore) ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
	if m.listAllProtectedBookmarksByRepoFn != nil {
		return m.listAllProtectedBookmarksByRepoFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockStore) UpsertProtectedBookmark(ctx context.Context, arg db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error) {
	m.upsertBookmarkCalls = append(m.upsertBookmarkCalls, arg)
	if m.upsertProtectedBookmarkFn != nil {
		return m.upsertProtectedBookmarkFn(ctx, arg)
	}
	return db.ProtectedBookmark{}, nil
}

func (m *mockStore) DeleteProtectedBookmarkByPattern(ctx context.Context, arg db.DeleteProtectedBookmarkByPatternParams) (int64, error) {
	m.deleteBookmarkCalls = append(m.deleteBookmarkCalls, arg)
	if m.deleteProtectedBookmarkByPatternFn != nil {
		return m.deleteProtectedBookmarkByPatternFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockStore) ListAllLabelsByRepo(ctx context.Context, repositoryID int64) ([]db.Label, error) {
	if m.listAllLabelsByRepoFn != nil {
		return m.listAllLabelsByRepoFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockStore) CreateLabel(ctx context.Context, arg db.CreateLabelParams) (db.Label, error) {
	m.createLabelCalls = append(m.createLabelCalls, arg)
	if m.createLabelFn != nil {
		return m.createLabelFn(ctx, arg)
	}
	return db.Label{}, nil
}

func (m *mockStore) UpdateLabel(ctx context.Context, arg db.UpdateLabelParams) (db.Label, error) {
	m.updateLabelCalls = append(m.updateLabelCalls, arg)
	if m.updateLabelFn != nil {
		return m.updateLabelFn(ctx, arg)
	}
	return db.Label{}, nil
}

func (m *mockStore) DeleteLabel(ctx context.Context, arg db.DeleteLabelParams) error {
	m.deleteLabelCalls = append(m.deleteLabelCalls, arg)
	if m.deleteLabelFn != nil {
		return m.deleteLabelFn(ctx, arg)
	}
	return nil
}

func (m *mockStore) CountIssueLabelsByLabel(ctx context.Context, labelID int64) (int64, error) {
	if m.countIssueLabelsByLabelFn != nil {
		return m.countIssueLabelsByLabelFn(ctx, labelID)
	}
	return 0, nil
}

func (m *mockStore) ListWebhooksByRepo(ctx context.Context, repositoryID int64) ([]db.Webhook, error) {
	if m.listWebhooksByRepoFn != nil {
		return m.listWebhooksByRepoFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockStore) CreateWebhook(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, error) {
	m.createWebhookCalls = append(m.createWebhookCalls, arg)
	if m.createWebhookFn != nil {
		return m.createWebhookFn(ctx, arg)
	}
	return db.Webhook{}, nil
}

func (m *mockStore) UpdateWebhookByID(ctx context.Context, arg db.UpdateWebhookByIDParams) (db.Webhook, error) {
	m.updateWebhookCalls = append(m.updateWebhookCalls, arg)
	if m.updateWebhookByIDFn != nil {
		return m.updateWebhookByIDFn(ctx, arg)
	}
	return db.Webhook{}, nil
}

func (m *mockStore) DeleteWebhookByID(ctx context.Context, arg db.DeleteWebhookByIDParams) error {
	m.deleteWebhookCalls = append(m.deleteWebhookCalls, arg)
	if m.deleteWebhookByIDFn != nil {
		return m.deleteWebhookByIDFn(ctx, arg)
	}
	return nil
}

func (m *mockStore) GetSecretValueByName(ctx context.Context, arg db.GetSecretValueByNameParams) ([]byte, error) {
	if m.getSecretValueByNameFn != nil {
		return m.getSecretValueByNameFn(ctx, arg)
	}
	return nil, errors.New("secret not found")
}

func TestService_LoadParsedConfigFromCommit_ReadsKnownFilesOnly(t *testing.T) {
	t.Parallel()

	store := &mockStore{
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return db.Repository{
				ID:     id,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 9, Valid: true},
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice"}, nil
		},
	}
	repoHost := &mockRepoHost{
		listFilesAtChangeFn: func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "abc123", changeID)
			assert.Equal(t, ".smithers", prefix)
			return []repohost.ChangeFile{
				{Path: configFilePath},
				{Path: labelsFilePath},
				{Path: ".smithers/workflows/build.tsx"},
			}, nil
		},
		getFileAtChangeFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			switch path {
			case configFilePath:
				return repohost.FileContent{Path: path, Content: "repository:\n  description: loaded\n"}, nil
			case labelsFilePath:
				return repohost.FileContent{Path: path, Content: "labels:\n  - name: bug\n    color: '#d73a4a'\n"}, nil
			default:
				return repohost.FileContent{}, errors.New("unexpected path")
			}
		},
	}

	svc := newServiceWithStore(store, repoHost, webhook.NoopSecretCodec{}, nil, nil)
	parsed, err := svc.LoadParsedConfigFromCommit(context.Background(), 42, "abc123")
	require.NoError(t, err)
	assert.True(t, parsed.ConfigFilePresent)
	assert.True(t, parsed.LabelsFilePresent)
	assert.False(t, parsed.WebhooksFilePresent)
	require.NotNil(t, parsed.Config.Repository)
	require.NotNil(t, parsed.Config.Repository.Description)
	assert.Equal(t, "loaded", *parsed.Config.Repository.Description)
}

func TestService_SyncParsedConfig_DryRunPlansAcrossAllConfigTypes(t *testing.T) {
	t.Parallel()

	store := &mockStore{
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return db.Repository{
				ID:                         id,
				Name:                       "demo",
				Description:                "old",
				IsPublic:                   false,
				Topics:                     []string{"backend"},
				IsMirror:                   false,
				WorkspaceIdleTimeoutSecs:   1800,
				WorkspacePersistence:       "persistent",
				WorkspaceDependencies:      []string{"bun"},
				LandingQueueMode:           "serialized",
				LandingQueueRequiredChecks: []string{"old-check"},
			}, nil
		},
		listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
			return []db.ProtectedBookmark{
				{
					ID:                    1,
					RepositoryID:          repositoryID,
					Pattern:               "main",
					RequireReview:         true,
					RequireHumanApprovals: 1,
				},
			}, nil
		},
		listAllLabelsByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.Label, error) {
			return []db.Label{
				{ID: 10, RepositoryID: repositoryID, Name: "bug", Color: "#ff0000", Description: "old bug"},
				{ID: 11, RepositoryID: repositoryID, Name: "legacy", Color: "#999999", Description: "still used"},
			}, nil
		},
		countIssueLabelsByLabelFn: func(ctx context.Context, labelID int64) (int64, error) {
			if labelID == 11 {
				return 2, nil
			}
			return 0, nil
		},
		listWebhooksByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.Webhook, error) {
			return []db.Webhook{
				{ID: 20, RepositoryID: repositoryID, Url: "https://example.com/hook", Secret: "old-secret", Events: []string{"push"}, IsActive: false},
				{ID: 21, RepositoryID: repositoryID, Url: "https://example.com/legacy", Events: []string{"push"}, IsActive: true},
			}, nil
		},
		getSecretValueByNameFn: func(ctx context.Context, arg db.GetSecretValueByNameParams) ([]byte, error) {
			assert.Equal(t, "HOOK_SECRET", arg.Name)
			return []byte("new-secret"), nil
		},
	}

	svc := newServiceWithStore(store, nil, webhook.NoopSecretCodec{}, nil, nil)
	result, err := svc.SyncParsedConfig(context.Background(), SyncInput{
		RepositoryID: 42,
		CommitSHA:    "abc123",
		Trigger:      "push",
		DryRun:       true,
	}, ParsedConfig{
		ConfigFilePresent: true,
		Config: ConfigFile{
			Repository: &RepositorySettings{
				Description: stringPtr("new"),
				Visibility:  stringPtr("public"),
				Topics:      []string{"api", "backend"},
				Mirror: &MirrorSettings{
					Enabled:     boolPtr(true),
					Destination: stringPtr("https://github.com/acme/demo"),
				},
			},
			Workspace: &WorkspaceSettings{
				IdleTimeoutSeconds: intPtr(900),
				Persistence:        stringPtr("ephemeral"),
				Dependencies:       []string{"go", "bun"},
			},
			LandingQueue: &LandingQueueSettings{
				Mode:           stringPtr("parallel"),
				RequiredChecks: []string{"ci"},
			},
		},
		ProtectedBookmarksFilePresent: true,
		ProtectedBookmarks: []ProtectedBookmarkRule{
			{
				Pattern:               "main",
				RequireReview:         true,
				RequireHumanApprovals: 2,
				RequiredChecks:        []string{"ci"},
			},
		},
		LabelsFilePresent: true,
		Labels: []LabelDefinition{
			{Name: "bug", Color: "#d73a4a", Description: "new bug"},
			{Name: "docs", Color: "#0075ca", Description: "documentation"},
		},
		WebhooksFilePresent: true,
		Webhooks: []WebhookDefinition{
			{
				URL:       "https://example.com/hook",
				Events:    []string{"push", "workflow_run"},
				SecretRef: "${{ secrets.HOOK_SECRET }}",
				Active:    true,
			},
		},
	})
	require.NoError(t, err)

	assert.True(t, result.DryRun)
	assert.NotEmpty(t, result.Changes)
	assert.Contains(t, result.FilesProcessed, configFilePath)
	assert.Contains(t, result.FilesProcessed, webhooksFilePath)
	require.Len(t, result.Warnings, 1)
	assert.Equal(t, "legacy", result.Warnings[0].Identifier)

	assert.Empty(t, store.updateRepoCalls)
	assert.Empty(t, store.upsertBookmarkCalls)
	assert.Empty(t, store.createLabelCalls)
	assert.Empty(t, store.updateWebhookCalls)
}

func TestService_SyncParsedConfig_AppliesChangesAndLogsAuditEvents(t *testing.T) {
	t.Parallel()

	audit := &mockAuditLogger{}
	store := &mockStore{
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return db.Repository{
				ID:                       id,
				Name:                     "demo",
				Description:              "old",
				IsPublic:                 true,
				Topics:                   []string{"old"},
				WorkspaceIdleTimeoutSecs: 1800,
				WorkspacePersistence:     "persistent",
				LandingQueueMode:         "serialized",
			}, nil
		},
		listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
			return nil, nil
		},
		listAllLabelsByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.Label, error) {
			return nil, nil
		},
		listWebhooksByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.Webhook, error) {
			return nil, nil
		},
		getSecretValueByNameFn: func(ctx context.Context, arg db.GetSecretValueByNameParams) ([]byte, error) {
			return []byte("hook-secret"), nil
		},
	}

	svc := newServiceWithStore(store, nil, webhook.NoopSecretCodec{}, audit, func(ctx context.Context) (Store, func(bool) error, error) {
		return store, func(bool) error { return nil }, nil
	})

	actorID := int64(7)
	result, err := svc.SyncParsedConfig(context.Background(), SyncInput{
		RepositoryID: 42,
		CommitSHA:    "def456",
		Trigger:      "push",
		ActorID:      &actorID,
		ActorName:    "alice",
	}, ParsedConfig{
		ConfigFilePresent: true,
		Config: ConfigFile{
			Repository: &RepositorySettings{
				Description: stringPtr("new"),
				Topics:      []string{},
			},
		},
		ProtectedBookmarksFilePresent: true,
		ProtectedBookmarks: []ProtectedBookmarkRule{
			{
				Pattern:               "main",
				RequireReview:         true,
				RequireHumanApprovals: 2,
			},
		},
		LabelsFilePresent: true,
		Labels: []LabelDefinition{
			{Name: "bug", Color: "#d73a4a", Description: "Broken"},
		},
		WebhooksFilePresent: true,
		Webhooks: []WebhookDefinition{
			{
				URL:       "https://example.com/hook",
				Events:    []string{"push"},
				SecretRef: "${{ secrets.HOOK_SECRET }}",
				Active:    true,
			},
		},
	})
	require.NoError(t, err)
	require.NotEmpty(t, result.Changes)

	require.Len(t, store.updateRepoCalls, 1)
	assert.Equal(t, "new", store.updateRepoCalls[0].Description)
	assert.Equal(t, []string{}, store.updateRepoCalls[0].Topics)
	require.Len(t, store.upsertBookmarkCalls, 1)
	assert.Equal(t, "main", store.upsertBookmarkCalls[0].Pattern)
	require.Len(t, store.createLabelCalls, 1)
	assert.Equal(t, "bug", store.createLabelCalls[0].Name)
	require.Len(t, store.createWebhookCalls, 1)
	assert.Equal(t, "hook-secret", store.createWebhookCalls[0].Secret)
	assert.Len(t, audit.events, len(result.Changes))
}

func TestService_SyncParsedConfig_CommitFailureReturnsErrorWithoutApplyAudit(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("commit failed")
	audit := &mockAuditLogger{}
	store := &mockStore{
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", Description: "old"}, nil
		},
	}
	var finalized []bool
	svc := newServiceWithStore(store, nil, webhook.NoopSecretCodec{}, audit, func(ctx context.Context) (Store, func(bool) error, error) {
		return store, func(success bool) error {
			finalized = append(finalized, success)
			return sentinel
		}, nil
	})

	result, err := svc.SyncParsedConfig(context.Background(), SyncInput{
		RepositoryID: 42,
		CommitSHA:    "def456",
		Trigger:      "push",
	}, ParsedConfig{
		ConfigFilePresent: true,
		Config: ConfigFile{
			Repository: &RepositorySettings{Description: stringPtr("new")},
		},
	})

	require.Error(t, err)
	assert.EqualError(t, err, "commit config sync transaction: commit failed")
	assert.ErrorIs(t, err, sentinel)
	assert.Equal(t, SyncResult{}, result)
	assert.Equal(t, []bool{true}, finalized)
	require.Len(t, audit.events, 1)
	assert.Equal(t, "failed", audit.events[0].Action)
}

func TestService_SyncParsedConfig_FailsWhenWebhookSecretMissing(t *testing.T) {
	t.Parallel()

	store := &mockStore{
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo"}, nil
		},
		listWebhooksByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.Webhook, error) {
			return nil, nil
		},
		getSecretValueByNameFn: func(ctx context.Context, arg db.GetSecretValueByNameParams) ([]byte, error) {
			return nil, errors.New("not found")
		},
	}

	svc := newServiceWithStore(store, nil, webhook.NoopSecretCodec{}, nil, nil)
	_, err := svc.SyncParsedConfig(context.Background(), SyncInput{
		RepositoryID: 42,
		CommitSHA:    "ghi789",
		Trigger:      "push",
	}, ParsedConfig{
		WebhooksFilePresent: true,
		Webhooks: []WebhookDefinition{
			{
				URL:       "https://example.com/hook",
				Events:    []string{"push"},
				SecretRef: "${{ secrets.HOOK_SECRET }}",
				Active:    true,
			},
		},
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "resolve repository secret")
}

func stringPtr(v string) *string { return &v }
func boolPtr(v bool) *bool       { return &v }
func intPtr(v int) *int          { return &v }

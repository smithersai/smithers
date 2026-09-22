package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func issueCovSeedUserRepo(t *testing.T, pool *pgxpool.Pool) (db.User, string) {
	t.Helper()

	ctx := context.Background()
	seq := time.Now().UnixNano()
	username := fmt.Sprintf("issuecov_user_%d", seq)
	email := fmt.Sprintf("issuecov_%d@example.com", seq)

	var user db.User
	err := pool.QueryRow(ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, username, lower_username, email, lower_email, display_name, bio, avatar_url, user_type, is_active, is_admin, prohibit_login, email_notifications_enabled, created_at, updated_at`,
		username, username, email, email, "Issue Cover User",
	).Scan(
		&user.ID,
		&user.Username,
		&user.LowerUsername,
		&user.Email,
		&user.LowerEmail,
		&user.DisplayName,
		&user.Bio,
		&user.AvatarUrl,
		&user.UserType,
		&user.IsActive,
		&user.IsAdmin,
		&user.ProhibitLogin,
		&user.EmailNotificationsEnabled,
		&user.CreatedAt,
		&user.UpdatedAt,
	)
	require.NoError(t, err)

	repoName := fmt.Sprintf("issuecov_repo_%d", seq)
	_, err = pool.Exec(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number)
		 VALUES ($1, $2, $3, '', TRUE, 'main', 1, 1)`,
		user.ID, repoName, repoName,
	)
	require.NoError(t, err)
	return user, repoName
}

func TestIssue_Cov_GetIssueRealDBAndInvalidNumber(t *testing.T) {
	pool := getAgentTestPool(t)
	actor, repoName := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))

	created, err := svc.CreateIssue(context.Background(), &actor, actor.Username, repoName, CreateIssueInput{
		Title: "cover title",
		Body:  "cover body",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), created.Number)

	got, err := svc.GetIssue(context.Background(), nil, actor.Username, repoName, created.Number)
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, "cover title", got.Title)
	assert.Equal(t, actor.Username, got.Author.Login)
	assert.Empty(t, got.Assignees)
	assert.Empty(t, got.Labels)

	_, err = svc.GetIssue(context.Background(), nil, actor.Username, repoName, 0)
	assert.Equal(t, 400, issueAPIStatus(t, err))
}

func TestIssue_Cov_CommentWrongRepoAndDeleteFetchFallback(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "alice")
	repository := issueRepo(func(r *db.Repository) {
		r.ID = 77
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	svc := NewIssueService(&mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.LowerName)
			return repository, nil
		},
		getIssueByCommentIDFn: func(_ context.Context, commentID int64) (db.Issue, error) {
			assert.Equal(t, int64(44), commentID)
			return issueDBRecord(9, 999, 2, actor.ID, nil), nil
		},
	})

	_, err := svc.GetIssueComment(context.Background(), actor, "alice", "demo", 44)
	assert.Equal(t, 404, issueAPIStatus(t, err))

	var deleted bool
	deleteSvc := NewIssueService(&mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getIssueByCommentIDFn: func(_ context.Context, commentID int64) (db.Issue, error) {
			return issueDBRecord(9, repository.ID, 2, actor.ID, nil), nil
		},
		getIssueCommentByIDFn: func(_ context.Context, commentID int64) (db.IssueComment, error) {
			return db.IssueComment{}, pgx.ErrNoRows
		},
		deleteIssueCommentFn: func(_ context.Context, commentID int64) error {
			deleted = true
			assert.Equal(t, int64(44), commentID)
			return nil
		},
	})
	require.NoError(t, deleteSvc.DeleteIssueComment(context.Background(), actor, "alice", "demo", 44))
	assert.True(t, deleted)
}

func TestIssue_Cov_PrivatePermissionWrappersAndPayloadHelpers(t *testing.T) {
	t.Parallel()

	privateRepo := issueRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: 10, Valid: true}
		r.OrgID = pgtype.Int8{}
	})
	svc := NewIssueService(&mockIssueQuerier{
		getCollaboratorPermissionForRepoFn: func(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			assert.Equal(t, privateRepo.ID, arg.RepositoryID)
			switch arg.UserID.Int64 {
			case 20:
				return "read", nil
			case 21:
				return "write", nil
			default:
				return "", nil
			}
		},
	})

	permission, owner, err := svc.repoPermissionForUser(context.Background(), privateRepo, 10)
	require.NoError(t, err)
	assert.True(t, owner)
	assert.Empty(t, permission)

	canRead, err := svc.canReadRepo(context.Background(), privateRepo, 20)
	require.NoError(t, err)
	assert.True(t, canRead)
	canWrite, err := svc.canWriteRepo(context.Background(), privateRepo, 20)
	require.NoError(t, err)
	assert.False(t, canWrite)
	canWrite, err = svc.canWriteRepo(context.Background(), privateRepo, 21)
	require.NoError(t, err)
	assert.True(t, canWrite)

	err = svc.requireWriteAccess(context.Background(), privateRepo, nil)
	assert.Equal(t, 401, issueAPIStatus(t, err))

	payload := issuePayloadFromRecord(issueDBRecord(12, privateRepo.ID, 3, 10, nil), nil, nil, nil)
	assert.Equal(t, int64(12), payload.ID)
	assert.Empty(t, payload.Author.Login)
	assert.Nil(t, issueAssigneePayloads(nil))
	assert.Nil(t, issueLabelPayloads(nil))
}

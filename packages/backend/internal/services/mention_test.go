package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// ---- ExtractMentions ----

func TestExtractMentions_EmptyBody(t *testing.T) {
	t.Parallel()
	assert.Empty(t, ExtractMentions(""))
}

func TestExtractMentions_NoMentions(t *testing.T) {
	t.Parallel()
	assert.Empty(t, ExtractMentions("This is a plain text comment."))
}

func TestExtractMentions_SingleMention(t *testing.T) {
	t.Parallel()
	m := ExtractMentions("Hello @alice, please review.")
	assert.Equal(t, []string{"alice"}, m)
}

func TestExtractMentions_MultipleMentions(t *testing.T) {
	t.Parallel()
	m := ExtractMentions("@alice and @bob should look at this.")
	assert.ElementsMatch(t, []string{"alice", "bob"}, m)
}

func TestExtractMentions_DeduplicatesMentions(t *testing.T) {
	t.Parallel()
	m := ExtractMentions("Hey @alice, can you ask @alice to help?")
	assert.Equal(t, []string{"alice"}, m)
}

func TestExtractMentions_CaseNormalization(t *testing.T) {
	t.Parallel()
	m := ExtractMentions("@Alice and @ALICE should be one.")
	assert.Equal(t, []string{"alice"}, m)
}

func TestExtractMentions_MentionAtStartOfLine(t *testing.T) {
	t.Parallel()
	m := ExtractMentions("@bob please fix this.")
	assert.Equal(t, []string{"bob"}, m)
}

func TestExtractMentions_IgnoresEmailAddresses(t *testing.T) {
	t.Parallel()
	// user@domain.com should not be extracted as @domain mention
	m := ExtractMentions("Send to user@example.com and also @alice.")
	// Should only extract alice, not example
	assert.Equal(t, []string{"alice"}, m)
}

func TestExtractMentions_IgnoresCodeFences(t *testing.T) {
	t.Parallel()
	body := "Normal text.\n```\n@alice in code block\n```\nMore text."
	m := ExtractMentions(body)
	assert.Empty(t, m)
}

func TestExtractMentions_IgnoresInlineCode(t *testing.T) {
	t.Parallel()
	body := "Run `@alice` in code, but mention @bob outside."
	m := ExtractMentions(body)
	assert.Equal(t, []string{"bob"}, m)
}

func TestExtractMentions_HandlesHyphensAndUnderscores(t *testing.T) {
	t.Parallel()
	m := ExtractMentions("cc @some-user and @another_user")
	assert.ElementsMatch(t, []string{"some-user", "another_user"}, m)
}

func TestExtractMentions_ShortUsername(t *testing.T) {
	t.Parallel()
	// Single character username after @ — valid
	m := ExtractMentions("@a please review.")
	assert.Equal(t, []string{"a"}, m)
}

func TestExtractMentions_LongBody(t *testing.T) {
	t.Parallel()
	body := strings.Repeat("word ", 1000) + "@charlie end"
	m := ExtractMentions(body)
	assert.Equal(t, []string{"charlie"}, m)
}

func TestExtractMentions_MentionInMultilineBody(t *testing.T) {
	t.Parallel()
	body := "Line one.\nLine two mentioning @dave.\nLine three."
	m := ExtractMentions(body)
	assert.Equal(t, []string{"dave"}, m)
}

// ---- MentionService.ProcessMentions ----

type mockMentionQuerier struct {
	getRepoByIDFn              func(ctx context.Context, id int64) (db.Repository, error)
	isOrgOwnerForRepoUserFn    func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	highestTeamPermissionFn    func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collaboratorPermissionFn   func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	getUserByLowerUsernameFn   func(ctx context.Context, username string) (db.User, error)
	createMentionFn            func(ctx context.Context, arg db.CreateMentionParams) (db.Mention, error)
	deleteMentionsForCommentFn func(ctx context.Context, arg db.DeleteMentionsForCommentParams) error
	getPrimaryEmailFn          func(ctx context.Context, userID int64) (db.EmailAddress, error)
}

func (m *mockMentionQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{ID: id, IsPublic: true}, nil
}

func (m *mockMentionQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockMentionQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.highestTeamPermissionFn != nil {
		return m.highestTeamPermissionFn(ctx, arg)
	}
	return "", nil
}

func (m *mockMentionQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.collaboratorPermissionFn != nil {
		return m.collaboratorPermissionFn(ctx, arg)
	}
	return "", nil
}

func (m *mockMentionQuerier) GetUserByLowerUsername(ctx context.Context, username string) (db.User, error) {
	if m.getUserByLowerUsernameFn != nil {
		return m.getUserByLowerUsernameFn(ctx, username)
	}
	return db.User{}, errors.New("user not found")
}

func (m *mockMentionQuerier) CreateMention(ctx context.Context, arg db.CreateMentionParams) (db.Mention, error) {
	if m.createMentionFn != nil {
		return m.createMentionFn(ctx, arg)
	}
	return db.Mention{}, nil
}

func (m *mockMentionQuerier) DeleteMentionsForComment(ctx context.Context, arg db.DeleteMentionsForCommentParams) error {
	if m.deleteMentionsForCommentFn != nil {
		return m.deleteMentionsForCommentFn(ctx, arg)
	}
	return nil
}

func (m *mockMentionQuerier) GetPrimaryEmail(ctx context.Context, userID int64) (db.EmailAddress, error) {
	if m.getPrimaryEmailFn != nil {
		return m.getPrimaryEmailFn(ctx, userID)
	}
	return db.EmailAddress{}, errors.New("no primary email")
}

func TestMentionService_ProcessMentions_EmptyBody(t *testing.T) {
	t.Parallel()
	svc := NewMentionService(&mockMentionQuerier{}, nil)
	err := svc.ProcessMentions(context.Background(), "", MentionContext{}, "subject")
	require.NoError(t, err)
}

func TestMentionService_ProcessMentions_NoMentions(t *testing.T) {
	t.Parallel()
	lookupCalled := false
	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, _ string) (db.User, error) {
			lookupCalled = true
			return db.User{}, nil
		},
	}
	svc := NewMentionService(q, nil)
	err := svc.ProcessMentions(context.Background(), "Plain text.", MentionContext{}, "subject")
	require.NoError(t, err)
	assert.False(t, lookupCalled)
}

func TestMentionService_ProcessMentions_UnknownUsernameSkipped(t *testing.T) {
	t.Parallel()
	createCalled := false
	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, _ string) (db.User, error) {
			return db.User{}, errors.New("user not found")
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			createCalled = true
			return db.Mention{}, nil
		},
	}
	svc := NewMentionService(q, nil)
	err := svc.ProcessMentions(context.Background(), "@unknownuser please review", MentionContext{}, "subject")
	require.NoError(t, err)
	assert.False(t, createCalled)
}

func TestMentionService_ProcessMentions_CreatesMentionForKnownUser(t *testing.T) {
	t.Parallel()
	var capturedMention db.CreateMentionParams
	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
			if username == "alice" {
				return db.User{ID: 42, Username: "alice"}, nil
			}
			return db.User{}, errors.New("not found")
		},
		createMentionFn: func(_ context.Context, arg db.CreateMentionParams) (db.Mention, error) {
			capturedMention = arg
			return db.Mention{}, nil
		},
	}

	mctx := MentionContext{
		RepositoryID: 100,
		IssueID:      pgtype.Int8{Int64: 10, Valid: true},
		CommentType:  "issue_body",
		AuthorUserID: pgtype.Int8{Int64: 99, Valid: true}, // author is not alice
	}

	svc := NewMentionService(q, nil)
	err := svc.ProcessMentions(context.Background(), "Hello @alice!", mctx, "You were mentioned")
	require.NoError(t, err)

	assert.Equal(t, int64(42), capturedMention.MentionedUserID.Int64)
	assert.Equal(t, int64(100), capturedMention.RepositoryID)
	assert.Equal(t, "issue_body", capturedMention.CommentType)
}

func TestMentionService_ProcessMentions_SelfMentionSkipped(t *testing.T) {
	t.Parallel()
	createCalled := false
	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, _ string) (db.User, error) {
			return db.User{ID: 42, Username: "alice"}, nil
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			createCalled = true
			return db.Mention{}, nil
		},
	}
	mctx := MentionContext{
		AuthorUserID: pgtype.Int8{Int64: 42, Valid: true}, // alice mentioning herself
	}
	svc := NewMentionService(q, nil)
	err := svc.ProcessMentions(context.Background(), "@alice looks good!", mctx, "subject")
	require.NoError(t, err)
	assert.False(t, createCalled, "should skip self-mention")
}

func TestMentionService_ProcessMentions_SendsNotificationToMentionedUser(t *testing.T) {
	t.Parallel()

	var notifyArg db.CreateNotificationParams
	notifyCalled := false

	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, _ string) (db.User, error) {
			return db.User{ID: 55, Username: "bob"}, nil
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, nil
		},
	}

	// Fake notification querier that records the Create call.
	notifQ := &mockNotificationQuerier{
		createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
			notifyCalled = true
			notifyArg = arg
			return db.Notification{ID: 1, UserID: arg.UserID, SourceType: arg.SourceType, Subject: arg.Subject, Status: "unread"}, nil
		},
		notifyFn: func(_ context.Context, _ db.NotifyUserParams) error {
			return nil
		},
	}
	notifSvc := NewNotificationService(notifQ)

	svc := NewMentionService(q, notifSvc)
	err := svc.ProcessMentions(
		context.Background(),
		"Hi @bob, check this out!",
		MentionContext{RepositoryID: 1, CommentType: "issue_body"},
		"You were mentioned in issue #42",
	)
	require.NoError(t, err)
	assert.True(t, notifyCalled)
	assert.Equal(t, int64(55), notifyArg.UserID)
	assert.Equal(t, "mention", notifyArg.SourceType)
	assert.Equal(t, "You were mentioned in issue #42", notifyArg.Subject)
}

func TestMentionService_ProcessMentions_MultipleMentions(t *testing.T) {
	t.Parallel()

	usersLookup := map[string]db.User{
		"alice": {ID: 10},
		"bob":   {ID: 20},
	}
	var mentionedIDs []int64

	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
			if u, ok := usersLookup[username]; ok {
				return u, nil
			}
			return db.User{}, errors.New("not found")
		},
		createMentionFn: func(_ context.Context, arg db.CreateMentionParams) (db.Mention, error) {
			mentionedIDs = append(mentionedIDs, arg.MentionedUserID.Int64)
			return db.Mention{}, nil
		},
	}

	svc := NewMentionService(q, nil)
	err := svc.ProcessMentions(
		context.Background(),
		"@alice and @bob should look at this, also @unknown",
		MentionContext{RepositoryID: 1, CommentType: "issue_body"},
		"subject",
	)
	require.NoError(t, err)
	assert.ElementsMatch(t, []int64{10, 20}, mentionedIDs)
}

func TestMentionService_ProcessMentions_DuplicateMentionNotifiesOnce(t *testing.T) {
	t.Parallel()

	mentionCreateCount := 0
	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, _ string) (db.User, error) {
			return db.User{ID: 99}, nil
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			mentionCreateCount++
			return db.Mention{}, nil
		},
	}

	svc := NewMentionService(q, nil)
	// @alice appears twice — ExtractMentions deduplicates, so only one create call.
	err := svc.ProcessMentions(
		context.Background(),
		"@alice and @alice again",
		MentionContext{},
		"subject",
	)
	require.NoError(t, err)
	assert.Equal(t, 1, mentionCreateCount)
}

func TestMentionService_ProcessMentions_SkipsPrivateRepoUsersWithoutReadAccess(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		mentionCtx MentionContext
	}{
		{
			name: "issue body",
			mentionCtx: MentionContext{
				RepositoryID: 100,
				IssueID:      pgtype.Int8{Int64: 10, Valid: true},
				CommentType:  "issue_body",
				AuthorUserID: pgtype.Int8{Int64: 1, Valid: true},
			},
		},
		{
			name: "issue comment",
			mentionCtx: MentionContext{
				RepositoryID: 100,
				IssueID:      pgtype.Int8{Int64: 10, Valid: true},
				CommentType:  "issue_comment",
				CommentID:    pgtype.Int8{Int64: 20, Valid: true},
				AuthorUserID: pgtype.Int8{Int64: 1, Valid: true},
			},
		},
		{
			name: "landing body",
			mentionCtx: MentionContext{
				RepositoryID:     100,
				LandingRequestID: pgtype.Int8{Int64: 30, Valid: true},
				CommentType:      "landing_body",
				AuthorUserID:     pgtype.Int8{Int64: 1, Valid: true},
			},
		},
		{
			name: "landing comment",
			mentionCtx: MentionContext{
				RepositoryID:     100,
				LandingRequestID: pgtype.Int8{Int64: 30, Valid: true},
				CommentType:      "landing_comment",
				CommentID:        pgtype.Int8{Int64: 40, Valid: true},
				AuthorUserID:     pgtype.Int8{Int64: 1, Valid: true},
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			createCalled := false
			notifyCalled := false
			emailSender := &mockMentionEmailSender{}

			q := &mockMentionQuerier{
				getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
					return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 1, Valid: true}, IsPublic: false}, nil
				},
				getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
					if username == "mallory" {
						return db.User{ID: 55, Username: "mallory", EmailNotificationsEnabled: true}, nil
					}
					return db.User{}, errors.New("not found")
				},
				createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
					createCalled = true
					return db.Mention{}, nil
				},
				getPrimaryEmailFn: func(_ context.Context, userID int64) (db.EmailAddress, error) {
					return db.EmailAddress{ID: 1, UserID: userID, Email: "mallory@example.com", IsActivated: true, IsPrimary: true}, nil
				},
			}
			notifSvc := NewNotificationService(&mockNotificationQuerier{
				createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
					notifyCalled = true
					return db.Notification{ID: 1, UserID: arg.UserID}, nil
				},
				notifyFn: func(_ context.Context, _ db.NotifyUserParams) error {
					return nil
				},
			})

			svc := NewMentionService(q, notifSvc, WithMentionEmailSender(emailSender))
			err := svc.ProcessMentions(
				context.Background(),
				"private details for @mallory",
				tt.mentionCtx,
				"mentioned you",
			)

			require.NoError(t, err)
			assert.False(t, createCalled, "should not record mention for a user without repository read access")
			assert.False(t, notifyCalled, "should not create in-app notification for a user without repository read access")
			assert.Empty(t, emailSender.calls, "should not email a user without repository read access")
		})
	}
}

func TestMentionService_ProcessMentions_AllowsPrivateRepoUsersWithReadAccess(t *testing.T) {
	t.Parallel()

	createCalled := false
	q := &mockMentionQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 1, Valid: true}, IsPublic: false}, nil
		},
		getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
			if username == "alice" {
				return db.User{ID: 42, Username: "alice"}, nil
			}
			return db.User{}, errors.New("not found")
		},
		collaboratorPermissionFn: func(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			if arg.RepositoryID == 100 && arg.UserID.Valid && arg.UserID.Int64 == 42 {
				return "read", nil
			}
			return "", nil
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			createCalled = true
			return db.Mention{}, nil
		},
	}

	svc := NewMentionService(q, nil)
	err := svc.ProcessMentions(
		context.Background(),
		"private details for @alice",
		MentionContext{RepositoryID: 100, CommentType: "issue_body", AuthorUserID: pgtype.Int8{Int64: 1, Valid: true}},
		"mentioned you",
	)

	require.NoError(t, err)
	assert.True(t, createCalled)
}

// ---- Mention email notification tests ----

type mockMentionEmailSender struct {
	calls []mentionEmailCall
}

type mentionEmailCall struct {
	ToEmail  string
	Username string
	Subject  string
	Snippet  string
	URL      string
}

func (m *mockMentionEmailSender) SendMentionNotification(_ context.Context, toEmail string, username string, subject string, snippet string, url string) {
	m.calls = append(m.calls, mentionEmailCall{
		ToEmail:  toEmail,
		Username: username,
		Subject:  subject,
		Snippet:  snippet,
		URL:      url,
	})
}

func TestMentionService_ProcessMentions_SendsEmail_WhenVerifiedAndEnabled(t *testing.T) {
	t.Parallel()

	emailSender := &mockMentionEmailSender{}

	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
			if username == "alice" {
				return db.User{ID: 42, Username: "alice", EmailNotificationsEnabled: true}, nil
			}
			return db.User{}, errors.New("not found")
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, nil
		},
		getPrimaryEmailFn: func(_ context.Context, userID int64) (db.EmailAddress, error) {
			if userID == 42 {
				return db.EmailAddress{ID: 1, UserID: 42, Email: "alice@example.com", IsActivated: true, IsPrimary: true}, nil
			}
			return db.EmailAddress{}, errors.New("no primary email")
		},
	}

	svc := NewMentionService(q, nil, WithMentionEmailSender(emailSender))
	err := svc.ProcessMentions(
		context.Background(),
		"Hey @alice check this out!",
		MentionContext{RepositoryID: 1, CommentType: "issue_body"},
		"You were mentioned in issue #42",
	)

	require.NoError(t, err)
	require.Len(t, emailSender.calls, 1)
	assert.Equal(t, "alice@example.com", emailSender.calls[0].ToEmail)
	assert.Equal(t, "alice", emailSender.calls[0].Username)
	assert.Equal(t, "You were mentioned in issue #42", emailSender.calls[0].Subject)
}

func TestMentionService_ProcessMentions_SkipsEmail_WhenNotificationsDisabled(t *testing.T) {
	t.Parallel()

	emailSender := &mockMentionEmailSender{}

	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, _ string) (db.User, error) {
			return db.User{ID: 42, Username: "eve", EmailNotificationsEnabled: false}, nil
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, nil
		},
		getPrimaryEmailFn: func(_ context.Context, _ int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: 1, UserID: 42, Email: "eve@example.com", IsActivated: true, IsPrimary: true}, nil
		},
	}

	svc := NewMentionService(q, nil, WithMentionEmailSender(emailSender))
	err := svc.ProcessMentions(
		context.Background(),
		"Hey @eve!",
		MentionContext{RepositoryID: 1, CommentType: "issue_body"},
		"You were mentioned",
	)
	require.NoError(t, err)
	assert.Empty(t, emailSender.calls, "should not send email when notifications disabled")
}

func TestMentionService_ProcessMentions_SkipsEmail_WhenPrimaryEmailNotActivated(t *testing.T) {
	t.Parallel()

	emailSender := &mockMentionEmailSender{}

	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
			if username == "bob" {
				return db.User{ID: 55, Username: "bob", EmailNotificationsEnabled: true}, nil
			}
			return db.User{}, errors.New("not found")
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, nil
		},
		getPrimaryEmailFn: func(_ context.Context, userID int64) (db.EmailAddress, error) {
			if userID == 55 {
				// Unverified email — IsActivated=false
				return db.EmailAddress{ID: 2, UserID: 55, Email: "bob@example.com", IsActivated: false, IsPrimary: true}, nil
			}
			return db.EmailAddress{}, errors.New("no primary email")
		},
	}

	svc := NewMentionService(q, nil, WithMentionEmailSender(emailSender))
	err := svc.ProcessMentions(
		context.Background(),
		"Hey @bob check this!",
		MentionContext{RepositoryID: 1, CommentType: "issue_body"},
		"You were mentioned",
	)

	require.NoError(t, err)
	assert.Len(t, emailSender.calls, 0, "should not send email when primary email is not activated")
}

func TestMentionService_ProcessMentions_SkipsEmail_WhenNoPrimaryEmail(t *testing.T) {
	t.Parallel()

	emailSender := &mockMentionEmailSender{}

	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
			if username == "carol" {
				return db.User{ID: 77, Username: "carol"}, nil
			}
			return db.User{}, errors.New("not found")
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, nil
		},
		getPrimaryEmailFn: func(_ context.Context, _ int64) (db.EmailAddress, error) {
			return db.EmailAddress{}, errors.New("no primary email")
		},
	}

	svc := NewMentionService(q, nil, WithMentionEmailSender(emailSender))
	err := svc.ProcessMentions(
		context.Background(),
		"Hey @carol!",
		MentionContext{RepositoryID: 1, CommentType: "issue_body"},
		"You were mentioned",
	)

	require.NoError(t, err)
	assert.Len(t, emailSender.calls, 0, "should not send email when no primary email exists")
}

func TestMentionService_ProcessMentions_NoEmailSender_StillWorks(t *testing.T) {
	t.Parallel()

	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, _ string) (db.User, error) {
			return db.User{ID: 10, Username: "dave"}, nil
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, nil
		},
	}

	// No email sender configured — should still work without panicking.
	svc := NewMentionService(q, nil)
	err := svc.ProcessMentions(
		context.Background(),
		"Hey @dave!",
		MentionContext{RepositoryID: 1, CommentType: "issue_body"},
		"subject",
	)
	require.NoError(t, err)
}

func TestMentionService_ProcessMentions_CapsUniqueMentionsPerBody(t *testing.T) {
	t.Parallel()

	// Build a body with twice the cap of unique existing usernames.
	var sb strings.Builder
	for i := 0; i < 2*maxMentionsPerBody; i++ {
		fmt.Fprintf(&sb, "@user%d ", i)
	}

	var lookups, mentionRows int
	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
			lookups++
			return db.User{ID: int64(100 + lookups), Username: username}, nil
		},
		createMentionFn: func(_ context.Context, _ db.CreateMentionParams) (db.Mention, error) {
			mentionRows++
			return db.Mention{}, nil
		},
	}

	svc := NewMentionService(q, nil)
	err := svc.ProcessMentions(
		context.Background(),
		sb.String(),
		MentionContext{RepositoryID: 1, CommentType: "issue_body"},
		"subject",
	)

	require.NoError(t, err)
	assert.Equal(t, maxMentionsPerBody, lookups, "user lookups must stop at the per-body mention cap")
	assert.Equal(t, maxMentionsPerBody, mentionRows, "mention rows must stop at the per-body mention cap")
}

package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mentionCovEmailSender struct {
	to      string
	user    string
	subject string
	snippet string
}

func (s *mentionCovEmailSender) SendMentionNotification(_ context.Context, toEmail string, username string, subject string, snippet string, _ string) {
	s.to = toEmail
	s.user = username
	s.subject = subject
	s.snippet = snippet
}

func TestMention_Cov_ExtractTildeFenceAndBoundaries(t *testing.T) {
	got := ExtractMentions("hi@@bad x@y.com ~~~\n@code\n~~~\n cc (@Alice) and @bob.")
	if len(got) != 2 || got[0] != "alice" || got[1] != "bob" {
		t.Fatalf("mentions = %+v", got)
	}
}

func TestMention_Cov_ProcessDuplicateErrorAndEmail(t *testing.T) {
	duplicate := &pgconn.PgError{Code: "23505"}
	emailer := &mentionCovEmailSender{}
	createCalls := 0
	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(_ context.Context, username string) (db.User, error) {
			switch username {
			case "alice":
				return db.User{ID: 10, Username: "alice", EmailNotificationsEnabled: true}, nil
			case "bob":
				return db.User{ID: 11, Username: "bob"}, nil
			default:
				return db.User{}, errors.New("not found")
			}
		},
		createMentionFn: func(_ context.Context, arg db.CreateMentionParams) (db.Mention, error) {
			createCalls++
			if arg.MentionedUserID.Int64 == 11 {
				return db.Mention{}, duplicate
			}
			return db.Mention{}, nil
		},
		getPrimaryEmailFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{Email: "alice@example.test", IsActivated: true}, nil
		},
	}
	body := "hello @alice and @bob " + strings.Repeat("x", 300)
	err := NewMentionService(q, nil, WithMentionEmailSender(emailer)).ProcessMentions(context.Background(), body, MentionContext{
		RepositoryID: 1,
		IssueID:      pgtype.Int8{Int64: 2, Valid: true},
		CommentType:  "issue_comment",
		AuthorUserID: pgtype.Int8{Int64: 99, Valid: true},
	}, "Mentioned")
	if err != nil {
		t.Fatalf("ProcessMentions returned error: %v", err)
	}
	if createCalls != 2 || emailer.to != "alice@example.test" || emailer.user != "alice" || len(emailer.snippet) > 255 {
		t.Fatalf("createCalls=%d emailer=%+v", createCalls, emailer)
	}
}

func TestMention_Cov_ProcessCreateErrorReturnsFirstError(t *testing.T) {
	q := &mockMentionQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return db.User{ID: 10, Username: "alice"}, nil
		},
		createMentionFn: func(context.Context, db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, errors.New("insert failed")
		},
	}
	err := NewMentionService(q, nil).ProcessMentions(context.Background(), "@alice", MentionContext{}, "subj")
	if err == nil || !strings.Contains(err.Error(), "create mention") {
		t.Fatalf("err = %v", err)
	}
}

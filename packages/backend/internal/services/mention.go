package services

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// mentionPattern matches @username references in text.
// Usernames must start with a letter or digit and may contain letters, digits,
// hyphens, and underscores. The pattern does not match inside code fences or
// inline code blocks.
var mentionPattern = regexp.MustCompile(`(?:^|[^a-zA-Z0-9\-_@])@([a-zA-Z0-9][a-zA-Z0-9\-_]*)`)

var (
	// mentionFenceRe strips fenced code blocks (``` or ~~~).
	mentionFenceRe = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~")
	// mentionInlineCodeRe strips inline code spans.
	mentionInlineCodeRe = regexp.MustCompile("`[^`]*`")
)

// ExtractMentions parses a text body and returns the unique lowercase usernames
// that are mentioned via @username syntax. Code-fenced blocks (``` ... ```) and
// inline code spans (` ... `) are stripped before scanning to avoid extracting
// usernames from code examples.
func ExtractMentions(body string) []string {
	stripped := mentionFenceRe.ReplaceAllString(body, "")
	stripped = mentionInlineCodeRe.ReplaceAllString(stripped, "")

	matches := mentionPattern.FindAllStringSubmatch(stripped, -1)
	seen := make(map[string]struct{})
	var result []string
	for _, m := range matches {
		lower := strings.ToLower(m[1])
		if _, ok := seen[lower]; ok {
			continue
		}
		seen[lower] = struct{}{}
		result = append(result, lower)
	}
	return result
}

// MentionQuerier is the minimal set of DB operations needed by MentionService.
type MentionQuerier interface {
	RepoPermQuerier
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error)
	CreateMention(ctx context.Context, arg db.CreateMentionParams) (db.Mention, error)
	DeleteMentionsForComment(ctx context.Context, arg db.DeleteMentionsForCommentParams) error
	GetPrimaryEmail(ctx context.Context, userID int64) (db.EmailAddress, error)
}

// MentionEmailSender sends mention notification emails. Implemented by EmailService.
type MentionEmailSender interface {
	SendMentionNotification(ctx context.Context, toEmail string, username string, subject string, snippet string, url string)
}

// MentionService handles @mention detection, storage, and notification dispatch.
type MentionService struct {
	q           MentionQuerier
	notf        *NotificationService
	emailSender MentionEmailSender
}

// NewMentionService creates a new MentionService.
func NewMentionService(q MentionQuerier, notf *NotificationService, opts ...MentionServiceOption) *MentionService {
	svc := &MentionService{q: q, notf: notf}
	for _, opt := range opts {
		opt(svc)
	}
	return svc
}

// MentionServiceOption configures a MentionService.
type MentionServiceOption func(*MentionService)

// WithMentionEmailSender sets the email sender for mention notifications.
func WithMentionEmailSender(sender MentionEmailSender) MentionServiceOption {
	return func(s *MentionService) {
		s.emailSender = sender
	}
}

// MentionContext carries the context of where a mention was found.
type MentionContext struct {
	RepositoryID     int64
	IssueID          pgtype.Int8 // nullable
	LandingRequestID pgtype.Int8 // nullable
	CommentType      string      // e.g. "issue_comment", "issue_body"
	CommentID        pgtype.Int8 // nullable
	AuthorUserID     pgtype.Int8 // who wrote the text (nullable)
}

// maxMentionsPerBody caps how many unique @mentions in a single body produce
// side effects (user lookups, mention rows, in-app and email notifications).
// Without a cap one request-size-limited body can still carry thousands of
// distinct handles and turn a single submission into a DB/mail fan-out storm.
// Mentions beyond the cap (in order of appearance) are ignored.
const maxMentionsPerBody = 50

// ProcessMentions scans body for @username references, records them in the
// mentions table, and sends an in-app notification to each mentioned user who
// can read the repository. Unknown usernames are silently skipped. The
// authorUserID is excluded from receiving a self-notification. At most
// maxMentionsPerBody unique mentions are processed per body.
//
// On partial failure (some mentions succeed, others fail), an error is returned
// but all successfully processed mentions are persisted.
func (s *MentionService) ProcessMentions(ctx context.Context, body string, mctx MentionContext, notificationSubject string) error {
	usernames := ExtractMentions(body)
	if len(usernames) == 0 {
		return nil
	}
	if len(usernames) > maxMentionsPerBody {
		slog.Warn("mention fan-out capped",
			"repository_id", mctx.RepositoryID,
			"comment_type", mctx.CommentType,
			"mentions", len(usernames),
			"cap", maxMentionsPerBody)
		usernames = usernames[:maxMentionsPerBody]
	}

	repository, err := s.q.GetRepoByID(ctx, mctx.RepositoryID)
	if err != nil {
		return pkgerrors.Internal("failed to load repository").WithCause(err)
	}

	var firstErr error
	for _, username := range usernames {
		user, err := s.q.GetUserByLowerUsername(ctx, username)
		if err != nil {
			// Unknown username — skip.
			continue
		}

		// Skip self-notifications.
		if mctx.AuthorUserID.Valid && mctx.AuthorUserID.Int64 == user.ID {
			continue
		}

		canRead, err := canReadRepo(ctx, s.q, repository, user.ID)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !canRead {
			continue
		}

		// Record the mention.
		_, err = s.q.CreateMention(ctx, db.CreateMentionParams{
			RepositoryID:     mctx.RepositoryID,
			IssueID:          mctx.IssueID,
			LandingRequestID: mctx.LandingRequestID,
			CommentType:      mctx.CommentType,
			CommentID:        mctx.CommentID,
			UserID:           mctx.AuthorUserID,
			MentionedUserID:  pgtype.Int8{Int64: user.ID, Valid: true},
		})
		if err != nil {
			// Unique constraint violation means duplicate — skip.
			if isUniqueViolation(err) {
				continue
			}
			if firstErr == nil {
				firstErr = pkgerrors.Internal("create mention: " + err.Error())
			}
			continue
		}

		// Send in-app notification, but only if the user wants mention notifications.
		if s.notf != nil && s.notf.UserWantsMentionNotification(ctx, user.ID) {
			// Reference the issue when the mention came from an issue context,
			// otherwise the landing request. A resolvable source is required
			// for the notification list/replay path to re-check repository
			// access (see filterReadableNotifications).
			sourceID := mctx.IssueID
			sourceType := "mention_issue"
			if !sourceID.Valid {
				sourceID = mctx.LandingRequestID
				sourceType = "mention_landing"
			}
			_, err = s.notf.Create(ctx, db.CreateNotificationParams{
				UserID:     user.ID,
				SourceType: sourceType,
				SourceID:   sourceID,
				Subject:    notificationSubject,
				Body:       truncateBody(body, 255),
			})
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}

		// Send email notification (best-effort, async via emailSender).
		if s.emailSender != nil && user.EmailNotificationsEnabled {
			primaryEmail, emailErr := s.q.GetPrimaryEmail(ctx, user.ID)
			if emailErr != nil {
				slog.Warn("failed to get primary email for mentioned user", "user_id", user.ID, "error", emailErr)
			} else if primaryEmail.IsActivated {
				s.emailSender.SendMentionNotification(
					ctx,
					primaryEmail.Email,
					user.Username,
					notificationSubject,
					truncateBody(body, 255),
					"", // URL is not available in the current mention context
				)
			}
		}
	}

	return firstErr
}

// truncateBody truncates s to at most maxLen bytes on a UTF-8 rune boundary.
func truncateBody(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	// Backtrack off any continuation byte so we never split a multi-byte rune,
	// which would emit invalid UTF-8 into mention notifications and emails.
	for maxLen > 0 && !utf8.RuneStart(s[maxLen]) {
		maxLen--
	}
	return s[:maxLen]
}

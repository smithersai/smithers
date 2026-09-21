package services

import (
	"context"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	WhitelistIdentityEmail    = "email"
	WhitelistIdentityWallet   = "wallet"
	WhitelistIdentityUsername = "username"

	WaitlistStatusPending  = "pending"
	WaitlistStatusApproved = "approved"
	WaitlistStatusRejected = "rejected"
)

type AlphaAccessQuerier interface {
	AddWhitelistEntry(ctx context.Context, arg db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error)
	RemoveWhitelistEntry(ctx context.Context, arg db.RemoveWhitelistEntryParams) (int64, error)
	ListWhitelistEntries(ctx context.Context) ([]db.AlphaWhitelistEntry, error)
	IsWhitelistedIdentity(ctx context.Context, arg db.IsWhitelistedIdentityParams) (bool, error)
	UpsertWaitlistEntry(ctx context.Context, arg db.UpsertWaitlistEntryParams) (db.AlphaWaitlistEntry, error)
	GetWaitlistEntryByLowerEmail(ctx context.Context, lowerEmail string) (db.AlphaWaitlistEntry, error)
	ListWaitlistEntries(ctx context.Context, arg db.ListWaitlistEntriesParams) ([]db.AlphaWaitlistEntry, error)
	CountWaitlistEntries(ctx context.Context, statusFilter string) (int64, error)
	ApproveWaitlistEntryByLowerEmail(ctx context.Context, arg db.ApproveWaitlistEntryByLowerEmailParams) (db.AlphaWaitlistEntry, error)
}

type alphaAccessTxQuerier interface {
	AlphaAccessQuerier
	BeginTx(ctx context.Context) (pgx.Tx, error)
	WithTx(tx pgx.Tx) *db.Queries
}

type AlphaAccessService struct {
	queries   AlphaAccessQuerier
	txQueries alphaAccessTxQuerier
}

type AddWhitelistEntryInput struct {
	IdentityType  string `json:"identity_type"`
	IdentityValue string `json:"identity_value"`
}

type RemoveWhitelistEntryInput struct {
	IdentityType  string `json:"identity_type"`
	IdentityValue string `json:"identity_value"`
}

type WaitlistJoinInput struct {
	Email           string `json:"email"`
	GithubUsername  string `json:"github_username"`
	GithubAvatarURL string `json:"github_avatar_url"`
	Note            string `json:"note"`
	Source          string `json:"source"`
}

type ListWaitlistInput struct {
	Page    int    `json:"page"`
	PerPage int    `json:"per_page"`
	Status  string `json:"status"`
}

type AlphaWhitelistEntry struct {
	ID            int64     `json:"id"`
	IdentityType  string    `json:"identity_type"`
	IdentityValue string    `json:"identity_value"`
	CreatedBy     *int64    `json:"created_by,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type AlphaWaitlistEntry struct {
	ID              int64      `json:"id"`
	Email           string     `json:"email"`
	GithubUsername  string     `json:"github_username"`
	GithubAvatarURL string     `json:"github_avatar_url"`
	Note            string     `json:"note"`
	Status          string     `json:"status"`
	Source          string     `json:"source"`
	ApprovedBy      *int64     `json:"approved_by,omitempty"`
	ApprovedAt      *time.Time `json:"approved_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type AlphaWaitlistListResult struct {
	Items      []AlphaWaitlistEntry `json:"items"`
	TotalCount int64                `json:"total_count"`
	Page       int                  `json:"page"`
	PerPage    int                  `json:"per_page"`
}

type whitelistCandidate struct{ kind, value string }

func NewAlphaAccessService(queries AlphaAccessQuerier) *AlphaAccessService {
	svc := &AlphaAccessService{queries: queries}
	if txQueries, ok := queries.(alphaAccessTxQuerier); ok {
		svc.txQueries = txQueries
	}
	return svc
}

// IsUserWhitelisted returns true if the given user is on the closed-alpha
// whitelist OR is an admin. Matches on any of: username, primary email,
// or wallet address (see auth.go enforceClosedBetaForUser for the canonical
// policy — this wraps the same checks so the OAuth2 authorize route can
// gate code issuance without pulling in all of AuthService).
//
// A nil user is not whitelisted (defensive default).
func (s *AlphaAccessService) IsUserWhitelisted(ctx context.Context, user *db.User) (bool, error) {
	if user == nil {
		return false, nil
	}
	if user.IsAdmin {
		return true, nil
	}

	candidates := make([]whitelistCandidate, 0, 3)
	candidates = append(candidates, whitelistCandidate{WhitelistIdentityUsername, user.Username})
	if user.Email.Valid && strings.TrimSpace(user.Email.String) != "" {
		candidates = append(candidates, whitelistCandidate{WhitelistIdentityEmail, user.Email.String})
	}
	if user.WalletAddress.Valid && strings.TrimSpace(user.WalletAddress.String) != "" {
		candidates = append(candidates, whitelistCandidate{WhitelistIdentityWallet, user.WalletAddress.String})
	}

	for _, c := range uniqueWhitelistCandidates(candidates) {
		identityType, _, lowerIdentityValue, err := NormalizeWhitelistIdentity(c.kind, c.value)
		if err != nil {
			continue
		}

		allowed, qErr := s.queries.IsWhitelistedIdentity(ctx, db.IsWhitelistedIdentityParams{
			IdentityType:       identityType,
			LowerIdentityValue: lowerIdentityValue,
		})
		if qErr != nil {
			return false, pkgerrors.Internal("failed to query whitelist")
		}
		if allowed {
			return true, nil
		}
	}
	return false, nil
}

func uniqueWhitelistCandidates(candidates []whitelistCandidate) []whitelistCandidate {
	seen := make(map[string]struct{}, len(candidates))
	unique := make([]whitelistCandidate, 0, len(candidates))
	for _, c := range candidates {
		identityType, _, lowerIdentityValue, err := NormalizeWhitelistIdentity(c.kind, c.value)
		if err != nil {
			unique = append(unique, c)
			continue
		}
		key := identityType + ":" + lowerIdentityValue
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, c)
	}
	return unique
}

func (s *AlphaAccessService) JoinWaitlist(ctx context.Context, input WaitlistJoinInput) (AlphaWaitlistEntry, error) {
	email, lowerEmail, err := normalizeWaitlistEmail(input.Email)
	if err != nil {
		return AlphaWaitlistEntry{}, err
	}

	note := strings.TrimSpace(input.Note)
	if len(note) > 2000 {
		return AlphaWaitlistEntry{}, pkgerrors.BadRequest("waitlist note is too long")
	}

	githubUsername := strings.TrimSpace(input.GithubUsername)
	if len(githubUsername) > 255 {
		return AlphaWaitlistEntry{}, pkgerrors.BadRequest("github username is too long")
	}

	githubAvatarURL := strings.TrimSpace(input.GithubAvatarURL)
	if len(githubAvatarURL) > 2048 {
		return AlphaWaitlistEntry{}, pkgerrors.BadRequest("github avatar_url is too long")
	}

	source := strings.ToLower(strings.TrimSpace(input.Source))
	if source == "" {
		source = "unknown"
	}
	if len(source) > 32 {
		return AlphaWaitlistEntry{}, pkgerrors.BadRequest("waitlist source is too long")
	}

	row, queryErr := s.queries.UpsertWaitlistEntry(ctx, db.UpsertWaitlistEntryParams{
		Email:           email,
		LowerEmail:      lowerEmail,
		GithubUsername:  githubUsername,
		GithubAvatarUrl: githubAvatarURL,
		Note:            note,
		Source:          source,
	})
	if queryErr != nil {
		return AlphaWaitlistEntry{}, pkgerrors.Internal("failed to join waitlist")
	}

	return mapWaitlistEntry(row), nil
}

func (s *AlphaAccessService) ListWaitlistEntries(ctx context.Context, input ListWaitlistInput) (AlphaWaitlistListResult, error) {
	page := input.Page
	if page <= 0 {
		page = 1
	}

	perPage := input.PerPage
	if perPage <= 0 {
		perPage = 50
	}
	if perPage > 200 {
		perPage = 200
	}

	status := strings.ToLower(strings.TrimSpace(input.Status))
	if status != "" && status != WaitlistStatusPending && status != WaitlistStatusApproved && status != WaitlistStatusRejected {
		return AlphaWaitlistListResult{}, pkgerrors.BadRequest("invalid waitlist status filter")
	}

	offset := ClampInt32((page - 1) * perPage)
	rows, err := s.queries.ListWaitlistEntries(ctx, db.ListWaitlistEntriesParams{
		StatusFilter: status,
		PageOffset:   offset,
		PageSize:     int32(perPage),
	})
	if err != nil {
		return AlphaWaitlistListResult{}, pkgerrors.Internal("failed to list waitlist entries")
	}

	total, err := s.queries.CountWaitlistEntries(ctx, status)
	if err != nil {
		return AlphaWaitlistListResult{}, pkgerrors.Internal("failed to count waitlist entries")
	}

	items := make([]AlphaWaitlistEntry, 0, len(rows))
	for _, row := range rows {
		items = append(items, mapWaitlistEntry(row))
	}

	return AlphaWaitlistListResult{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *AlphaAccessService) AddWhitelistEntry(ctx context.Context, actor *db.User, input AddWhitelistEntryInput) (AlphaWhitelistEntry, error) {
	return addWhitelistEntryWithQueries(ctx, s.queries, actor, input)
}

func addWhitelistEntryWithQueries(ctx context.Context, queries AlphaAccessQuerier, actor *db.User, input AddWhitelistEntryInput) (AlphaWhitelistEntry, error) {
	identityType, identityValue, lowerIdentityValue, err := NormalizeWhitelistIdentity(input.IdentityType, input.IdentityValue)
	if err != nil {
		return AlphaWhitelistEntry{}, err
	}

	createdBy := pgtype.Int8{}
	if actor != nil {
		createdBy = pgtype.Int8{Int64: actor.ID, Valid: true}
	}

	row, queryErr := queries.AddWhitelistEntry(ctx, db.AddWhitelistEntryParams{
		IdentityType:       identityType,
		IdentityValue:      identityValue,
		LowerIdentityValue: lowerIdentityValue,
		CreatedBy:          createdBy,
	})
	if queryErr != nil {
		return AlphaWhitelistEntry{}, pkgerrors.Internal("failed to add whitelist entry")
	}

	return mapWhitelistEntry(row), nil
}

func (s *AlphaAccessService) RemoveWhitelistEntry(ctx context.Context, input RemoveWhitelistEntryInput) error {
	identityType, _, lowerIdentityValue, err := NormalizeWhitelistIdentity(input.IdentityType, input.IdentityValue)
	if err != nil {
		return err
	}

	rows, queryErr := s.queries.RemoveWhitelistEntry(ctx, db.RemoveWhitelistEntryParams{
		IdentityType:       identityType,
		LowerIdentityValue: lowerIdentityValue,
	})
	if queryErr != nil {
		return pkgerrors.Internal("failed to remove whitelist entry")
	}
	if rows == 0 {
		return pkgerrors.NotFound("whitelist entry not found")
	}

	return nil
}

func (s *AlphaAccessService) ListWhitelistEntries(ctx context.Context) ([]AlphaWhitelistEntry, error) {
	rows, err := s.queries.ListWhitelistEntries(ctx)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list whitelist entries")
	}

	result := make([]AlphaWhitelistEntry, 0, len(rows))
	for _, row := range rows {
		result = append(result, mapWhitelistEntry(row))
	}
	return result, nil
}

func (s *AlphaAccessService) ApproveWaitlistEntry(ctx context.Context, actor *db.User, email string) (AlphaWaitlistEntry, error) {
	if actor == nil {
		return AlphaWaitlistEntry{}, pkgerrors.Unauthorized("authentication required")
	}

	normalizedEmail, lowerEmail, err := normalizeWaitlistEmail(email)
	if err != nil {
		return AlphaWaitlistEntry{}, err
	}

	if s.txQueries == nil {
		return approveWaitlistEntryWithQueries(ctx, s.queries, actor, normalizedEmail, lowerEmail)
	}

	tx, err := s.txQueries.BeginTx(ctx)
	if err != nil {
		return AlphaWaitlistEntry{}, pkgerrors.Internal("failed to approve waitlist entry")
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	row, err := approveWaitlistEntryWithQueries(ctx, s.txQueries.WithTx(tx), actor, normalizedEmail, lowerEmail)
	if err != nil {
		return AlphaWaitlistEntry{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AlphaWaitlistEntry{}, pkgerrors.Internal("failed to approve waitlist entry")
	}
	return row, nil
}

func approveWaitlistEntryWithQueries(ctx context.Context, queries AlphaAccessQuerier, actor *db.User, normalizedEmail, lowerEmail string) (AlphaWaitlistEntry, error) {
	existing, err := queries.GetWaitlistEntryByLowerEmail(ctx, lowerEmail)
	if err != nil {
		if err == pgx.ErrNoRows {
			return AlphaWaitlistEntry{}, pkgerrors.NotFound("waitlist entry not found")
		}
		return AlphaWaitlistEntry{}, pkgerrors.Internal("failed to load waitlist entry")
	}

	_, err = addWhitelistEntryWithQueries(ctx, queries, actor, AddWhitelistEntryInput{
		IdentityType:  WhitelistIdentityEmail,
		IdentityValue: normalizedEmail,
	})
	if err != nil {
		return AlphaWaitlistEntry{}, err
	}

	row, err := queries.ApproveWaitlistEntryByLowerEmail(ctx, db.ApproveWaitlistEntryByLowerEmailParams{
		ApprovedBy: pgtype.Int8{Int64: actor.ID, Valid: true},
		LowerEmail: lowerEmail,
	})
	if err != nil {
		return AlphaWaitlistEntry{}, pkgerrors.Internal("failed to approve waitlist entry")
	}

	// Keep stable shape for already-approved rows.
	if existing.Status == WaitlistStatusApproved {
		row.ApprovedBy = existing.ApprovedBy
		row.ApprovedAt = existing.ApprovedAt
	}

	return mapWaitlistEntry(row), nil
}

func NormalizeWhitelistIdentity(identityType, identityValue string) (string, string, string, error) {
	kind := strings.ToLower(strings.TrimSpace(identityType))
	value := strings.TrimSpace(identityValue)
	if kind == "" || value == "" {
		return "", "", "", pkgerrors.BadRequest("identity_type and identity_value are required")
	}

	switch kind {
	case WhitelistIdentityEmail:
		_, lowerEmail, err := normalizeWaitlistEmail(value)
		if err != nil {
			return "", "", "", err
		}
		return kind, lowerEmail, lowerEmail, nil
	case WhitelistIdentityWallet:
		wallet := strings.ToLower(value)
		if len(wallet) != 42 || !strings.HasPrefix(wallet, "0x") {
			return "", "", "", pkgerrors.BadRequest("wallet whitelist values must be a valid 0x-prefixed address")
		}
		for _, ch := range wallet[2:] {
			if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
				return "", "", "", pkgerrors.BadRequest("wallet whitelist values must be a valid 0x-prefixed address")
			}
		}
		return kind, wallet, wallet, nil
	case WhitelistIdentityUsername:
		lower := strings.ToLower(value)
		if len(lower) == 0 || len(lower) > 255 {
			return "", "", "", pkgerrors.BadRequest("username whitelist values must be 1-255 characters")
		}
		return kind, lower, lower, nil
	default:
		return "", "", "", pkgerrors.BadRequest("identity_type must be one of: email, wallet, username")
	}
}

func normalizeWaitlistEmail(raw string) (string, string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "", pkgerrors.BadRequest("email is required")
	}
	parsed, err := mail.ParseAddress(trimmed)
	if err != nil {
		return "", "", pkgerrors.BadRequest("invalid email address")
	}
	email := strings.TrimSpace(parsed.Address)
	lower := strings.ToLower(email)
	return email, lower, nil
}

func mapWhitelistEntry(row db.AlphaWhitelistEntry) AlphaWhitelistEntry {
	var createdBy *int64
	if row.CreatedBy.Valid {
		value := row.CreatedBy.Int64
		createdBy = &value
	}

	return AlphaWhitelistEntry{
		ID:            row.ID,
		IdentityType:  row.IdentityType,
		IdentityValue: row.IdentityValue,
		CreatedBy:     createdBy,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}
}

func mapWaitlistEntry(row db.AlphaWaitlistEntry) AlphaWaitlistEntry {
	var approvedBy *int64
	if row.ApprovedBy.Valid {
		value := row.ApprovedBy.Int64
		approvedBy = &value
	}

	var approvedAt *time.Time
	if row.ApprovedAt.Valid {
		value := row.ApprovedAt.Time
		approvedAt = &value
	}

	return AlphaWaitlistEntry{
		ID:              row.ID,
		Email:           row.Email,
		GithubUsername:  row.GithubUsername,
		GithubAvatarURL: row.GithubAvatarUrl,
		Note:            row.Note,
		Status:          row.Status,
		Source:          row.Source,
		ApprovedBy:      approvedBy,
		ApprovedAt:      approvedAt,
		CreatedAt:       row.CreatedAt,
		UpdatedAt:       row.UpdatedAt,
	}
}

package services

import (
	"context"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type CanaryResultStore interface {
	UpsertCanaryResult(context.Context, db.UpsertCanaryResultParams) (db.CanaryResult, error)
	ResolveCanaryAlertIncidents(context.Context, db.ResolveCanaryAlertIncidentsParams) (int64, error)
}

type CanaryReportInput struct {
	Suite   string               `json:"suite"`
	RunID   string               `json:"run_id"`
	Results []CanaryReportResult `json:"results"`
}
type CanaryReportResult struct {
	Test            string  `json:"test"`
	Status          string  `json:"status"`
	DurationSeconds float64 `json:"duration_seconds"`
	Error           string  `json:"error"`
}

type CanaryReportService struct{ queries CanaryResultStore }

func NewCanaryReportService(q CanaryResultStore) *CanaryReportService {
	return &CanaryReportService{queries: q}
}

// CanaryIncidentCondition is pinned to the backend runner and Playwright
// reporter. Unknown suites may report results but cannot close incidents.
func CanaryIncidentCondition(suite string) string {
	switch suite {
	case "workflow":
		return "Backend canary probe failing"
	case "playwright":
		return "Playwright canary test failing"
	default:
		return ""
	}
}

func (s *CanaryReportService) ReportResults(ctx context.Context, input CanaryReportInput, reportedAt time.Time) error {
	suite, runID := strings.TrimSpace(input.Suite), strings.TrimSpace(input.RunID)
	if suite == "" {
		return pkgerrors.BadRequest("suite is required")
	}
	if len(input.Results) == 0 {
		return pkgerrors.BadRequest("results must not be empty")
	}
	rows := make([]db.UpsertCanaryResultParams, len(input.Results))
	failures := 0
	for i, result := range input.Results {
		name, status := strings.TrimSpace(result.Test), strings.ToLower(strings.TrimSpace(result.Status))
		if name == "" {
			return pkgerrors.BadRequest("result test is required")
		}
		if status != "success" && status != "failure" {
			return pkgerrors.BadRequest("result status must be success or failure")
		}
		if result.DurationSeconds < 0 || math.IsNaN(result.DurationSeconds) || math.IsInf(result.DurationSeconds, 0) {
			return pkgerrors.BadRequest("result duration_seconds must be non-negative and finite")
		}
		if status == "failure" {
			failures++
		}
		rows[i] = db.UpsertCanaryResultParams{Suite: suite, TestName: name, Status: status, DurationSeconds: result.DurationSeconds, ErrorMessage: strings.TrimSpace(result.Error), RunID: runID, ReportedAt: reportedAt.UTC()}
	}
	record := func(q CanaryResultStore) error {
		for _, row := range rows {
			if _, err := q.UpsertCanaryResult(ctx, row); err != nil {
				return pkgerrors.Internal("failed to persist canary result")
			}
		}
		if condition := CanaryIncidentCondition(suite); failures == 0 && condition != "" {
			if _, err := q.ResolveCanaryAlertIncidents(ctx, db.ResolveCanaryAlertIncidentsParams{ConditionName: condition, ResolvedBy: pgtype.Text{String: "canary:" + runID, Valid: true}}); err != nil {
				return pkgerrors.Internal("failed to resolve canary incidents")
			}
		}
		return nil
	}
	if txq, ok := s.queries.(incidentTransactionalQuerier); ok {
		tx, err := txq.BeginTx(ctx)
		if err != nil {
			return pkgerrors.Internal("failed to begin canary report")
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := record(txq.WithTx(tx)); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return pkgerrors.Internal("failed to commit canary report")
		}
		return nil
	}
	return record(s.queries)
}

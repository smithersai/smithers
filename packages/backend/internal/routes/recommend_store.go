package routes

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type PostgresRecommendationLog struct{ Pool *pgxpool.Pool }

func NewPostgresRecommendationLog(pool *pgxpool.Pool) *PostgresRecommendationLog {
	return &PostgresRecommendationLog{Pool: pool}
}

func (s *PostgresRecommendationLog) AppendRecommendation(ctx context.Context, input ports.RecommendationRequest, result ports.RecommendationResult, digest string) (string, error) {
	id := uuid.NewString()
	var repo any
	if input.Repo != nil {
		repo = *input.Repo
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO recommendation_logs (id, repo, tail_digest, command_count, commands, model) VALUES ($1,$2,$3,$4,$5,$6)`, id, repo, digest, len(input.Commands), result.Commands, result.Model)
	return id, err
}

func (s *PostgresRecommendationLog) RecordRecommendationOutcome(ctx context.Context, id, command string, at time.Time) (int, error) {
	result, err := s.Pool.Exec(ctx, `UPDATE recommendation_logs SET outcome_command=$2, outcome_at=$3 WHERE id=$1 AND outcome_command IS NULL`, id, command, at)
	if err != nil {
		return 0, err
	}
	if result.RowsAffected() == 1 {
		return 204, nil
	}
	var exists bool
	if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recommendation_logs WHERE id=$1)`, id).Scan(&exists); err != nil {
		return 0, err
	}
	if !exists {
		return 404, nil
	}
	return 409, nil
}

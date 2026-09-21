package db

import (
	"context"
)

const createWorkflowTrigger = `
INSERT INTO workflow_triggers (
	repository_id,
	workflow_definition_id,
	workflow_path,
	event_type,
	event_action,
	enabled
)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (repository_id, workflow_path, event_type, event_action)
DO UPDATE SET
	workflow_definition_id = EXCLUDED.workflow_definition_id,
	enabled = EXCLUDED.enabled,
	updated_at = NOW()
RETURNING id, repository_id, workflow_definition_id, workflow_path, event_type, event_action, enabled, created_at, updated_at
`

type CreateWorkflowTriggerParams struct {
	RepositoryID         int64  `json:"repository_id"`
	WorkflowDefinitionID int64  `json:"workflow_definition_id"`
	WorkflowPath         string `json:"workflow_path"`
	EventType            string `json:"event_type"`
	EventAction          string `json:"event_action"`
	Enabled              bool   `json:"enabled"`
}

func (q *Queries) CreateWorkflowTrigger(ctx context.Context, arg CreateWorkflowTriggerParams) (WorkflowTrigger, error) {
	row := q.db.QueryRow(
		ctx,
		createWorkflowTrigger,
		arg.RepositoryID,
		arg.WorkflowDefinitionID,
		arg.WorkflowPath,
		arg.EventType,
		arg.EventAction,
		arg.Enabled,
	)

	var item WorkflowTrigger
	err := row.Scan(
		&item.ID,
		&item.RepositoryID,
		&item.WorkflowDefinitionID,
		&item.WorkflowPath,
		&item.EventType,
		&item.EventAction,
		&item.Enabled,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	return item, err
}

const listWorkflowTriggersByRepository = `
SELECT id, repository_id, workflow_definition_id, workflow_path, event_type, event_action, enabled, created_at, updated_at
FROM workflow_triggers
WHERE repository_id = $1
  AND enabled = TRUE
ORDER BY id ASC
`

func (q *Queries) ListWorkflowTriggersByRepository(ctx context.Context, repositoryID int64) ([]WorkflowTrigger, error) {
	rows, err := q.db.Query(ctx, listWorkflowTriggersByRepository, repositoryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]WorkflowTrigger, 0)
	for rows.Next() {
		var item WorkflowTrigger
		if err := rows.Scan(
			&item.ID,
			&item.RepositoryID,
			&item.WorkflowDefinitionID,
			&item.WorkflowPath,
			&item.EventType,
			&item.EventAction,
			&item.Enabled,
			&item.CreatedAt,
			&item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

const disableWorkflowTriggersByRepositoryPath = `
UPDATE workflow_triggers
SET enabled = FALSE,
    updated_at = NOW()
WHERE repository_id = $1
  AND workflow_path = $2
`

type DisableWorkflowTriggersByRepositoryPathParams struct {
	RepositoryID int64  `json:"repository_id"`
	WorkflowPath string `json:"workflow_path"`
}

func (q *Queries) DisableWorkflowTriggersByRepositoryPath(ctx context.Context, arg DisableWorkflowTriggersByRepositoryPathParams) error {
	_, err := q.db.Exec(ctx, disableWorkflowTriggersByRepositoryPath, arg.RepositoryID, arg.WorkflowPath)
	return err
}

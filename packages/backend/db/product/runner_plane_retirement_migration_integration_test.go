package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Migration 0031 retires the runner plane: every runner-plane run moves to the
// sandbox plane, a run a runner was executing is requeued with the tasks the
// runner held, and settled tasks and finished runs keep their results.
func TestRunnerPlaneRetirementMigrationMovesRunsToSandbox(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var err error

	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `CREATE TABLE public.smithers_product_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, m := range registered {
		if m.version >= 31 {
			break
		}
		if _, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration %d: %v", m.version, err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO public.smithers_product_migrations (version, checksum) VALUES ($1, $2)`, m.version, m.checksum); err != nil {
			t.Fatal(err)
		}
	}
	// Run 1 was executing on a runner: job a held by runner 5, job b done,
	// job c blocked on a. Run 2 was queued, run 3 finished, run 4 is already
	// on the sandbox plane.
	if _, err = pool.Exec(ctx, `
		INSERT INTO users (id, username, lower_username) VALUES (1, 'alice', 'alice');
		INSERT INTO repositories (id, name, lower_name, user_id) VALUES (1, 'app', 'app', 1);
		INSERT INTO workflow_definitions (id, repository_id, name, path, config) VALUES (1, 1, 'ci', '.smithers/workflows/ci.tsx', '{}');
		INSERT INTO workflow_runs (id, repository_id, workflow_definition_id, status, trigger_event, execution_plane) VALUES
			(1, 1, 1, 'running', 'push', 'runner'),
			(2, 1, 1, 'queued', 'push', 'runner'),
			(3, 1, 1, 'success', 'push', 'runner'),
			(4, 1, 1, 'queued', 'push', 'sandbox');
		INSERT INTO workflow_steps (id, workflow_run_id, repository_id, name, position, status) VALUES
			(11, 1, 1, 'a', 1, 'running'),
			(12, 1, 1, 'b', 2, 'success'),
			(13, 1, 1, 'c', 3, 'queued'),
			(21, 2, 1, 'a', 1, 'queued'),
			(31, 3, 1, 'a', 1, 'success');
		INSERT INTO workflow_tasks (id, workflow_run_id, workflow_step_id, repository_id, status, payload, runner_id, assigned_at, started_at) VALUES
			(11, 1, 11, 1, 'running', '{"job":"a"}', 5, now(), now()),
			(12, 1, 12, 1, 'done', '{"job":"b"}', 5, now(), now()),
			(13, 1, 13, 1, 'blocked', '{"job":"c"}', NULL, NULL, NULL),
			(21, 2, 21, 1, 'pending', '{"job":"a"}', NULL, NULL, NULL),
			(31, 3, 31, 1, 'done', '{"job":"a"}', 6, now(), now());`); err != nil {
		t.Fatal(err)
	}
	if err = Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}

	runs := map[int64]string{}
	rows, err := pool.Query(ctx, `SELECT id, status || '/' || execution_plane FROM workflow_runs ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		var state string
		if err = rows.Scan(&id, &state); err != nil {
			t.Fatal(err)
		}
		runs[id] = state
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[int64]string{1: "queued/sandbox", 2: "queued/sandbox", 3: "success/sandbox", 4: "queued/sandbox"} {
		if runs[id] != want {
			t.Errorf("run %d = %q, want %q", id, runs[id], want)
		}
	}

	type taskState struct {
		status, step string
		runner       bool
		started      bool
	}
	tasks := map[int64]taskState{}
	rows, err = pool.Query(ctx, `SELECT wt.id, wt.status, ws.status, wt.runner_id IS NOT NULL, wt.started_at IS NOT NULL
		FROM workflow_tasks wt JOIN workflow_steps ws ON ws.id = wt.workflow_step_id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		var state taskState
		if err = rows.Scan(&id, &state.status, &state.step, &state.runner, &state.started); err != nil {
			t.Fatal(err)
		}
		tasks[id] = state
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[int64]taskState{
		11: {status: "pending", step: "queued"},
		12: {status: "done", step: "success", runner: true, started: true},
		13: {status: "blocked", step: "queued"},
		21: {status: "pending", step: "queued"},
		31: {status: "done", step: "success", runner: true, started: true},
	} {
		if tasks[id] != want {
			t.Errorf("task %d = %+v, want %+v", id, tasks[id], want)
		}
	}

	var defaultPlane string
	if err = pool.QueryRow(ctx, `INSERT INTO workflow_runs (id, repository_id, workflow_definition_id, status, trigger_event) VALUES (5, 1, 1, 'queued', 'push') RETURNING execution_plane`).Scan(&defaultPlane); err != nil || defaultPlane != "sandbox" {
		t.Fatalf("default plane = %q, err %v", defaultPlane, err)
	}
	if _, err = pool.Exec(ctx, `UPDATE workflow_runs SET execution_plane = 'runner' WHERE id = 4`); err == nil {
		t.Fatal("execution_plane must stay immutable apart from leaving the runner plane")
	}

	// Alert remediation runs are sandbox-plane CI runs: the dispatch token
	// stays unique across them.
	if _, err = pool.Exec(ctx, `INSERT INTO workflow_runs (id, repository_id, workflow_definition_id, status, trigger_event, execution_plane, dispatch_inputs)
		VALUES (6, 1, 1, 'queued', 'monitoring_alert', 'sandbox', '{"remediation_dispatch_token":"t1"}')`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO workflow_runs (id, repository_id, workflow_definition_id, status, trigger_event, execution_plane, dispatch_inputs)
		VALUES (7, 1, 1, 'queued', 'monitoring_alert', 'sandbox', '{"remediation_dispatch_token":"t1"}')`); err == nil {
		t.Fatal("a remediation dispatch token must stay unique on the sandbox plane")
	}
}

# Database Schema — Stacks and Workflow Triggers

**Repo:** plue (JJHub Go backend)
**Feature:** Database
**Priority:** P0 — blocks stack submit and workflow triggers

## Description

Create new database tables for stack ↔ PR mapping and workflow trigger configuration.

## Acceptance Criteria

- [ ] Migration file: `db/migrations/000031_smithers_cloud_mvp.sql`
- [ ] `stacks` table: id, repo_id, user_id, target_ref, state, timestamps
- [ ] `stack_changes` table: id, stack_id, change_id, position, branch_name, pr_number, pr_state, review_status, ci_status, timestamps. Unique on (stack_id, position)
- [ ] `workflow_triggers` table: id, repo_id, workflow_path, event_type, event_action, enabled, timestamps
- [ ] Indexes on: stacks(repo_id, state), stack_changes(stack_id), workflow_triggers(repo_id, event_type)
- [ ] sqlc queries generated for all CRUD operations

## E2E Test

```
1. Run migration → tables created
2. Insert stack → success
3. Insert stack_changes with unique positions → success
4. Insert duplicate position → unique constraint violation
5. Query stacks by repo_id → returns correct results
```

## Reference

- Engineering doc §7
- Existing migrations: `db/migrations/`

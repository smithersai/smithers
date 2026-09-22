-- Product branch-lock generation and durable workflow invocation state.
-- Approval belongs to one acquisition of a branch, not every future holder.
ALTER TABLE branch_locks
    ADD COLUMN generation UUID NOT NULL DEFAULT gen_random_uuid();

-- Historical requests cannot be proven to belong to the current acquisition.
-- Keep the audit rows while requiring a fresh request for current membership.
ALTER TABLE branch_lock_join_requests
    ADD COLUMN lock_generation UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE branch_lock_join_requests ALTER COLUMN lock_generation DROP DEFAULT;

DROP INDEX uq_branch_lock_join_requests_pending;
CREATE UNIQUE INDEX uq_branch_lock_join_requests_pending
    ON branch_lock_join_requests (repository_id, branch, lock_generation, requester_id)
    WHERE status = 'pending';

-- Public invocation retains its runtime and source independently of mutable definitions.
CREATE TABLE workflow_invocations (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_definition_id BIGINT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    runtime TEXT NOT NULL CHECK (runtime IN ('native-flow-v1', 'legacy-orchestrator-0.28')),
    request_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    flow_path TEXT NOT NULL,
    flow_tag TEXT NOT NULL,
    source_commit TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    dispatch_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    trigger_event TEXT NOT NULL,
    trigger_ref TEXT NOT NULL,
    sandbox_id TEXT NOT NULL DEFAULT '',
    host_artifact_digest TEXT NOT NULL DEFAULT '',
    plan JSONB,
    run_request JSONB,
    attempted_at TIMESTAMPTZ,
    host_run_id TEXT NOT NULL DEFAULT '',
    final_output JSONB,
    cancel_acknowledged_at TIMESTAMPTZ,
    cleaned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, request_key),
    CHECK (runtime <> 'native-flow-v1' OR (flow_path = 'flows/' || flow_tag || '/flow.ts' AND source_commit <> '' AND source_digest ~ '^[a-f0-9]{64}$')),
    CHECK (run_request IS NULL OR COALESCE(jsonb_typeof(run_request) = 'object' AND run_request->>'_tag' = 'Plan' AND run_request->>'planId' <> '' AND run_request->>'digest' <> '' AND run_request->>'idempotencyKey' = 'workflow-invoke:' || workflow_run_id::text || ':run', FALSE))
);
CREATE INDEX workflow_invocations_pending_cleanup ON workflow_invocations (workflow_run_id) WHERE runtime = 'native-flow-v1' AND cleaned_at IS NULL;

-- Existing sandbox rows may gain tasks after admission; their NixCI selection
-- still takes precedence. No-task rows keep this explicit legacy drain identity.
INSERT INTO workflow_invocations (workflow_run_id, repository_id, workflow_definition_id, runtime, request_key, request_digest, flow_path, flow_tag, source_commit, source_digest, dispatch_inputs, trigger_event, trigger_ref)
SELECT wr.id, wr.repository_id, wr.workflow_definition_id, 'legacy-orchestrator-0.28', 'legacy:' || wr.id::text, '', wd.path, wd.name, wr.trigger_commit_sha, '', COALESCE(wr.dispatch_inputs, '{}'::jsonb), wr.trigger_event, wr.trigger_ref
FROM workflow_runs wr JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
WHERE wr.execution_plane = 'sandbox';

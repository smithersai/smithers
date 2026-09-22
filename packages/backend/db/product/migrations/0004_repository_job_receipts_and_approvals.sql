-- Retain the gateway proof behind each reserved repository CI commit status.
-- A request id is idempotent only within the reviewed CI registration.
CREATE TABLE repository_ci_check_receipts (
    id               bigserial PRIMARY KEY,
    repository_id    bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    registration_id  uuid   NOT NULL REFERENCES repository_job_registrations(id) ON DELETE CASCADE,
    revision         bigint NOT NULL,
    digest           text   NOT NULL,
    execution_digest text   NOT NULL,
    workspace_id     uuid   NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id           text   NOT NULL,
    execution_id     text   NOT NULL,
    commit_sha       text   NOT NULL,
    change_id        text   NOT NULL,
    base_commit_sha  text   NOT NULL,
    checks           jsonb  NOT NULL,
    context          text   NOT NULL,
    commit_status_id bigint NOT NULL REFERENCES commit_statuses(id) ON DELETE CASCADE,
    request_id       text   NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (registration_id, request_id)
);

CREATE INDEX idx_repository_ci_check_receipts_repo_commit
    ON repository_ci_check_receipts (repository_id, commit_sha);

-- Human approval provenance for reviewed repository flow plans. The service
-- supplies approved_by from the authenticated session and approved_at from
-- PostgreSQL; neither field is accepted from a host, flow, or model.
CREATE TABLE repository_job_approvals (
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    job           text   NOT NULL,
    plan_digest   text   NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
    plan_id       text   NOT NULL,
    flow_id       text   NOT NULL,
    envelope      jsonb  NOT NULL,
    approved_by   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    approved_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repository_id, job, plan_digest)
);

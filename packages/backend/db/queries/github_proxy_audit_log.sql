-- name: InsertGithubProxyAuditLog :exec
INSERT INTO github_proxy_audit_log (
    workflow_run_id,
    method,
    path,
    status_code,
    decision,
    reason
)
VALUES ($1, $2, $3, $4, $5, $6);

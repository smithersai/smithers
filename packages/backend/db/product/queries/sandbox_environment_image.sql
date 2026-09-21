-- Product queries extracted from the transitional Plue source.

-- name: UpsertSandboxEnvironmentImage :one
-- Registers a built NixOS environment image. Re-registering the same
-- (repository, kind, closure hash) refreshes the image reference and revives a
-- retired row: the closure hash is the content identity. Platform base-image
-- registration atomically retires every prior ready base for the same kind;
-- repository images retain their explicit history until the repo admin retires
-- them.
SELECT * FROM register_sandbox_environment_image(
    sqlc.narg(repository_id)::bigint,
    sqlc.arg(kind)::text,
    sqlc.arg(source)::text,
    sqlc.arg(source_revision)::text,
    sqlc.arg(closure_hash)::text,
    sqlc.arg(image)::text,
    sqlc.narg(created_by)::bigint
);


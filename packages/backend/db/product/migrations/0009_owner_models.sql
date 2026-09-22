-- Model credentials and the selected chat model belong to the account.
-- A repository secret may still override a repository-scoped turn.
CREATE TABLE owner_model_credentials (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    origin TEXT NOT NULL,
    value_encrypted TEXT,
    PRIMARY KEY (user_id, name)
);

CREATE TABLE owner_model_defaults (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    model JSONB NOT NULL
);

CREATE TABLE owner_model_credential_receipts (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    result JSONB NOT NULL,
    PRIMARY KEY (user_id, request_id)
);

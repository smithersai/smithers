-- Dev seed data for local development
-- Creates user "alice" and stable API tokens used by E2E tests.

-- Dev owner user (stable id for existing local setups).
INSERT INTO users (id, username, lower_username, email, display_name, is_active, is_admin)
VALUES (1, 'alice', 'alice', 'alice@localhost', 'Alice Dev', TRUE, TRUE)
ON CONFLICT (id) DO UPDATE
SET username = EXCLUDED.username,
    lower_username = EXCLUDED.lower_username,
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    is_active = EXCLUDED.is_active,
    is_admin = EXCLUDED.is_admin,
    updated_at = NOW();

-- Team member fixture user (explicit id avoids sequence races in concurrent test runs).
INSERT INTO users (id, username, lower_username, email, display_name, is_active, is_admin)
VALUES (1001, 'bob', 'bob', 'bob@localhost', 'Bob Dev', TRUE, FALSE)
ON CONFLICT (lower_username) DO UPDATE
SET username = EXCLUDED.username,
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    is_active = EXCLUDED.is_active,
    is_admin = EXCLUDED.is_admin,
    updated_at = NOW();

-- Keep sequence in sync after explicit user IDs.
SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE((SELECT MAX(id) FROM users), 1), true);

-- Closed alpha whitelist bootstrap: seeded users + test wallet.
INSERT INTO alpha_whitelist_entries (identity_type, identity_value, lower_identity_value, created_by)
SELECT 'email', 'alice@localhost', 'alice@localhost', u.id
FROM users u
WHERE u.lower_username = 'alice'
ON CONFLICT (identity_type, lower_identity_value) DO UPDATE
SET identity_value = EXCLUDED.identity_value,
    created_by = EXCLUDED.created_by,
    updated_at = NOW();

INSERT INTO alpha_whitelist_entries (identity_type, identity_value, lower_identity_value, created_by)
SELECT 'email', 'bob@localhost', 'bob@localhost', u.id
FROM users u
WHERE u.lower_username = 'alice'
ON CONFLICT (identity_type, lower_identity_value) DO UPDATE
SET identity_value = EXCLUDED.identity_value,
    created_by = EXCLUDED.created_by,
    updated_at = NOW();

-- Hardhat account #0 used by auth key E2E tests.
INSERT INTO alpha_whitelist_entries (identity_type, identity_value, lower_identity_value, created_by)
SELECT 'wallet', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', u.id
FROM users u
WHERE u.lower_username = 'alice'
ON CONFLICT (identity_type, lower_identity_value) DO UPDATE
SET identity_value = EXCLUDED.identity_value,
    created_by = EXCLUDED.created_by,
    updated_at = NOW();

-- Deterministic SSH key fixture for alice (used by SSH E2E tests).
INSERT INTO ssh_keys (user_id, name, public_key, fingerprint, key_type)
VALUES (
    (SELECT id FROM users WHERE lower_username = 'alice' LIMIT 1),
    'dev-e2e-ed25519',
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBOA75LM0xNt2UMZeBNHKxvCzpUUMADn/8bJB/fK6MBW smithers-e2e-test',
    'SHA256:W5cnWyLAtTNZRLHaxiYwOAdufzSVhy7X+gE388XiYFI',
    'user'
)
ON CONFLICT (fingerprint) DO UPDATE
SET user_id = EXCLUDED.user_id,
    name = EXCLUDED.name,
    public_key = EXCLUDED.public_key,
    key_type = EXCLUDED.key_type,
    updated_at = NOW();

INSERT INTO organizations (name, lower_name, description, visibility, website, location)
VALUES ('acme', 'acme', 'Seeded organization for E2E', 'public', '', '')
ON CONFLICT (lower_name) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    visibility = EXCLUDED.visibility,
    website = EXCLUDED.website,
    location = EXCLUDED.location,
    updated_at = NOW();

INSERT INTO organizations (name, lower_name, description, visibility, website, location)
VALUES ('beta', 'beta', 'Second seeded organization for pagination E2E', 'public', '', '')
ON CONFLICT (lower_name) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    visibility = EXCLUDED.visibility,
    website = EXCLUDED.website,
    location = EXCLUDED.location,
    updated_at = NOW();

SELECT setval(pg_get_serial_sequence('organizations', 'id'), COALESCE((SELECT MAX(id) FROM organizations), 1), true);
SELECT setval(pg_get_serial_sequence('org_members', 'id'), COALESCE((SELECT MAX(id) FROM org_members), 1), true);
SELECT setval(pg_get_serial_sequence('repositories', 'id'), COALESCE((SELECT MAX(id) FROM repositories), 1), true);
SELECT setval(pg_get_serial_sequence('access_tokens', 'id'), COALESCE((SELECT MAX(id) FROM access_tokens), 1), true);

-- First-party OAuth2 public client used by Smithers GUI/iOS for native-app
-- Authorization Code + PKCE sign-in.
INSERT INTO oauth2_applications (
    client_id,
    client_secret_hash,
    name,
    redirect_uris,
    scopes,
    owner_id,
    confidential
)
SELECT
    'smithers_first_party_apps',
    'public-client-no-secret',
    'plue first-party apps (gui, iOS)',
    ARRAY[
        'smithers://oauth2/callback',
        'smithers://auth/callback',
        'http://127.0.0.1/callback',
        'http://[::1]/callback'
    ],
    ARRAY['read:user', 'write:user', 'read:repository', 'write:repository', 'read:org'],
    u.id,
    FALSE
FROM users u
WHERE u.is_admin = TRUE
ORDER BY u.id ASC
LIMIT 1
ON CONFLICT (client_id) DO UPDATE
SET client_secret_hash = EXCLUDED.client_secret_hash,
    name = EXCLUDED.name,
    redirect_uris = EXCLUDED.redirect_uris,
    scopes = EXCLUDED.scopes,
    owner_id = EXCLUDED.owner_id,
    confidential = EXCLUDED.confidential,
    updated_at = NOW();

INSERT INTO org_members (organization_id, user_id, role)
SELECT o.id, u.id, 'owner'
FROM organizations o
JOIN users u ON u.lower_username = 'alice'
WHERE o.lower_name = 'acme'
ON CONFLICT (organization_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    updated_at = NOW();

INSERT INTO org_members (organization_id, user_id, role)
SELECT o.id, u.id, 'member'
FROM organizations o
JOIN users u ON u.lower_username = 'bob'
WHERE o.lower_name = 'acme'
ON CONFLICT (organization_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    updated_at = NOW();

INSERT INTO org_members (organization_id, user_id, role)
SELECT o.id, u.id, 'owner'
FROM organizations o
JOIN users u ON u.lower_username = 'alice'
WHERE o.lower_name = 'beta'
ON CONFLICT (organization_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    updated_at = NOW();

INSERT INTO repo_storage_sets (id, desired_replicas, write_quorum, state)
VALUES ('s1', 3, 2, 'active')
ON CONFLICT (id) DO UPDATE
SET desired_replicas = EXCLUDED.desired_replicas,
    write_quorum = EXCLUDED.write_quorum,
    state = EXCLUDED.state,
    updated_at = NOW();

INSERT INTO repo_storage_nodes (id, storage_set_id, url, state)
VALUES ('s1-primary', 's1', 'http://smithers-repo-host-s1:8080', 'active')
ON CONFLICT (id) DO UPDATE
SET storage_set_id = EXCLUDED.storage_set_id,
    url = EXCLUDED.url,
    state = EXCLUDED.state,
    updated_at = NOW();

-- The local seed remains idempotent after a previously running API contracts
-- repository provisioning enforcement. Preserve that durable rollout state
-- while using the migration's legacy compatibility window for fixture rows.
-- Keeping the override in a transaction guarantees an insertion failure cannot
-- strand enforcement in the permissive state.
BEGIN;
-- Serialize the snapshot with rollout control changes. Without this row lock,
-- an API can enable the fence after the snapshot SELECT and have the seed
-- transaction restore the stale FALSE value at the end.
SELECT enforce_insert_fence
FROM repository_provisioning_control
WHERE singleton
FOR UPDATE;

CREATE TEMP TABLE seed_repository_provisioning_control_snapshot ON COMMIT DROP AS
SELECT enforce_insert_fence
FROM repository_provisioning_control
WHERE singleton;

UPDATE repository_provisioning_control
SET enforce_insert_fence = FALSE,
    updated_at = NOW()
WHERE singleton;

INSERT INTO repositories (org_id, name, lower_name, description, storage_set_id, is_public, default_bookmark)
SELECT o.id, 'acme-repo', 'acme-repo', 'Seeded org repo for E2E', 's1', TRUE, 'main'
FROM organizations o
WHERE o.lower_name = 'acme'
ON CONFLICT (org_id, lower_name) WHERE org_id IS NOT NULL DO UPDATE
SET description = EXCLUDED.description,
    storage_set_id = EXCLUDED.storage_set_id,
    is_public = EXCLUDED.is_public,
    default_bookmark = EXCLUDED.default_bookmark,
    updated_at = NOW();

INSERT INTO repositories (user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark)
SELECT u.id, 'alice-profile-repo', 'alice-profile-repo', 'Seeded profile repo for Alice', 's1', TRUE, 'main'
FROM users u
WHERE u.lower_username = 'alice'
ON CONFLICT (user_id, lower_name) WHERE org_id IS NULL DO UPDATE
SET description = EXCLUDED.description,
    storage_set_id = EXCLUDED.storage_set_id,
    is_public = EXCLUDED.is_public,
    default_bookmark = EXCLUDED.default_bookmark,
    updated_at = NOW();

INSERT INTO repositories (user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark)
SELECT u.id, 'bob-starred-a', 'bob-starred-a', 'Seeded starred repo A', 's1', TRUE, 'main'
FROM users u
WHERE u.lower_username = 'bob'
ON CONFLICT (user_id, lower_name) WHERE org_id IS NULL DO UPDATE
SET description = EXCLUDED.description,
    storage_set_id = EXCLUDED.storage_set_id,
    is_public = EXCLUDED.is_public,
    default_bookmark = EXCLUDED.default_bookmark,
    updated_at = NOW();

INSERT INTO repositories (user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark)
SELECT u.id, 'bob-starred-b', 'bob-starred-b', 'Seeded starred repo B', 's1', TRUE, 'main'
FROM users u
WHERE u.lower_username = 'bob'
ON CONFLICT (user_id, lower_name) WHERE org_id IS NULL DO UPDATE
SET description = EXCLUDED.description,
    storage_set_id = EXCLUDED.storage_set_id,
    is_public = EXCLUDED.is_public,
    default_bookmark = EXCLUDED.default_bookmark,
    updated_at = NOW();

UPDATE repository_provisioning_control AS control
SET enforce_insert_fence = snapshot.enforce_insert_fence,
    updated_at = NOW()
FROM seed_repository_provisioning_control_snapshot AS snapshot
WHERE control.singleton;
COMMIT;

INSERT INTO stars (user_id, repository_id)
SELECT u.id, r.id
FROM users u
JOIN repositories r ON r.lower_name IN ('acme-repo', 'bob-starred-a')
WHERE u.lower_username = 'alice'
ON CONFLICT (user_id, repository_id) DO NOTHING;

UPDATE repositories r
SET num_stars = (
    SELECT COUNT(*)::bigint
    FROM stars s
    WHERE s.repository_id = r.id
);

INSERT INTO audit_log (event_type, actor_id, actor_name, target_type, target_id, target_name, action, metadata, ip_address)
SELECT
    'repo.create',
    u.id,
    u.username,
    'repository',
    r.id,
    u.username || '/' || r.name,
    'create',
    '{}'::jsonb,
    '127.0.0.1'
FROM users u
JOIN repositories r ON r.user_id = u.id
WHERE u.lower_username = 'alice'
  AND r.lower_name = 'alice-profile-repo'
  AND NOT EXISTS (
      SELECT 1
      FROM audit_log al
      WHERE al.event_type = 'repo.create'
        AND al.actor_id = u.id
        AND al.target_id = r.id
        AND al.action = 'create'
  );

-- Well-known dev token: smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
-- SHA-256 hash of the token string.
INSERT INTO access_tokens (id, user_id, name, token_hash, token_last_eight, scopes)
VALUES (
    1,
    (SELECT id FROM users WHERE lower_username = 'alice' LIMIT 1),
    'dev-token',
    encode(digest('smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'sha256'), 'hex'),
    'deadbeef',
    'write:repository,write:user,write:organization'
)
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id,
    name = EXCLUDED.name,
    token_hash = EXCLUDED.token_hash,
    token_last_eight = EXCLUDED.token_last_eight,
    scopes = EXCLUDED.scopes,
    updated_at = NOW();

-- Read-only token: smithers_feedfacefeedfacefeedfacefeedfacefeedface
INSERT INTO access_tokens (id, user_id, name, token_hash, token_last_eight, scopes)
VALUES (
    2,
    (SELECT id FROM users WHERE lower_username = 'alice' LIMIT 1),
    'dev-read-token',
    encode(digest('smithers_feedfacefeedfacefeedfacefeedfacefeedface', 'sha256'), 'hex'),
    'feedface',
    'read:repository,read:organization'
)
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id,
    name = EXCLUDED.name,
    token_hash = EXCLUDED.token_hash,
    token_last_eight = EXCLUDED.token_last_eight,
    scopes = EXCLUDED.scopes,
    updated_at = NOW();

-- Non-admin write token for bob: smithers_cafebabecafebabecafebabecafebabecafebabe
INSERT INTO access_tokens (id, user_id, name, token_hash, token_last_eight, scopes)
VALUES (
    3,
    (SELECT id FROM users WHERE lower_username = 'bob' LIMIT 1),
    'dev-bob-write-token',
    encode(digest('smithers_cafebabecafebabecafebabecafebabecafebabe', 'sha256'), 'hex'),
    'cafebabe',
    'write:user,read:repository,write:repository'
)
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id,
    name = EXCLUDED.name,
    token_hash = EXCLUDED.token_hash,
    token_last_eight = EXCLUDED.token_last_eight,
    scopes = EXCLUDED.scopes,
    updated_at = NOW();

SELECT setval(pg_get_serial_sequence('access_tokens', 'id'), COALESCE((SELECT MAX(id) FROM access_tokens), 1), true);

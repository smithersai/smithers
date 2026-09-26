-- The one-time signup credit is granted once per human login identity:
-- 'user:<id>' and '<provider>:<provider_user_id>' for each linked OAuth
-- login. There is no foreign key, so a deleted user or credit account cannot
-- free its identity for a second grant. Organizations receive none.
CREATE TABLE credit_signup_identities (
    identity text PRIMARY KEY CHECK (identity <> ''),
    account_id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO credit_signup_identities (identity, account_id)
SELECT 'user:' || a.owner_id, a.id
FROM credit_accounts a
JOIN credit_grants g ON g.account_id = a.id AND g.source_key = 'signup_grant'
WHERE a.owner_type = 'user'
ON CONFLICT (identity) DO NOTHING;

INSERT INTO credit_signup_identities (identity, account_id)
SELECT DISTINCT ON (1) lower(btrim(o.provider)) || ':' || btrim(o.provider_user_id), a.id
FROM credit_accounts a
JOIN credit_grants g ON g.account_id = a.id AND g.source_key = 'signup_grant'
JOIN oauth_accounts o ON o.user_id = a.owner_id
WHERE a.owner_type = 'user' AND btrim(o.provider) <> '' AND btrim(o.provider_user_id) <> ''
ORDER BY 1, a.id
ON CONFLICT (identity) DO NOTHING;

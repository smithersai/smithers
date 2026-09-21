-- Repair migration/schema drift for issue_assignees.
--
-- The baseline migration created issue_assignees with a composite primary key,
-- while db/schema.sql and generated sqlc code now expect a surrogate id and a
-- partial unique index over active assignments. Preserve existing assignments
-- and make deleted users become tombstones via ON DELETE SET NULL.

-- smithers:migration-contract-reviewed: release readiness repair drops only constraints, not data.
ALTER TABLE issue_assignees DROP CONSTRAINT IF EXISTS issue_assignees_pkey;

ALTER TABLE issue_assignees ADD COLUMN IF NOT EXISTS id BIGINT;

CREATE SEQUENCE IF NOT EXISTS issue_assignees_id_seq;
ALTER SEQUENCE issue_assignees_id_seq OWNED BY issue_assignees.id;

SELECT setval(
    'issue_assignees_id_seq',
    COALESCE((SELECT MAX(id) FROM issue_assignees), 0) + 1,
    false
);

UPDATE issue_assignees
SET id = nextval('issue_assignees_id_seq')
WHERE id IS NULL;

ALTER TABLE issue_assignees
    ALTER COLUMN id SET DEFAULT nextval('issue_assignees_id_seq'::regclass);

-- smithers:migration-contract-reviewed: id is backfilled above before enforcing NOT NULL.
ALTER TABLE issue_assignees ALTER COLUMN id SET NOT NULL;

ALTER TABLE issue_assignees
    ADD CONSTRAINT issue_assignees_pkey PRIMARY KEY (id);

-- smithers:migration-contract-reviewed: replacing FK action so deleted users leave tombstone rows.
ALTER TABLE issue_assignees DROP CONSTRAINT IF EXISTS issue_assignees_user_id_fkey;

ALTER TABLE issue_assignees ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE issue_assignees
    ADD CONSTRAINT issue_assignees_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_assignees_issue_user
    ON issue_assignees (issue_id, user_id)
    WHERE user_id IS NOT NULL;

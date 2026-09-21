-- Store the structured story produced by smithers review against the exact
-- immutable change revision it describes. Re-running review for a revision
-- replaces that revision's artifact without affecting any historical one.
CREATE TABLE change_walkthroughs (
    id                 BIGSERIAL PRIMARY KEY,
    change_revision_id BIGINT NOT NULL UNIQUE REFERENCES change_revisions(id) ON DELETE CASCADE,
    sections           JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sections) = 'array'),
    quiz               JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(quiz) = 'array'),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

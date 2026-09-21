-- Extend the issue lifecycle beyond a generic close. A fixed issue records the
-- principal that supplied the fix; verification must come from a distinct
-- human or agent-session principal.
ALTER TABLE issues
    DROP CONSTRAINT issues_state_check,
    ADD CONSTRAINT issues_state_check
        CHECK (state IN ('open', 'closed', 'fixed', 'verified')),
    ADD COLUMN fixed_by_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN fixed_by_agent_session_id UUID REFERENCES agent_sessions(id) ON DELETE RESTRICT,
    ADD COLUMN fixed_at TIMESTAMPTZ,
    ADD COLUMN verified_by_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN verified_by_agent_session_id UUID REFERENCES agent_sessions(id) ON DELETE RESTRICT,
    ADD COLUMN verified_at TIMESTAMPTZ,
    ADD CONSTRAINT issues_fix_metadata_check CHECK (
        (state IN ('fixed', 'verified') AND fixed_by_id IS NOT NULL AND fixed_at IS NOT NULL)
        OR (state NOT IN ('fixed', 'verified') AND fixed_by_id IS NULL
            AND fixed_by_agent_session_id IS NULL AND fixed_at IS NULL)
    ),
    ADD CONSTRAINT issues_verification_metadata_check CHECK (
        (state = 'verified' AND verified_by_id IS NOT NULL AND verified_at IS NOT NULL)
        OR (state <> 'verified' AND verified_by_id IS NULL
            AND verified_by_agent_session_id IS NULL AND verified_at IS NULL)
    ),
    ADD CONSTRAINT issues_distinct_verifier_check CHECK (
        state <> 'verified'
        OR (
            fixed_by_agent_session_id IS NOT NULL
            AND (verified_by_agent_session_id IS NULL
                 OR verified_by_agent_session_id <> fixed_by_agent_session_id)
        )
        OR (
            fixed_by_agent_session_id IS NULL
            AND (verified_by_agent_session_id IS NOT NULL
                 OR verified_by_id <> fixed_by_id)
        )
    );

-- Both sides of a link are repository-scoped. The additional unique key lets
-- the composite foreign key make cross-repository links impossible even if a
-- future caller bypasses the service queries.
ALTER TABLE issues
    ADD CONSTRAINT issues_repository_id_id_key UNIQUE (repository_id, id);

CREATE TABLE issue_change_links (
    repository_id BIGINT NOT NULL,
    issue_id       BIGINT NOT NULL,
    change_id      VARCHAR(255) NOT NULL,
    link_type      VARCHAR(16) NOT NULL CHECK (link_type IN ('issue', 'closes')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, issue_id, change_id),
    FOREIGN KEY (repository_id, issue_id)
        REFERENCES issues(repository_id, id) ON DELETE CASCADE,
    FOREIGN KEY (repository_id, change_id)
        REFERENCES changes(repository_id, change_id) ON DELETE CASCADE
);

CREATE INDEX idx_issue_change_links_change
    ON issue_change_links (repository_id, change_id, issue_id);

-- Every non-open lifecycle state contributes to the repository's historical
-- closed count. Use an explicit before/after delta now that the state is no
-- longer binary.
CREATE OR REPLACE FUNCTION maintain_repo_issue_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_issues = num_issues + 1,
            num_closed_issues = num_closed_issues
                + CASE WHEN NEW.state <> 'open' THEN 1 ELSE 0 END,
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        UPDATE repositories
        SET num_closed_issues = GREATEST(
                num_closed_issues
                + CASE WHEN NEW.state <> 'open' THEN 1 ELSE 0 END
                - CASE WHEN OLD.state <> 'open' THEN 1 ELSE 0 END,
                0),
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_issues = GREATEST(num_issues - 1, 0),
        num_closed_issues = GREATEST(num_closed_issues
            - CASE WHEN OLD.state <> 'open' THEN 1 ELSE 0 END, 0),
        updated_at = NOW()
    WHERE id = OLD.repository_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

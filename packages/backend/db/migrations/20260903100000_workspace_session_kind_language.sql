-- LSP relay per workspace session (#505). A workspace session is either a
-- terminal (the default, every existing row) or a language-server relay for
-- exactly one language. `language` is set if and only if the session is an
-- LSP session, so a terminal row never carries a stray language and an LSP
-- row never lacks one.
ALTER TABLE workspace_sessions
    ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'terminal',
    ADD COLUMN language VARCHAR(32) NOT NULL DEFAULT '';

ALTER TABLE workspace_sessions
    ADD CONSTRAINT ck_workspace_sessions_kind CHECK (kind IN ('terminal', 'lsp')),
    ADD CONSTRAINT ck_workspace_sessions_language CHECK ((kind = 'lsp') = (language <> ''));

-- One live language server per workspace and language: a second create
-- answers the existing session instead of inserting a sibling, and a race
-- between two creates loses here rather than in application code.
CREATE UNIQUE INDEX idx_workspace_sessions_active_lsp
    ON workspace_sessions (workspace_id, language)
    WHERE kind = 'lsp' AND status IN ('pending', 'starting', 'running');

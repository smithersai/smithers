-- Expand-only: one integer column, defaulted, no rewrite of existing rows.
-- Apply in one transaction.

-- Sandbox checkouts clone the repository's whole history, which on a busy
-- repository is minutes of boot latency nobody uses: the coding flows read at
-- most 100 native commits, and `git fetch --deepen` recovers more on demand.
-- Cloning smithersai/plue from its GitHub mirror measured 154.1s/435MB at full
-- depth against 29.1s/41MB at --depth 200 on 2026-09-15.
--
-- clone_depth is the per-repository escape hatch from that default: 0 takes the
-- platform default, a positive value pins an explicit window, and -1 opts the
-- repository back into full-history clones (for a repository whose build reads
-- deep history, for example `git describe` over old tags).
ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS clone_depth INTEGER NOT NULL DEFAULT 0
        CONSTRAINT repositories_clone_depth_check CHECK (clone_depth >= -1);

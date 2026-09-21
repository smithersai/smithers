-- Persist the GitHub import card's three progress counters. BIGINT keeps the
-- object counter safe for large repositories; non-negative checks prevent a
-- corrupt worker update from producing impossible UI progress.
ALTER TABLE import_jobs
    ADD COLUMN refs_done BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN refs_total BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN objects_done BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN objects_total BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN issues_done BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN issues_total BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT ck_import_jobs_progress_nonnegative CHECK (
        refs_done >= 0 AND refs_total >= 0
        AND objects_done >= 0 AND objects_total >= 0
        AND issues_done >= 0 AND issues_total >= 0
    ),
    ADD CONSTRAINT ck_import_jobs_progress_bounds CHECK (
        refs_done <= refs_total
        AND objects_done <= objects_total
        AND issues_done <= issues_total
    );

-- Migration 000065: add deleted_at to users table for soft-delete/suspend flow.
-- Admin delete paths now set deleted_at rather than hard-deleting users so that
-- all collaboration history (issues, comments, reviews, etc.) is preserved.

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at) WHERE deleted_at IS NOT NULL;

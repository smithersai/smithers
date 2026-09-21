-- No-op: workspace and workspace_sessions tables with WebRTC columns
-- are now included in the baseline migration (000001).
-- This migration is kept for atlas.sum ordering consistency.

-- Clean up legacy table if it exists
DROP TABLE IF EXISTS workspace_input_queue;

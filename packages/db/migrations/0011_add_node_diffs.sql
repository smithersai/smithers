CREATE TABLE IF NOT EXISTS _smithers_node_diffs (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  base_ref TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  computed_at_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id, iteration, base_ref)
);

CREATE TABLE IF NOT EXISTS _smithers_time_travel_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  from_frame_no INTEGER NOT NULL,
  to_frame_no INTEGER NOT NULL,
  caller TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  result TEXT NOT NULL,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS _smithers_time_travel_audit_lookup_idx
  ON _smithers_time_travel_audit (run_id, caller, timestamp_ms);

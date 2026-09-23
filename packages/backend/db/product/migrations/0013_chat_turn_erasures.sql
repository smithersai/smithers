CREATE TABLE chat_turn_erasures (
  run_id text NOT NULL,
  leg_id text NOT NULL,
  access_hash text NOT NULL,
  retired_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, leg_id)
);

-- Product request correlation only. product_job_requests dispatches the one
-- canonical repository/setup Flow; this table is not another execution queue.
CREATE TABLE repository_setup_requests (
 id uuid PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES users(id),
 repository_id bigint NOT NULL REFERENCES repositories(id),
 request_id text NOT NULL,
 job text NOT NULL CHECK (job IN ('issues','review','ci','feature','chores')),
 input jsonb NOT NULL CHECK (jsonb_typeof(input)='object'),
 operation_id uuid NOT NULL UNIQUE REFERENCES product_job_requests(id),
 workspace_id uuid REFERENCES workspaces(id),
 response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
 terminal boolean NOT NULL DEFAULT false,
 observation_error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (user_id,request_id)
);
CREATE INDEX repository_setup_latest ON repository_setup_requests (user_id,repository_id,job,created_at DESC,id DESC);

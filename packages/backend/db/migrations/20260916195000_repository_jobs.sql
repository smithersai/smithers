-- Opt-in bindings for current Smithers Control hosts. These are delivery
-- registrations, not a second workflow format; source stays in .smithers/.
CREATE TABLE repository_job_registrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job text NOT NULL CHECK (job IN ('issues','review','ci','feature','chores')),
    mode text NOT NULL CHECK (mode IN ('trial','enabled')),
    revision bigint NOT NULL CHECK (revision > 0),
    digest text NOT NULL,
    source_revision text NOT NULL,
    flow_id text NOT NULL,
    configuration jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    trial_issue_number bigint NOT NULL DEFAULT 0,
    trial_source text NOT NULL DEFAULT '',
    schedule text NOT NULL DEFAULT '',
    next_fire_at timestamptz,
    activated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, job, mode),
    CHECK (mode <> 'trial' OR (trial_issue_number > 0 AND trial_source IN ('github','smithers-cloud')))
);

-- Admission is written before acknowledging the authenticated upstream job.
-- A trial may be registered after GitHub delivered the newly created issue;
-- retaining the signed event closes that creation/registration race.
CREATE TABLE repository_job_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    delivery_key text NOT NULL,
    source text NOT NULL CHECK (source IN ('github','smithers-cloud')),
    event_type text NOT NULL,
    event_action text NOT NULL,
    issue_number bigint NOT NULL DEFAULT 0,
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, delivery_key)
);
CREATE INDEX repository_job_events_repo_received
    ON repository_job_events(repository_id, received_at, id);

-- Plan bytes are retained before Run. Retrying after either HTTP response is
-- lost uses the same Control idempotency keys and the same reviewed envelope.
CREATE TABLE repository_job_dispatches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id uuid NOT NULL REFERENCES repository_job_registrations(id) ON DELETE CASCADE,
    revision bigint NOT NULL,
    digest text NOT NULL,
    delivery_key text NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    event_action text NOT NULL,
    issue_number bigint NOT NULL DEFAULT 0,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','dispatching','waiting','submitted','failed','skipped')),
    plan jsonb,
    run_id text NOT NULL DEFAULT '',
    signal_attempt integer NOT NULL DEFAULT 0,
    receipt jsonb,
    claim_token uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (registration_id, revision, delivery_key)
);
CREATE INDEX repository_job_dispatch_pending
    ON repository_job_dispatches(next_attempt_at, created_at) WHERE status IN ('queued','dispatching','waiting');
CREATE INDEX repository_job_dispatch_issue
    ON repository_job_dispatches(registration_id, revision, source, issue_number, created_at);

-- Native events commit with the source mutation; GitHub mirrors use separate
-- github_synced_* tables. Every committed row mutation has one durable identity.
CREATE OR REPLACE FUNCTION repository_job_native_issue_payload(issue_row issues)
RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT to_jsonb(issue_row) - 'search_vector' || jsonb_build_object(
    'user', jsonb_build_object('id',u.id,'login',u.username),
    'labels', COALESCE((SELECT jsonb_agg(jsonb_build_object('name',l.name))
      FROM issue_labels il JOIN labels l ON l.id=il.label_id
      WHERE il.issue_id=issue_row.id), '[]'::jsonb))
  FROM users u WHERE u.id=issue_row.author_id
$$;

CREATE OR REPLACE FUNCTION admit_native_repository_job_issue()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  action_name TEXT;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.title,NEW.body,NEW.state) IS NOT DISTINCT FROM (OLD.title,OLD.body,OLD.state) THEN
    RETURN NEW;
  END IF;
  action_name := CASE WHEN TG_OP='INSERT' THEN 'opened'
    WHEN NEW.state<>OLD.state THEN CASE WHEN NEW.state='open' THEN 'reopened' ELSE 'closed' END
    ELSE 'edited' END;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (NEW.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issues',action_name,NEW.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(NEW),
      'repository',jsonb_build_object('id',NEW.repository_id)));
  RETURN NEW;
END $$;

CREATE TRIGGER trg_repository_job_native_issue
AFTER INSERT OR UPDATE OF title,body,state ON issues
FOR EACH ROW EXECUTE FUNCTION admit_native_repository_job_issue();

CREATE OR REPLACE FUNCTION admit_native_repository_job_comment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  issue_row issues%ROWTYPE;
  comment_row issue_comments%ROWTYPE;
  action_name TEXT;
  actor JSONB;
BEGIN
  IF TG_OP='UPDATE' AND NEW.body IS NOT DISTINCT FROM OLD.body THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN comment_row:=OLD; action_name:='deleted';
  ELSIF TG_OP='INSERT' THEN comment_row:=NEW; action_name:='created';
  ELSE comment_row:=NEW; action_name:='edited'; END IF;
  SELECT * INTO issue_row FROM issues WHERE id=comment_row.issue_id;
  IF NOT FOUND OR comment_row.type<>'comment' THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('id',id,'login',username) INTO actor FROM users WHERE id=comment_row.user_id;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (issue_row.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issue_comment',action_name,issue_row.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(issue_row),
      'comment',to_jsonb(comment_row)||jsonb_build_object('user',actor),
      'sender',actor,'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_repository_job_native_comment
AFTER INSERT OR UPDATE OF body OR DELETE ON issue_comments
FOR EACH ROW EXECUTE FUNCTION admit_native_repository_job_comment();

CREATE OR REPLACE FUNCTION admit_native_repository_job_label()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  issue_row issues%ROWTYPE;
  issue_key BIGINT;
  action_name TEXT;
BEGIN
  IF TG_OP='DELETE' THEN issue_key:=OLD.issue_id; action_name:='unlabeled';
  ELSE issue_key:=NEW.issue_id; action_name:='labeled'; END IF;
  SELECT * INTO issue_row FROM issues WHERE id=issue_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (issue_row.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issues',action_name,issue_row.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(issue_row),
      'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_repository_job_native_label
AFTER INSERT OR DELETE ON issue_labels
FOR EACH ROW EXECUTE FUNCTION admit_native_repository_job_label();

-- Idempotent setup trials retain the exact request even if its issue is deleted.
CREATE TABLE repository_job_trials (
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  job text NOT NULL CHECK (job IN ('issues','review','ci','feature','chores')),
  request_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  digest text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  issue_id bigint REFERENCES issues(id) ON DELETE SET NULL,
  issue_number bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id,job,request_id)
);

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Electric's definition stays fixed while repository access changes individual rows. Feed locks serialize the
// projection with notification writers and recorded denials. Unknown repositories start closed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE notification_repository_access (
    recipient text NOT NULL, repo_id text NOT NULL, readable boolean NOT NULL,
    checked_at timestamptz NOT NULL, PRIMARY KEY (recipient, repo_id)
  )`
  yield* sql`ALTER TABLE notifications ADD COLUMN feed_readable boolean NOT NULL DEFAULT false`
  yield* sql`UPDATE notifications SET feed_readable = true WHERE repo_id IS NULL`
  yield* sql`CREATE FUNCTION notification_readability() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.feed_readable := NEW.repo_id IS NULL OR EXISTS (
        SELECT 1 FROM notification_repository_access a
        WHERE a.recipient = NEW.recipient AND a.repo_id = NEW.repo_id AND a.readable
      );
      RETURN NEW;
    END $$`
  yield* sql`CREATE TRIGGER notification_readability BEFORE INSERT OR UPDATE OF recipient, repo_id ON notifications
    FOR EACH ROW EXECUTE FUNCTION notification_readability()`
  yield* sql`CREATE FUNCTION notification_access_project() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE notifications SET feed_readable = NEW.readable
      WHERE recipient = NEW.recipient AND repo_id = NEW.repo_id AND feed_readable IS DISTINCT FROM NEW.readable;
      RETURN NEW;
    END $$`
  yield* sql`CREATE TRIGGER notification_access_project AFTER INSERT OR UPDATE OF readable ON notification_repository_access
    FOR EACH ROW EXECUTE FUNCTION notification_access_project()`
})

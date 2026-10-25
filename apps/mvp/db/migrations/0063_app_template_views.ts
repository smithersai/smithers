import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The app's own views in the conversation (decision 0004 §3, docs/features/views.md#a-repository-and-its-issues): `repo`,
// a repository's view, whose `props` say what it opens (`{ repo, ref?, kind?, path? }`), and `issues`, a repository's
// issues view (`{ repo }`). Like a page, they keep nothing beyond their props: what they show is the repository's own,
// read by each device. The template's check gains them; the constraint is found by what it checks, whatever its name.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    DO $$
    DECLARE found record;
    BEGIN
      FOR found IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'views'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%template%'
      LOOP
        EXECUTE format('ALTER TABLE views DROP CONSTRAINT %I', found.conname);
      END LOOP;
    END $$`
  yield* sql`
    ALTER TABLE views ADD CONSTRAINT views_template_check CHECK (
      (template IN ('webpage', 'link', 'docs', 'repo', 'issues') AND state IS NULL AND code IS NULL AND html IS NULL)
      OR (template = 'form' AND state IS NOT NULL AND jsonb_typeof(state) = 'object' AND code IS NULL AND html IS NULL)
      OR (template = 'generated' AND title IS NOT NULL AND state IS NOT NULL AND code IS NOT NULL
        AND html IS NOT NULL AND interactions IS NOT NULL)
    )`
})

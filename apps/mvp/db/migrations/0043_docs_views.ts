import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A `docs` view (ruling AGENT-6, docs/features/docs.md#the-docs-view): a page of a repository's docs in the
// conversation, its Markdown kept in `props` like a page's preview. The template's check gains it; the constraint is
// found by what it checks, whatever its name.
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
  yield* sql`ALTER TABLE views ADD CONSTRAINT views_template_check CHECK (template IN ('webpage', 'link', 'docs'))`
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The person's own links. No foreign key to repositories: a saved link can precede any Smithers activity.
// Like the personal model store, the principal also accepts the dev host's non-UUID subjects.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE person_projects (
      person_id text NOT NULL CHECK (char_length(person_id) BETWEEN 1 AND 100),
      project text NOT NULL CHECK (
        project ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9._-]{1,100}$'
        AND split_part(project, '/', 2) NOT IN ('.', '..')
      ),
      PRIMARY KEY (person_id, project)
    )`
})

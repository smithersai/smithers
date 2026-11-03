import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The conversation's views (decision 0004 §8, docs/features/web-pages.md#the-views-table): rows synced to every device
// and every person in the conversation, as its messages are. This is the table's first slice: template views, the
// `webpage` and `link` templates `app/web/open` adds, with their props. Generated views add their columns (kind, code,
// html, state, revision) with their own migration.
//
// A view's position comes from the messages' own sequence, so the conversation orders views and messages by one number,
// in the order they were added. The sequence steps by 2 and an answer takes its question's position plus one
// (0003_paired_positions), so a view never shares a position with a message.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // The literal is resolved to the sequence when the default is created, so the default names it by identity.
  yield* sql`
    CREATE TABLE views (
      id uuid PRIMARY KEY,
      template text NOT NULL CHECK (template IN ('webpage', 'link')),
      props jsonb NOT NULL CHECK (jsonb_typeof(props) = 'object'),
      position bigint NOT NULL DEFAULT nextval('messages_position_seq'),
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE views REPLICA IDENTITY FULL`
})

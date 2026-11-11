// A schema declared beside the function that proves over its value type: the schema constant is a value the proof
// never reads, so it stays out of the model while its type is translated.
import { Schema } from "effect"

const Panel = Schema.Struct({
  docs: Schema.Literals(["pane", "max"]),
  rows: Schema.Array(Schema.Struct({ key: Schema.String, at: Schema.Int })),
  note: Schema.optionalKey(Schema.String),
})
type Panel = typeof Panel.Type

//@ verify
//@ ensures \result.docs == docs && \result.rows == panel.rows && \result.note == panel.note
export function writeDocs(panel: Panel, docs: "pane" | "max"): Panel {
  return { ...panel, docs }
}

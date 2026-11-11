# Agent runtime context

`AgentRuntimeContextSchema` validates the per-turn host state rendered by
`renderAgentRuntimeContext` into the agent's hidden instructions.

Free-form metadata strings must contain no CR or LF and at most 4096 UTF-16 code
units. This includes connector fields, repository identifiers and paths, GitHub
names, cloud usernames, billing strings, wiki titles and paths, tab metadata,
capabilities, and limitations. Optional and nullable fields retain those forms.

A recent card's `setup` draft is metadata throughout. Its step names and cut
prompts, `applyTo`, `trigger` and `gate` are user- and model-authored draft text
with no newline rule of their own, so the client collapses each one's whitespace
before it posts the turn; a raw draft string fails this schema at the server
boundary and the turn is rejected rather than answered.

The model host's turn and stream endpoints parse `context` with this schema and
refuse a request whose context fails it with `request_invalid`. Render only a
parsed context: the renderer replaces CRLF, CR, and LF in string metadata with a
space and truncates each value to 4096 code units, but it interpolates numbers
and reads required fields as the schema types them. A parsed context cannot
introduce another top-level instruction line.

Wiki bodies, public repository descriptions, and onboarding transcript messages
accept multiline text. The renderer splits CRLF, CR, and LF and prefixes every
body line with `|`, limiting each line's content to 4096 code units.

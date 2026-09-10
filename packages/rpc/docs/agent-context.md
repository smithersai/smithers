# Agent runtime context

`AgentRuntimeContextSchema` validates the per-turn host state rendered by
`renderAgentRuntimeContext` into the agent's hidden instructions.

Free-form metadata strings must contain no CR or LF and at most 4096 UTF-16 code
units. This includes connector fields, repository identifiers and paths, GitHub
names, cloud usernames, billing strings, wiki titles and paths, tab metadata,
capabilities, and limitations. Optional and nullable fields retain those forms.

The renderer also protects callers that have not parsed the schema: it replaces
CRLF, CR, and LF in metadata with a space and truncates each value to 4096 code
units. Metadata cannot introduce another top-level instruction line.

Wiki bodies, public repository descriptions, and onboarding transcript messages
accept multiline text. The renderer splits CRLF, CR, and LF and prefixes every
body line with `|`, limiting each line's content to 4096 code units.

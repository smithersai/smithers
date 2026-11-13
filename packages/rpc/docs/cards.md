# Cards persistence contract

`CardSchema` is the single persisted-card decoder. `LEGACY_CARD_KINDS` is the
shared removed-kind set used by the decoder and renderer registration coverage.
It excludes `retired`, the current tombstone schema. Unknown kinds outside the
set fail decoding; malformed live rows fail their current schema.
`CardSchemaOptions` names the current union options for embedding schemas.

A legacy row keeps its stored title, body, identity, ordering and timestamp.
Decoding wraps its original payload as
`payload: { was: <original kind>, recorded: <original payload> }`, stops loading
and sets status to `acted`. Recorded graph, history and other content stays
opaque and inert; it never restores controls. Existing tombstones preserve their
body and optional `payload.was` and `payload.recorded`; decoding twice is stable.
Old tombstones without these fields remain readable. Titles are inert text,
never saved actions. Recorded model payloads omit the old `apiKey` field and
recorded environment variable rows omit `value`; historical data never restores
those stored credentials. The same stripping applies when reloading a retired row.

Retired flow forms and Linear issue rows use the same retirement path. Cloud
`agents` inventories decode through their declared repository and sessions schema;
malformed sessions fail validation. Non-cloud `agents` stays live (L4), and null
or primitive agent entries fail validation instead of silently disappearing.
Decoding a live `agents`
row refreshes a profile's label, purpose, harness and model from the built-in
role table only when the stored row itself says `builtin: true`; a repository
agent flow whose id matches a built-in role keeps its own facts. Its
`inventory` field names which source the rows are — `host`, `repository`,
`reading`, `unreadable` or `no-repository` — so an empty list is never decoded
as a verdict the read did not reach: a refused catalog read is `unreadable`,
not a repository that declares no agent. Only a card written before the field
existed carries none. A kind joins the legacy set
only when its last producer is removed (L3). `grant-confirm` and `branches`
are legacy; `stack` and `factory.home` retain live schemas.
`file`, `diff`, `secrets`, `run-trace`, `balance` and `billing-plans`
also remain current.

`CardPatchSchema` requires `kind`, including for metadata-only updates. Its payload
is a shallow partial of that kind's payload schema: every top-level field is
optional and has no default, so a field the patch omits stays absent and the
merge keeps the stored value. Nested objects and arrays keep their full
validation, including file diagnostic caps. Consumers must require the patch kind
to match the existing card, merge payload fields, then validate the resulting card
with `CardSchema` before storing the parsed result. The UI store fills in the
existing kind for local transitions; model frames must provide it.
Legacy kinds, including `env`, are not accepted by `CardPatchSchema`.
Recorded environment rows discard `value` rather than keeping a masked preview.

## Link fields

Card URLs a renderer links, embeds or opens decode through `@smthrs/rpc/WebUrl`.
`htmlUrl`, `installUrl`, `avatarUrl`, persona `iconUrl`, a workspace service
`url`, and a browser card's `finalUrl` must be absolute `http://` or `https://`
URLs. A desktop `streamUrl` must be an origin-relative path (`/…`, never `//`).
A browser card may record a refused `url` of any scheme, but a `frameable` card
must embed an http(s) page. A row that breaks these rules fails validation.

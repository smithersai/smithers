# Credential enrollment design

This decision precedes implementation (2026-09-19). The feature brief supersedes
R2's two-route limit and R4's environment-only enrollment. All other rulings stand.
The updated CONTRACT.md lives here because the supplied original is outside the
authorized edit workspace.

## Form boundary

`write-only` is a general form kind. Its optional string schema property names the
control, but no value is accepted in a command payload or persisted draft/given.
The required hint requires human input at submission. An uncontrolled password
input holds the edit; it never calls form.set. On submit it clears synchronously
and hands an opaque, one-shot accessor through CommandGesture to form.submit and
the underlying flow. Serialization sees only public fields. Unused input is
released on refusal/cancel; it is never restored on reload. Native required-field
validation handles the transient field. Agent forms collect public fields first;
the existing confirm path approves those fields before the human's secret form.
The registry strips write-only fields before tracing or lifecycle admission.

## Flows and UI

Keep `model.credential.*` beside entries/model.ts: these credentials belong to the
model host, not repository secrets. `new` opens enrollment, `enroll` takes name,
origin and write-only value; `rotate` takes name and write-only value; `remove`
takes name. All three mutations confirm for agent calls. Slash grammars never
accept a value. The credential picker offers Add credential; the maximized
Models pane lists names, pins, Rotate and Remove. Unavailable enrollment is a
disabled option with its reason. No new explanatory product prose.

## Host boundary

POST `/api/model/credential`: a strict action union with requestId and name;
enroll alone accepts origin; enroll/rotate accept value. GET
`/api/model/credential/receipt?id=...` returns a safe completion receipt or unknown.
Both routes are session/Origin gated locally; the Worker requires its turn
session and returns typed local_host_required without storing the body.

The macOS keychain interface already identifies items by service and account.
A separate state-directory-scoped vault atomically replaces one versioned
document containing multiple credentials, immutable pins and bounded receipts.
Serialize mutations across processes with an empty SQLite lock file in the state
directory, reread the vault under the lock, and check subprocess status; never fall back to memory-only
success or plaintext disk. The secret travels to security over stdin, not argv.
Other platforms advertise keychain_unavailable. Existing environment credentials
remain operator-owned and cannot be overwritten or removed. Missing built-in
credentials may be enrolled only on their predefined pin. Removal deletes the
value but retains the pin: reusing a name can never grant a new origin. Planning
and secret lookup use the same host snapshot; provider output retains the current
credential scrub and redirects remain forbidden.

The Worker gateway registry is keyed by GitHub login and owns provisioned gateway
sessions. Its model consumers still read deployment credentials. Extending only
that store would not establish provider-key ownership, rotation/removal and
consumer isolation across identity changes. This run therefore ships explicit
local-only enrollment, with no silent cloud acceptance or unused stored keys.

## Background work and recovery

Persist only requestId/action/name/origin and requested state, then acknowledge
Requested. The shared 300 ms toast spans host storage and catalog reconciliation.
Deduplicate pending mutations; only the current account/controller may settle
state. Host receipts contain no value. Reload reads a receipt; an unknown request
fails as interrupted and asks for re-entry, never silently resubmits a lost key.
Typed result failures carry closed codes/fields/faults and no exception text.

## Proof plan (tests first)

Form tests cover draft/given/command exclusion, immediate DOM clearing, agent
confirmation, and rejection of form.set. Host tests cover actual loopback calls,
duplicate enrollment, immutable pins, rotation/removal, restart, storage refusal,
and subprocess argv safety. Controller tests hold launch unresolved, check instant
ack, toast lifetime, duplicates, failures, stale identity and receipt recovery.
Real UI tests enroll a generated provider key with tracing off, create/test a
model, reload, rotate and remove; inspect all persisted state and request logs,
and verify provider journals contain only credential digests.

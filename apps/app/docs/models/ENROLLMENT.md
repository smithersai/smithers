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

## Account vault on the Worker (2026-09-20, design before implementation)

This supersedes the local-only Worker decision above. Keep the existing routes,
write-only form, agent confirmation, instant acknowledgment, shared toast and
receipt recovery. The public catalog contains deployment rows alone for visitors;
a validated session adds only its login's names, immutable pins and presence.
Missing encryption configuration reports `vault_unavailable`; signed out reports
`sign_in_required`. Neither may enable credential entry.

`MODEL_VAULT_KEY` is an OPTIONAL Worker secret: base64 of 32 random bytes for
AES-256-GCM. Missing or malformed configuration disables the vault alone. It is
not a deployment preflight requirement. Deployment credentials keep their current
behavior, pins and ownership. Do not replace this encryption key to rotate a
provider key: use Rotate. Replacing it without a migration makes existing values
unreadable, which fails closed.

Add `AccountModelVault` / `MODEL_VAULTS`, migration `v5`, keyed exclusively by the
validated GitHub login, canonicalized to lowercase. The Worker encrypts values
before the object receives them; the object never receives a plaintext value or
the encryption key and has no decrypt/debug door. Each write uses a fresh 96-bit
nonce. Versioned AAD is the unambiguous tuple `[version, login, name, origin]`.
Only ciphertext, nonce, pins and bounded safe receipts are durable. A per-object
mutex serializes read/modify/write; one atomic document commits pin/value/receipt
together. Removal deletes ciphertext and retains the pin. Repeated request IDs
return the original receipt; reuse with different public operation fields fails.

Accept canonical HTTPS origins with public DNS names and default port 443 only:
no IP literals (including URL-normalized variants), userinfo, paths, query,
fragments, single-label names, localhost/local/internal/private/link-local names
or reserved local suffixes. Contract built-in names keep their contract origins;
the deployment's CEREBRAS_API_KEY and AI_GATEWAY_API_KEY are always read-only.
Redirects are manual and a redirect is a typed refusal. This is an origin pin,
not a DNS address pin; the Worker uses Cloudflare's public HTTPS fetch transport.
The runtime filters private addresses when resolving a DNS host; this relies on
the default public outbound network, never a VPC/internal service binding (see
[workerd's network contract](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)).

Test and Ask keep `requireTurnSession` and `loginBudget`. Resolve the plan against
deployment metadata plus the current account's vault, decrypt only its selected
record, then call exactly that plan. Explainer uses the same resolver. Front door
and Recommend keep their deployment-only decision allowlist. A missing, corrupt
or undecryptable account record names that credential and never tries a deployment
key. Revalidate the captured session after asynchronous preparation and before
mutation or spending; discard results after identity changes. The browser's
account epoch independently prevents stale catalog, receipt and call completion.

Read/parse/storage/crypto failures are closed typed outcomes; never serialize a
schema error, exception, request body or decrypted value. Provider outputs are
scrubbed before responses, samples or turn frames are constructed. Internal DO
responses carry ciphertext or metadata only; public receipts contain metadata
only. Catalog and credential responses are `no-store`.

Tests first: two-login route tests over recorded transport and the real DO on
memory storage; enrollment/catalog/Test/Ask/Explainer, repin, duplicate, rotation,
removal/restart, session changes, missing key, storage/crypto failure, AAD tamper,
redirect and output scrubbing. App tests prove cloud capability enables the
existing form, values never persist and completed receipts reconcile on reload.
The local real tier remains the local-vault proof; MANUAL.md gains the production
steps for Will after the optional secret is installed.

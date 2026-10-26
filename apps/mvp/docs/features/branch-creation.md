# Repository branch creation

`/new` and `branch/create` run the same selected public flow. Without a repository
installation, the first-party `branches/create` plugin calls `branches/ephemeral`:
an ephemeral ref on the existing Code Storage mirror, with no GitHub write.

Install a replacement on the repository's default branch with these three files.
The selector reads them at one commit. Invalid configuration or a missing file
refuses creation rather than silently selecting the default.

`.smithers/branch.json` (it may also name the plugin's Publish and Update branch flows, `publish` and `update`; see [branch publish](branch-publish.md#overriding-the-flows)):

```json
{ "plugin": "team-branches", "flow": "create" }
```

`.smithers/plugins/team-branches/plugin.json`:

```json
{
  "apiVersion": 1,
  "id": "team-branches",
  "version": "1.0.0",
  "title": "Team branches",
  "description": "Create team conversation branches.",
  "requires": { "api": "^1.0.0" },
  "capabilities": ["git:write"],
  "uses": ["branches/ephemeral"],
  "owns": ["create"]
}
```

`.smithers/flows/team-branches/create/flow.ts`:

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Create = Action.make("branches/ephemeral", {
  payload: { ref: Schema.String },
  success: Schema.Unknown,
})

export default Flow.make("team-branches/create", {
  description: "Create a team conversation branch.",
  capabilities: ["git:write"],
  payload: { ref: Schema.String },
  success: Schema.Unknown,
  body: Node.capture({ create: Create.name }, ({ ref }) =>
    Create.call({ ref: `team/${ref}` })),
})
```

The host fixes the repository, authenticated person, request identity and access
policy. The plugin chooses the ref name. It must return the tracked conversation
result from exactly one successful host action. It cannot invent a conversation,
request another repository, access credentials or write several branches.

To create on GitHub explicitly, replace `branches/ephemeral` with `branches/github`
in the action and manifest, and replace `git:write` with `github:write` in the flow
and manifest. The repository must permit the authenticated person to create a
branch and have a configured GitHub App installation. GitHub creation runs on the
server through the durable once adapter; its returned name includes the stable
request-derived ownership suffix. Return the action's result unchanged so the
app opens the actual branch. The default plugin never selects this action.

The public loader validates manifest ownership and capability declarations.
`RealmFlow` from `@smthrs/harness` executes the actual flow interpreter inside
QuickJS with no host network or filesystem. Source, revision, digest, runtime
version and allowed actions are journaled before execution; each host action's
receipt is durable. Recovery replays the original selection, even if the
repository has since changed. An incompatible runtime refuses recovery instead
of interpreting old receipts with different code.

The creation child retries unavailable selection and provider calls for 24 hours,
starting at one second and doubling to 30 seconds. `/new` and New branch share
that recovery window and reuse the same child and provider request identities.
A domain refusal ends the request immediately.

`GET /api/branches/creation?owner=<owner>&name=<repo>` resolves the installation;
omitting both names selects the deployment repository. It requires a signed-in
Member. The response is private and uncached. Logs and counters record selection
status and execution outcomes; they contain neither source nor branch names.

See [decision 0095](../decisions/0095-new-conversation-ephemeral-refs.md) for
namespace storage, sandbox fetch isolation and the provider API references.

The built-in registry packages `plugins/branches/src/create.ts` as a JSON source
asset so the Worker imports no browser UI or Vite-only loaders. The source
packaging test requires byte-for-byte equality. After editing the authored flow,
regenerate its asset from `apps/mvp` with
`pnpm exec vitest run plugins/branches/src/source.test.ts --update --coverage.enabled=false`.
The Worker startup gate bundles the real Alchemy entry and retains its CPU budget.

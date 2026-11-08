# `@smthrs/effect-code-storage`

[Code Storage](https://code.storage), Pierre's git hosting, for Effect
programs. Import a public GitHub repository with no GitHub App, start its
sync, list its files, read a file, and list its commits, branches and tags. Every request carries
its own short ES256 token, signed with WebCrypto by your organization's key,
for one repository and one scope. Failures are typed, bodies are bounded, and
nothing the server says in free text reaches your errors or telemetry.
`GitRemote.head` reads any git remote's default branch and commit over smart
HTTP with no credential, which is what you need to know before you import.

It uses Effect's `HttpClient` and imports no Node built-in, so it runs in a
browser, a Worker, Node and Bun.

**Documentation:** [`docs/`](docs/README.md)

## Install

The package is private in this repository. Add it as a workspace dependency,
with `effect` at this exact version.

```json
{
  "dependencies": {
    "@smthrs/effect-code-storage": "workspace:*",
    "effect": "4.1.1"
  }
}
```

Code Storage needs an organization and a signing key: sign up, create the
organization, and create a key on its Keys page. There is no anonymous access.

## Quickstart

```ts
import { CodeStorage, GitRemote } from "@smthrs/effect-code-storage"
import * as Effect from "effect/Effect"
import { FetchHttpClient } from "effect/http"
import * as Layer from "effect/Layer"

const program = Effect.gen(function*() {
  const head = yield* GitRemote.head("https://github.com/octocat/Spoon-Knife.git")
  const storage = yield* CodeStorage.CodeStorage
  yield* storage.createRepo({
    name: "github/octocat/spoon-knife",
    defaultBranch: head.branch,
    github: { owner: "octocat", name: "Spoon-Knife" }
  })
  yield* storage.pullUpstream("github/octocat/spoon-knife")
  // Until the first sync finishes, calls fail with `sync_in_progress`: retry them.
})

const layer = Layer.provideMerge(CodeStorage.CodeStorage.layerConfig, FetchHttpClient.layer)
// CODE_STORAGE_ORG and CODE_STORAGE_KEY come from the environment.
Effect.runPromise(program.pipe(Effect.provide(layer)))
```

## Learn more

- [Overview](docs/README.md): what the package guarantees, and Code Storage's
  facts it relies on.
- [API reference](docs/api.md): every export.

Read limits are non-negative safe integers (zero permits only empty files).
Invalid `readFile.maxBytes` fails with `invalid_argument` before any HTTP request,
with the usual request span and outcome counter. Unknown codes appear in error
messages only as lowercase identifiers of at most 64 characters. Transient HTTP
statuses are 500, 502, 503 and 504; documented transient codes still apply.

Library catalog entry: import a public GitHub repository into git hosting and
read its files and commits (`@smthrs/effect-code-storage`).

`yield* storage.deleteRepo(name)` retires a repository with only `repo:write`
on that name. Success means deletion accepted; physical cleanup is asynchronous.
Missing and already-deleted repositories remain typed `CodeStorageError`s.
See [retiring a repository](docs/README.md#retiring-a-repository) for the contract.

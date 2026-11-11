# @smthrs/rpc

`LocalApp` defines harness, repository, file, and target records. `LocalLsp` defines code intelligence. `CloudTunnel` defines the cloud proxy, terminal tunnel, and sign-in contracts.

Shared product contracts for the local host, browser, and server. Import them from the root, where each module is a namespace: `import { LocalApp, TargetGraph } from "@smthrs/rpc"`. The root reaches no `node:` or `bun:` built-in. One module stays off it: `FormInstructions.generated.ts`, whose `FORM_INSTRUCTION_FIELDS` is part of `UiInstruction`. The `@smthrs/rpc/<Module>` subpaths still resolve because existing TUI, package and site files import them; new code uses the root.

`FileRead` card IDs retain their readable repository-path@revision form, escaping `%` and repository `-` / path `@` delimiters so names cannot collide. `decodeFilePage` rejects malformed base64 with `FilePageRejected` (`invalid_encoding`); valid binary content stays opaque. `LocalLsp` validates definition paths with the request's repository-relative path rule, and diagnostic responses require `items` and `total` to be null together. `Refusal` accepts only positive finite explicit retry seconds, rounded up, and attributes a missing response to the client unless an origin is stated. Direct `RepositorySubjectPath.resolveRefLocation` calls validate the location grammar before decoding.

`BrowserFetch` is the one implementation module: the browser tool's guarded fetch-and-extract handler, shared by the product Worker and the local host. It is the only module that performs network I/O, with the DNS resolver injected by each host.

The model host owns enrollment (`POST /api/model/credential`) and safe receipts
(`GET /api/model/credential/receipt`). Bun uses its state-scoped OS keychain;
the Worker returns `local_host_required` after its session gate.

## Route ownership

Each route family has one home module, and a route constant is declared only there. A route belongs to the longest family it falls under. Add a route to the module its family names; a new family gets a row here first. `test/RouteOwnership.test.ts` holds every `/api/` constant to this table.

| Family                                                                                                                                                                                                          | Module               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `/api/auth/github`, `/api/auth/github/callback`                                                                                                                                                                 | `AgentApiRoutes.ts`  |
| `/api/auth/local`, `/api/auth/sse-ticket`, `/api/user`                                                                                                                                                          | `ApplicationAuth.ts` |
| `/api/repo/files`                                                                                                                                                                                               | `LocalApp.ts`        |
| `/api/cloud`, `/api/cloud-ws`, `/api/cloud-auth`                                                                                                                                                                | `CloudTunnel.ts`     |
| `/api/bootstrap`                                                                                                                                                                                                | `AppBootstrap.ts`    |
| `/api/repos/{owner}/{repo}/mythical`                                                                                                                                                                            | `Mythical.ts`        |
| `/api/todos`                                                                                                                                                                                                    | `TodoCommands.ts`    |
| `/api/model/credential`, `/api/model/credential/receipt`                                                                                                                                                        | `AgentApiRoutes.ts`  |
| `/api/commands`, `/api/agent`, `/api/auth`, `/api/identity`, `/api/billing`, `/api/tools`, `/api/workflow`, `/api/model`, `/api/public`, `/api/admin`, `/api/recommend`, `/api/jev`, `/api/chat`, `/api/health` | `AgentApiRoutes.ts`  |

These are public product contracts even while the package is private. Preserve wire fields and route strings when changing implementation details. All exported declarations carry descriptions, `@since`, and `@category`.

`UpstreamProse` withholds arbitrary upstream sentences and uses status fallbacks; only the pinned scope-gate sentence is recognized. `UserFailure` keeps registered copy, tags and actions, while `failureDetail` returns `[REDACTED]` for every thrown value. A collapsed details control does not make exception text safe to disclose.

`ConfiguredModel.modelStateFieldsOf` keeps a recorded object with any invalid field name whole in one JSON `state` field, preserving all its keys. Choice answers validate every supplied probability, including entries for undeclared options. `DocsPages.readDocsPage` accepts `page#anchor` and returns the complete page.

Run `pnpm run check`, `pnpm run lint`, and `pnpm run test` here. Sources use the standard NodeNext configuration with unchecked indexed access enabled; an array or dictionary lookup must handle absence. Tests live in `test/` and run under Vitest, matching the other packages. `IndexAccess.types.ts` pins the compiler contract.

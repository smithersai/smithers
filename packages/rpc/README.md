# @smthrs/rpc

Shared product contracts for the local host, browser, and server. Import individual modules such as `@smthrs/rpc/LocalApp`, `@smthrs/rpc/AppLinks`, and `@smthrs/rpc/TargetGraph`.

`LocalApp` defines the local harness, repository, file, terminal, and target execution records. `LocalLsp` defines local code intelligence: the language-server routes, caps, requests, and answers. `CloudTunnel` defines the Smithers Cloud seam on the local origin: the proxy and WebSocket tunnel routes, frame caps, close codes, and browser sign-in. `LinearAuth` defines the Linear OAuth handoff. Parse incoming data with their Zod schemas; the inferred types describe validated values. `TargetGraph` defines graph nodes, edges, run summaries, and traversal helpers. `AppLinks` defines the native download and handoff links without inventing a release URL when none is configured.

`LocalApp` re-exports the names that moved to `LocalLsp`, `CloudTunnel`, and `LinearAuth` for one release. Import them from their home; a new name is exported from its home alone.

## Route ownership

Each route family has one home module, and a route constant is declared only there. A route belongs to the longest family it falls under. Add a route to the module its family names; a new family gets a row here first. `test/RouteOwnership.test.ts` holds every `/api/` constant to this table.

| Family                                                                                                                                                                             | Module              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `/api/harnesses`, `/api/repos`, `/api/repo`, `/api/pty`, `/api/targets/query`, `/api/targets/run`                                                                                  | `LocalApp.ts`       |
| `/api/lsp`                                                                                                                                                                         | `LocalLsp.ts`       |
| `/api/cloud`, `/api/cloud-ws`, `/api/cloud-auth`                                                                                                                                   | `CloudTunnel.ts`    |
| `/api/linear-auth`                                                                                                                                                                 | `LinearAuth.ts`     |
| `/api/targets`                                                                                                                                                                     | `TargetGraph.ts`    |
| `/api/bootstrap`                                                                                                                                                                   | `AppBootstrap.ts`   |
| `/api/agent`, `/api/auth`, `/api/identity`, `/api/billing`, `/api/tools`, `/api/workflow`, `/api/model`, `/api/public`, `/api/admin`, `/api/recommend`, `/api/chat`, `/api/health` | `AgentApiRoutes.ts` |

These are public product contracts even while the package is private. Preserve wire fields and route strings when changing implementation details. All exported declarations carry descriptions, `@since`, and `@category`.

Run `pnpm run check`, `pnpm run lint`, and `pnpm run test` here. Sources use the standard NodeNext configuration with unchecked indexed access enabled; an array or dictionary lookup must handle absence. Tests live in `test/` and run under Vitest, matching the other packages. `IndexAccess.types.ts` pins the compiler contract.

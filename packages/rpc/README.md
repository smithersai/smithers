# @smthrs/rpc

`LocalApp` defines harness, repository, file, and target records. `HarnessSchema` bounds each account email and label to `ACCOUNT_MAX_LENGTH` (256) characters. `LocalLsp` defines code intelligence.

Shared product contracts for the local host, browser, and server. Import them from the root, where each module is a namespace: `import { LocalApp, TargetGraph } from "@smthrs/rpc"`. The root reaches no `node:` or `bun:` built-in. One module stays off it: `FormInstructions.generated.ts`, whose `FORM_INSTRUCTION_FIELDS` is part of `UiInstruction`. The `@smthrs/rpc/<Module>` subpaths still resolve because existing TUI, package and site files import them; new code uses the root.

`FileRead` card IDs retain their readable repository-path@revision form, escaping `%` and repository `-` / path `@` delimiters so names cannot collide. `decodeFilePage` rejects malformed base64 with `FilePageRejected` (`invalid_encoding`); valid binary content stays opaque. `LocalLsp` validates definition paths with the request's repository-relative path rule, and diagnostic responses require `items` and `total` to be null together. `Refusal` accepts only positive finite explicit retry seconds, rounded up, and attributes a missing response to the client unless an origin is stated.

## Route ownership

Each route family has one home module, and a route constant is declared only there. Add a route to the module its family names; a new family gets a row here first. `test/RouteOwnership.test.ts` holds every `/api/` constant to this table.

| Family                               | Module        |
| ------------------------------------ | ------------- |
| `/api/repo/files`                    | `LocalApp.ts` |
| `/api/repos/{owner}/{repo}/mythical` | `Mythical.ts` |

`TodoCommands.TodoNewInputSchema` declares TODO creation: place `before` a TODO or append.
`CardAction.BranchAddToStackInputSchema` declares scratch adoption with trimmed, nonempty text and either `after` or `before`, using `TodoCommands.TodoPlacementSchema`.
Historical billing cards retain their plan and entitlement decoders inside `Cards`.

These are public product contracts even while the package is private. Preserve wire fields and route strings when changing implementation details. All exported declarations carry descriptions, `@since`, and `@category`.

`UserFailure` keeps registered copy, tags and actions, while `failureDetail` returns `[REDACTED]` for every thrown value. A collapsed details control does not make exception text safe to disclose.

`ConfiguredModel.modelStateFieldsOf` keeps a recorded object with any invalid field name whole in one JSON `state` field, preserving all its keys. Choice answers validate every supplied probability, including entries for undeclared options. `DocsPages.readDocsPage` accepts `page#anchor` and returns the complete page.

Run `pnpm run check`, `pnpm run lint`, and `pnpm run test` here. Sources use the standard NodeNext configuration with unchecked indexed access enabled; an array or dictionary lookup must handle absence. Tests live in `test/` and run under Vitest, matching the other packages. `IndexAccess.types.ts` pins the compiler contract.

# Smithers runtime packages

`packages/smithers` is `@smthrs/cli`. Inside a workspace it provides the `smthrs` executable and its `smithers` alias from `bin/smithers.mjs`, and it is also importable: the root entry point re-exports every module as a namespace.

## Command-line host

The shebang in `bin/smithers.mjs` pins Node, because the durable engine is not supported on Bun. Commands that touch durable state resolve a project root and write `.flows/` under it. The package depends on the whole Smithers stack, so a host that embeds the command tree adds no further packages.

## Durable runtime

`NodeRuntime` and `BunRuntime` bind the same `makeNative` runtime factory to their matching database, host and cryptography layers. The shared `@smthrs/flows/Runtime.storage` composition builds journal and durable store layers over injected services; it does not select a SQL driver.

## Agent composition

`AgentSession` runs the agent as a whole control-plane launch. `AgentAction` runs the same loop as one typed step inside a larger flow. A cell's only authority is `ctx.call(flowName, input)`.

## Build declarations

To load `WORKSPACE.ts` and `PACKAGE.ts`, a workspace installs `@smthrs/cli` and `@smthrs/targets` and selects its local binary. The loader and declarations must resolve the same physical Effect and Smithers packages; a separately installed global CLI can report `declaration_dependency_mismatch` even when versions match.

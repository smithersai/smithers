# Smithers runtime packages

The `packages/smithers` package is named `@smthrs/cli`. It exposes the `smthrs` and `smithers` executables and exports its application composition API.

## Application and durable runtime

`Application.Config` separates the source root from the optional state root, so a host can keep its durable databases outside the source checkout. `Runtime.storage` composes the journal, run store, attempt store, cache store, engine state, workspace identity, and filesystem artifact store over its database services.

## Agent composition

`AgentSession` runs the agent as a durable control-plane run. `AgentAction` composes the same agent as a typed step inside a larger flow. The agent's cell loop reaches capabilities through registered flows.

## Build declarations

Smithers build uses `PACKAGE.ts` target declarations and a `WORKSPACE.ts` toolchain declaration. Imports between declaration files form dependency edges. The build CLI computes content keys and executes dependencies before their dependents.

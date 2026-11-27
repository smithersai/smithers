# @smthrs/app-core API Reference

`@smthrs/app-core` exposes one principal-bound core catalog of flows and queries and generates four clients from it: MCP, CLI, SDK, and headless GUI.

## Core

- `Core.Core`: Effect service tag for the core catalog (`catalog`, `submit`, `read`, `changes`).
- `Core.layer`: Constructs a principal-bound `Core` layer with frozen registrations and detached outputs.
- `Core.CoreError`: Typed core refusal (`person_only`, `unauthorized`, `not_found`, `invalid_payload`, `ambiguous_tool`).

## Principal

- `Principal.Credentials`: Mints opaque `Principal` values strictly from adapter `DoorEvidence`.
- `Principal.Act`: Delegate actor kind (`"agent" | "app" | "flow"`). Only person-door evidence mints the person.

## CauseReceipt

- `CauseReceipt.Ref`: Output reference schema.
- `CauseReceipt.Receipt`: Immutable provenance receipt (`runId`, `nodeId`, `attempt`, `journalSeq`, `planRef`, `promptHash`).

## Client Adapters

- `McpAdapter`: JSON-RPC 2.0 MCP server (`initialize`, `tools/list`, `tools/call`) with `protocolVersion`.
- `CliAdapter`: Command descriptors, typed flags, argv executor, and agent skill emitter.
- `SdkAdapter`: Effect service and Promise/`AsyncIterable` facade (`catalog`, `call`).
- `GuiAdapter`: Headless `{ queries, actions, hostStrip }` contract matching `@smthrs/plugin`.

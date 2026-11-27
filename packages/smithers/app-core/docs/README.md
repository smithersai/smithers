# @smthrs/app-core

`@smthrs/app-core` defines the principal-bound core contract (`Core`) and generates four client adapters (`McpAdapter`, `CliAdapter`, `SdkAdapter`, `GuiAdapter`) from one registered catalog of flows and queries.

## Modules

- `Core`: register flows and queries and expose `catalog`, `submit`, `read`, and `changes`.
- `Principal`: mint opaque principals from `DoorEvidence` and enforce person-only and capability boundaries.
- `CauseReceipt`: record and inspect provenance for committed outputs.
- `McpAdapter`: JSON-RPC 2.0 MCP server (`initialize`, `tools/list`, `tools/call`).
- `CliAdapter`: command descriptors, flags, argv execution, and skill generation.
- `SdkAdapter`: Effect service and Promise/`AsyncIterable` facade.
- `GuiAdapter`: headless frame queries/actions and host-drawn action strip.

# @smthrs/app-core

One principal-bound Smithers core and the four clients generated from its catalog: MCP, CLI, SDK, and headless GUI.

## Install

```bash
npm install @smthrs/app-core@next effect
```

## Overview

- **`Core`**: catalog of flows and queries with four operations (`catalog`, `submit`, `read`, `changes`).
- **`Principal`**: opaque principal minting from `DoorEvidence`; delegates (`agent`, `app`, `flow`) are refused on person-only flows.
- **`CauseReceipt`**: immutable provenance receipts stamped on every committed output.
- **`McpAdapter` / `CliAdapter` / `SdkAdapter` / `GuiAdapter`**: generated client adapters sharing the same catalog and refusal semantics.

See [docs/README.md](./docs/README.md) for the package guide.

# @burns/cli

CLI distribution package for the legacy Burns daemon launcher.

## Prerequisites

- Bun `1.2.x`
- Repository checkout containing the Burns daemon lifecycle module

## Commands

Run from repository root:

```bash
bun run apps/cli/src/bin.ts --help
```

or from the package directory:

```bash
cd apps/cli
bun run src/bin.ts --help
```

### `burns start`

Starts the daemon.

```bash
burns start
```

`burns start` is retained as a legacy alias for `burns daemon`.

### `burns daemon`

Starts daemon only.

```bash
burns daemon
```

## Notes

- The CLI reuses daemon startup by importing `apps/daemon/src/bootstrap/daemon-lifecycle.ts`.
- The Burns UI and deep-link commands were intentionally removed from this repo.
- Default daemon API URL is `http://localhost:7332`.

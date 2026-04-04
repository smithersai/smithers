# @burns/cli

CLI distribution package for running Burns without the web dev server workflow.

## Prerequisites

- Bun `1.2.x`
- Repository checkout containing `apps/daemon` and `apps/web`

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

Starts daemon and (when available) serves prebuilt web assets from `dist/web`.

```bash
burns start
```

Options:

- `--open`: open a web URL in your browser after daemon startup
- `--web-url <url>`: URL opened by `--open` (default: `http://127.0.0.1:4173`)

### `burns daemon`

Starts daemon only.

```bash
burns daemon
```

### `burns web`

Serves static web assets from `dist/web`.

```bash
burns web
```

Options:

- `--host <host>`: bind host (default: `127.0.0.1`)
- `--port <port>`: bind port (default: `4173`)
- `--open`: open served URL in your browser

If `dist/web` is missing, the CLI prints guidance to run:

```bash
bun run build:web
```

## Notes

- The CLI reuses daemon startup by importing `apps/daemon/src/bootstrap/daemon-lifecycle.ts`.
- Default daemon API URL is `http://localhost:7332`.

## Packaging helper

Build a CLI artifact tarball for release collection:

```bash
bun run build:artifact
```

This writes an archive into `dist/cli` via `scripts/release/build-cli-artifact.sh`.

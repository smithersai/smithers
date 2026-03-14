# `@burns/desktop`

ElectroBun desktop shell package for Burns.

## What this package does

- Starts a desktop shell from Bun entrypoint: `src/main.ts`
- Starts the daemon runtime in-process before window creation
- Blocks startup when another Burns daemon is already listening on the configured desktop URL, unless attach mode is explicitly enabled for development
- Loads packaged web UI (`views://mainview/index.html`)
- Injects runtime config into web at startup via `window.__BURNS_RUNTIME_CONFIG__`
- Uses ElectroBun lifecycle scripts for web build + post-build verification

## Commands

Run from `apps/desktop`:

```bash
bun run dev
bun run build
bun run build:canary
bun run typecheck
bun run test
```

## Runtime Config Contract

Desktop injects this object into the loaded web page:

```ts
window.__BURNS_RUNTIME_CONFIG__ = {
  burnsApiUrl: string
  runtimeMode: "desktop"
}
```

Resolution order in desktop package:

1. Daemon runtime URL from `startDaemon()`
2. Optional debug override `process.env.BURNS_DESKTOP_FORCE_API_URL`
3. Fallback `http://localhost:7332`

## Dev Source Mode

Desktop dev mode supports two UI sources:

- `views` (default): load bundled `views://mainview/index.html`
- `vite`: load `BURNS_DESKTOP_DEV_VITE_URL` when reachable, otherwise fallback to bundled views

Environment controls:

- `BURNS_DESKTOP_DEV_SOURCE=views|vite`
- `BURNS_DESKTOP_DEV_VITE_URL=http://localhost:5173`
- `BURNS_DESKTOP_FORCE_API_URL=http://localhost:7332`
- `BURNS_DESKTOP_ALLOW_ATTACH_EXISTING=1` to allow attaching to an already-running Burns daemon instead of blocking startup

## Notes

- `bun run dev` sets `BURNS_DESKTOP_ALLOW_ATTACH_EXISTING=1` so desktop development can reuse a CLI-run daemon.
- Uses official `electrobun/bun` APIs directly (`BrowserWindow`, app events, native dialogs).

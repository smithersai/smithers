# Smithers UI

The React renderer and Electrobun desktop host for Smithers. The native window
loads the app from its authenticated loopback server, not `views://` or a Vite
development origin. The browser build is also served by `apps/server`.

## Development

From the monorepo root, with the repository's Bun/pnpm toolchain installed:

```sh
pnpm install
pnpm --filter smithers-app start
```

`start` prepares the Electrobun devkit, builds the SPA, then launches the desktop
app. `pnpm --filter smithers-app dev` runs the native watch loop. For build-only
work, use `build:web` for the SPA or `build:native` for the native package.
The old template's `dev:hmr` and `build:prod` scripts do not exist.

## Verification

```sh
pnpm --filter smithers-app typecheck
pnpm --filter smithers-app test
pnpm --filter smithers-app test:e2e
```

The unit/source suite does not automatically adopt personal host checkouts.
Host-workspace integration cases require explicit opt-in and retain their run
histories; see [build and verification](docs/LOCAL-APP.md#build-and-verification).
The default Playwright host uses a temporary home/state directory, a chat stub,
and no real harness discovery or credential-bearing shell environment. The
real-harness browser cases require `SMITHERS_E2E_HOST_HARNESSES=1`; this permits
reading local account state and launching installed harnesses. Real chat is a
separate opt-in, `SMITHERS_CHAT_STUB=0`.
Packaged native testing is a separate lane (`test:e2e:packaged`) with its own
platform/network requirements.

## Code ownership

- `src/mainview/`: chat, embedded surfaces, Flow registry, controller and store.
- `src/mainview/chain/`: browser persistence, replay journal and recovery.
- `src/bun/`: native host, authenticated local server, repositories, PTYs and LSP.
- `packages/rpc/src/`: shared `@smthrs/rpc` wire contracts.
- `packages/smithers/`: the new Flow, Harness, Journal and related runtime packages.
- `apps/server/`: Cloudflare Worker and web host.

Read [AGENTS.md](AGENTS.md) before changing interactions. The
[local-app architecture](docs/LOCAL-APP.md) describes transports and native
boundaries; [persistence](docs/persistence.md) describes storage, migration,
archiving and private recovery files.

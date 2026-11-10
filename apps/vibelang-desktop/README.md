# VibeLang desktop

The same Foldkit app in Electrobun. Local files use the Bun host's pinned filesystem; local model calls run in the
SQLite flow engine through the Smithers agent. The model manager accepts a loopback OpenAI-compatible endpoint
(Ollama or LM Studio, for example); the person installs and manages its models there. Mock works without one.

From the repository root:

```sh
pnpm install --frozen-lockfile --filter '@smthrs/vibelang-site...' --filter '@smthrs/vibelang-desktop...'
cargo build --locked --release --package smithers-ffi --bin smithers-jj-export
cd apps/vibelang-desktop
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` can name an already built SDK helper. Build packages that helper into the app.
The native runtime is Bun 1.4.2, matching this repository; Electrobun's older default is overridden.

The lead runs those commands on the Mac to build and smoke-test the native app. To produce stable macOS artifacts:

```sh
pnpm build:view
bun run src/build.vibe
pnpm exec electrobun build --env=stable
```

Keep `VIBELANG_DESKTOP_TEST` unset for those artifacts. Test the native folder chooser, titlebar dragging, local
model selection and a real edit on the Mac. Signing and notarization require the
lead's credentials and are separate from this Linux receipt. Nothing here deploys the app.

`VIBELANG_DESKTOP_DATA` overrides the device data directory (default `$HOME/.local/share/vibelang`),
`VIBELANG_DESKTOP_PORT` the loopback port (default an ephemeral port), and `VIBELANG_DESKTOP_ASSETS` the bundled
view directory. Local model endpoints and model names are selected in Models, never hardcoded.

The native end-to-end test needs Linux's Xvfb, GTK 3, WebKitGTK 4.1, Ayatana appindicator libraries and `flock`. It runs
Electrobun itself and connects to CEF over CDP; it types into the real native folder chooser with X11. The small
OpenAI-compatible test server is the `TestModel` Effect service in `e2e/model-server.vibe`. It serves real HTTP;
no request is intercepted and no application code is replaced.

```sh
VIBELANG_DESKTOP_TEST=1 pnpm build
pnpm e2e
```

The test build enables a CDP port, 14509. Ordinary builds do not enable remote debugging. The local test model uses
24509; the native app uses 44509, because another active lane occupied the assigned 4509 during development.

The History page reuses the shared view and the existing no-backend `MockMythical` service, including its labelled
Mock mode and shared role source. Local model selection configures the chat; it does not create a cloud project
session. This host adds no second project backend. The shared offline role picker works in Mock; a local model restores Viewer and reports sign-in unavailable.

Decision [0025](../vibelang/wiki/decisions/0025-desktop.md) records the design and its ruling conflicts.

The SDK native fixture and the app fixture retain an advisory OS lock for their entire GUI lifetime, including
bounded process teardown. This keeps their actual Electrobun resources exclusive when checks are launched together.
Only the fixture setup budget includes that lock wait; individual browser cases retain their existing timeout.

`fs.edit` requires the exact original from `fs.read` as `before`; stale originals return false and preserve the
person's bytes. A completed durable replay returns its original result without a second write.

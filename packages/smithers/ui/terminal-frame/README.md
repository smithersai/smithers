# @smthrs/terminal-frame

A shell's terminal for Smithers UIs. `TerminalFrame` runs xterm.js in an
opaque-origin frame whose CSP pins the generated runtime by hash and allows no
network, while your page holds the connection. A shell's output, escape
sequences and links included, never runs in your page.

```tsx
import { TerminalFrame } from "@smthrs/terminal-frame";
```

Import from the package root only. The frame runtime, about 350 KB of text with
xterm.js inside, lives here rather than in `@smthrs/ui`, so a page without a
terminal never carries it.

`@smthrs/terminal-frame` is `private: true` and workspace-only, like
`@smthrs/ui`, whose theme registry it reads.

## Documentation

- [`docs/README.md`](./docs/README.md): what the frame does and where to start.
- [`docs/guides/frame-a-shell.md`](./docs/guides/frame-a-shell.md): show a live shell.
- [`docs/api.md`](./docs/api.md): every export and the frame's protocol.

## Development

```sh
pnpm test        # bun test --isolate test, at 100% line and function coverage
pnpm check       # vibelang -p tsconfig.json --noEmit
pnpm generate    # node scripts/build-runtime.mjs: regenerate src/runtime.generated.ts
bun test browser # the frame in real Chromium (pnpm exec playwright install chromium)
```

`src/runtime.generated.ts` is generated from `src/runtime.ts` and `src/frame.ts`
and committed. `test/runtime-generated.test.ts` fails until it matches its
sources.

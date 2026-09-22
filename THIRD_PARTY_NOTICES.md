# Third-party notices

This distribution contains third-party software. The notices below are
reproduced to satisfy the terms of the licenses those components are
distributed under. They are in addition to, and do not replace, the project's
own `LICENSE`.

## Effect (`Effect-TS/effect`)

`@smthrs/engine` is a fork of Effect's unstable durable-flow runtime and
contains substantial portions of that source. The fork point, upstream package
version, and a module-by-module record of what was vendored and how it was
changed are documented in `packages/smithers/flows/engine/VENDOR.md`:

- Upstream repository: `Effect-TS/effect`
- Upstream commit: `23e176a4f05ed3e81cc13a5d70111099692ea9a5`
- Upstream package: `effect@4.0.0-beta.102`
- Upstream source: `packages/effect/src/unstable/workflow`
- Vendored modules: `Flow.ts`, `Activity.ts`, `FlowEngine.ts`,
  `DurableClock.ts`, `DurableDeferred.ts`, `DurableQueue.ts`, `FlowProxy.ts`,
  `FlowProxyServer.ts`, and `index.ts`

Effect is distributed under the MIT License. Its copyright and permission
notice is reproduced here verbatim:

```
MIT License

Copyright (c) 2023 Effectful Technologies Inc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Every `@smthrs/*` package also depends on Effect at runtime, so the notice
above applies to those dependencies as well as to the vendored engine source.

## jj (`jj-vcs/jj`)

`@smthrs/jj` ships `wasm/flows_jj.wasm`, a `wasm32-wasip1` build of
`crates/flows-jj` that statically links `jj-lib` — taken from a fork of
Jujutsu that `crates/flows-jj/Cargo.toml` pins as a git dependency at one
rev — and jj-lib's transitive Rust dependency closure.

- Upstream repository: `jj-vcs/jj` (<https://github.com/jj-vcs/jj>)
- Fork: <https://github.com/smithersai/jj>, branch `flows-wasm`, pinned as a
  cargo git dependency at rev `47589ada70c12b3e829b5c98ab32503abad49eac`
  (`crates/flows-jj/Cargo.toml`, `Cargo.lock`)
- Crates statically linked: `jj-lib` and `jj-lib-proc-macros`, version
  0.44.0, both Apache-2.0
- Copyright 2020–2026 The Jujutsu Authors

jj-lib is distributed under the Apache License, Version 2.0, which requires
that redistributions carry a copy of the license text. The full Apache-2.0
text, the jj-lib attribution, and the license/copyright of every crate
statically linked into `wasm/flows_jj.wasm` — enumerated from `cargo
metadata`/`cargo tree` against `crates/flows-jj` and grouped by license —
are reproduced in `packages/smithers/flows/jj/THIRD_PARTY_NOTICES.md`, which ships inside
that package's published npm tarball.

The Docker and native application distributions also include the `jj` CLI
built from the same exact fork revision. Its Apache-2.0 license is shipped as
`licenses/jj-LICENSE`.

## Git

The Docker distribution builds Git 2.50.1 from the checksum-pinned kernel.org
source archive. The macOS distribution copies Apple Git 2.50.1 from the Xcode
build toolchain together with its relocatable helper and template tree. Git is
licensed under GPL-2.0; the license text is shipped as
`licenses/git-COPYING`.

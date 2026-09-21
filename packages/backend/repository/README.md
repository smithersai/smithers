# Repository engine

`repository.OpenLocal` embeds the same repository server used by
`repository.NewService`. The local client calls its handler in process and
stores repositories under `Config.StoragePath`. The self-hosted app injects
`Local.Client()` into its existing repository services and keeps its public Git
routes behind the app's authorization. It does not need a repo-host listener or
storage-set lookup. Plue can use `NewRemoteClient` and host `NewService` behind
its own routing and isolation.

The Go service loads `libsmithers_ffi` at `Config.FFILibraryPath`. Build that
library from this repository with Rust 1.98, then build the Go app. The
browser's `flows-jj` Wasm artifact remains pinned to Rust 1.89; both Rust
crates use the same jj-lib revision from the root Cargo workspace.

```sh
cargo +1.98.0 build -p smithers-ffi --lib
SMITHERS_FFI_LIBRARY_PATH="$PWD/target/debug/libsmithers_ffi.dylib" \
  go test ./packages/backend/repository ./packages/backend/internal/repohostserver
```

On Linux, use `libsmithers_ffi.so` and a glibc image. The integration suite
creates real repositories and runs Git clone/push, jj diff, expected-head
landing, replay, and fresh-clone checks in both local and hosted modes.

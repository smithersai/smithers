//! `flows-jj`: the flows `Jj` contract implemented over jj-lib, packaged as a
//! wasm32-wasip1 reactor module for the browser.
//!
//! The `Jj` service (`packages/smithers/flows/jj/src/Jj.ts`) has two production layers:
//! `NodeJj` shells out to the `jj` CLI; `BrowserJj` instantiates this crate's
//! `flows_jj.wasm` over a WASI preview1 host shim backed by a virtual
//! filesystem. This crate is the whole Rust side of that seam — eight ops, one
//! JSON call ABI, nothing else. No CLI code, no config machinery, no pager,
//! no revset surface.
//!
//! - [`ops`] — init/snapshot/restore/opRestore/diff/workspaceAdd/workspaceForget/status
//!   over jj-lib, mirroring `NodeJj` semantics.
//! - [`diff_render`] / [`status_render`] — the text renderers (jj keeps its
//!   own in jj-cli; the contract needs stable output owned here).
//! - [`error`] — classification onto the frozen `JjErrorCode` set.
//! - [`protocol`] / [`abi`] — the frozen JSON request/response types and the
//!   `flows_jj_call` export.
//!
//! Repos use jj's `SimpleBackend` (git interop is out of scope); the on-disk
//! format compatibility is pinned by the jj fork's rev in `Cargo.toml`.

pub mod abi;
pub mod diff_render;
pub mod error;
pub mod ops;
pub mod protocol;
pub mod status_render;

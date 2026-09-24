//! The `flows_jj_call` ABI: UTF-8 JSON in, UTF-8 JSON out, no panics across
//! the boundary.
//!
//! Exports (wasm32-wasip1 reactor module):
//! - `memory` — the linear memory (exported by the linker).
//! - `_initialize()` — reactor init; the host calls it once after
//!   instantiation.
//! - `flows_jj_alloc(size) -> ptr` / `flows_jj_free(ptr, size)` — buffer
//!   management. The host allocates the request buffer, writes JSON, calls,
//!   then frees BOTH buffers (wasm never frees the request).
//! - `flows_jj_call(req_ptr, req_len) -> u64` — dispatch. The return value
//!   packs the response buffer as `(ptr << 32) | len`; `0` means allocation
//!   failed. The response is always a JSON `Response`.
//!
//! Everything is wrapped in `std::panic::catch_unwind` so a bug surfaces as
//! an `{"err":...}` response rather than tearing down the instance. (On
//! wasm32-wasip1 panics abort before unwinding — the host shim additionally
//! guards the call — but the catch is real on native targets and in tests.)

use std::panic;
use std::panic::AssertUnwindSafe;
use std::path::Path;

use crate::error::ErrorCode;
use crate::error::OpError;
use crate::ops;
use crate::protocol::ErrPayload;
use crate::protocol::OkPayload;
use crate::protocol::Request;
use crate::protocol::Response;

/// Handles one raw request, catching panics. This is the whole ABI minus the
/// pointer packing, and what native tests exercise.
pub fn call_json(request: &[u8]) -> Vec<u8> {
    catching(AssertUnwindSafe(|| handle(request)))
}

/// Runs `handler`, converting a panic into an `{"err":...}` response.
fn catching(handler: impl FnOnce() -> Vec<u8> + panic::UnwindSafe) -> Vec<u8> {
    panic::catch_unwind(handler).unwrap_or_else(|payload| {
        let message = if let Some(text) = payload.downcast_ref::<&str>() {
            (*text).to_owned()
        } else if let Some(text) = payload.downcast_ref::<String>() {
            text.clone()
        } else {
            "unknown panic".to_owned()
        };
        encode(&Response::Err(ErrPayload {
            code: ErrorCode::Unknown,
            message: format!("jj: panic: {message}"),
            command: "jj".to_owned(),
        }))
    })
}

fn handle(request: &[u8]) -> Vec<u8> {
    let request: Request = match serde_json::from_slice(request) {
        Ok(request) => request,
        Err(err) => {
            return encode(&Response::Err(ErrPayload {
                code: ErrorCode::Unknown,
                message: format!("jj: malformed request: {err}"),
                command: "jj".to_owned(),
            }));
        }
    };
    // The message is deliberately bare: the TypeScript bridge prefixes every
    // error with `jj {method}: ` (mirroring how `NodeJj` prefixes stderr), so
    // a crate-side prefix would appear twice in every surfaced message.
    let response = match dispatch(&request) {
        Ok(payload) => Response::Ok(payload),
        Err(err) => Response::Err(ErrPayload {
            code: err.code,
            message: err.message,
            command: request.command(),
        }),
    };
    encode(&response)
}

fn dispatch(request: &Request) -> Result<OkPayload, OpError> {
    match request {
        Request::Init { root } => {
            ops::init(Path::new(root))?;
            Ok(OkPayload::Unit {})
        }
        Request::Snapshot { root, message } => {
            let ops::Snapshot {
                commit_id,
                change_id,
            } = ops::snapshot(Path::new(root), message.as_deref())?;
            Ok(OkPayload::Snapshot {
                commit_id,
                change_id,
            })
        }
        Request::Restore { root, change_id } => {
            ops::restore(Path::new(root), change_id)?;
            Ok(OkPayload::Unit {})
        }
        Request::Diff { root, from, to } => {
            let diff = ops::diff(Path::new(root), from, to)?;
            Ok(OkPayload::Diff { diff })
        }
        Request::WorkspaceAdd { root, name, path } => {
            ops::workspace_add(Path::new(root), name, path)?;
            Ok(OkPayload::Unit {})
        }
        Request::WorkspaceForget { root, name } => {
            ops::workspace_forget(Path::new(root), name)?;
            Ok(OkPayload::Unit {})
        }
        Request::Status { root } => {
            let status = ops::status(Path::new(root))?;
            Ok(OkPayload::Status { status })
        }
    }
}

/// Serializes a response. Serialization of these types cannot fail (string
/// keys, no non-finite floats), but a hand-written fallback keeps the
/// "no panics" promise absolute.
fn encode(response: &Response) -> Vec<u8> {
    serde_json::to_vec(response).unwrap_or_else(|err| {
        format!(
            "{{\"err\":{{\"code\":\"unknown\",\"message\":\"response serialization failed: {err}\",\"command\":\"jj\"}}}}"
        )
        .into_bytes()
    })
}

/// The raw wasm exports. Pointer packing only exists on wasm32, where
/// pointers fit in `u32`; native tests go through [`call_json`].
#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::alloc::Layout;
    use std::alloc::alloc;
    use std::alloc::dealloc;

    /// Reactor initialization. The ABI requires this export and the host
    /// calls it exactly once after instantiation. Rust links no static
    /// constructors into this module (wasm-ld would synthesize `_initialize`
    /// itself if `__wasm_call_ctors` existed — if that ever happens, this
    /// definition becomes a duplicate-symbol link error and must be removed),
    /// so the function has nothing to do; it exists to make instantiation
    /// explicit and keep the export surface frozen.
    #[unsafe(no_mangle)]
    pub extern "C" fn _initialize() {}

    /// Allocates `size` bytes inside wasm linear memory. Returns 0 when the
    /// allocation fails or `size` is 0.
    #[unsafe(no_mangle)]
    pub extern "C" fn flows_jj_alloc(size: u32) -> u32 {
        let Ok(layout) = Layout::array::<u8>(size as usize) else {
            return 0;
        };
        if layout.size() == 0 {
            return 0;
        }
        // SAFETY: layout has non-zero size.
        let ptr = unsafe { alloc(layout) };
        ptr as u32
    }

    /// Frees a buffer produced by `flows_jj_alloc` (or returned from
    /// `flows_jj_call`). `ptr`/`size` must match the original allocation.
    #[unsafe(no_mangle)]
    pub extern "C" fn flows_jj_free(ptr: u32, size: u32) {
        if ptr == 0 || size == 0 {
            return;
        }
        let Ok(layout) = Layout::array::<u8>(size as usize) else {
            return;
        };
        // SAFETY: the contract requires (ptr, size) to be a live allocation
        // made by flows_jj_alloc with the same size.
        unsafe { dealloc(ptr as *mut u8, layout) };
    }

    /// Dispatches one JSON request; returns `(ptr << 32) | len` of the JSON
    /// response, or 0 if the response buffer could not be allocated.
    #[unsafe(no_mangle)]
    pub extern "C" fn flows_jj_call(req_ptr: u32, req_len: u32) -> u64 {
        let request: &[u8] = if req_len == 0 {
            &[]
        } else {
            // SAFETY: the host wrote req_len bytes at req_ptr, a buffer it
            // obtained from flows_jj_alloc.
            unsafe { std::slice::from_raw_parts(req_ptr as *const u8, req_len as usize) }
        };
        let response = super::call_json(request);
        let len = response.len() as u32;
        let ptr = flows_jj_alloc(len);
        if ptr == 0 {
            return 0;
        }
        // SAFETY: ptr is a fresh allocation of len bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(response.as_ptr(), ptr as *mut u8, response.len());
        }
        (u64::from(ptr) << 32) | u64::from(len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_becomes_err_response() {
        let json = catching(|| panic!("boom"));
        let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(value["err"]["code"], "unknown");
        assert!(value["err"]["message"].as_str().unwrap().contains("boom"));
        assert_eq!(value["err"]["command"], "jj");
    }

    #[test]
    fn panic_with_string_payload_becomes_err_response() {
        let json = catching(|| panic!("boom {}", 42));
        let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert!(
            value["err"]["message"]
                .as_str()
                .unwrap()
                .contains("boom 42")
        );
    }
}

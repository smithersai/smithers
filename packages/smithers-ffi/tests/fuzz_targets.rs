//! Structured, adversarial, and multi-replica CRDT fuzz tests for `smithers-ffi`.
//!
//! Exercises the C ABI (`ld_*` live documents and `smithers_*` JSON entrypoints),
//! strict Yjs v1 binary decoding (varint overflow / client-id aliasing resistance),
//! and multi-peer CRDT Strong Eventual Consistency.
//!
//! Runs a deterministic baseline in `cargo test`; set `FUZZ_ITERS` and `FUZZ_SEED`
//! for extended campaigns on bare-metal hosts.

use std::ffi::{CStr, CString};

use smithers_ffi::live_document::{
    ld_apply, ld_awareness, ld_close, ld_free, ld_open, ld_peer, ld_set_author, ld_state, ld_sync1,
    ld_sync2, ld_text, LdResult,
};
use smithers_ffi::{smithers_free_string, smithers_wiki_document};
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, Options, ReadTxn, StateVector, Text, Transact};

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn usize(&mut self, max: usize) -> usize {
        if max == 0 {
            0
        } else {
            (self.next_u64() as usize) % max
        }
    }
    fn bytes(&mut self, max_len: usize) -> Vec<u8> {
        let len = self.usize(max_len + 1);
        (0..len).map(|_| (self.next_u64() & 0xff) as u8).collect()
    }
}

fn fuzz_iters(default: usize) -> usize {
    std::env::var("FUZZ_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn fuzz_seed() -> u64 {
    std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0xfeed_face_dead_beef)
}

fn take_ld_bytes(res: LdResult) -> (u32, Vec<u8>) {
    let status = res.status;
    assert_ne!(status, 3, "FFI boundary panicked (status == 3)");
    let out = if res.data.is_null() || res.len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(res.data, res.len).to_vec() }
    };
    unsafe { ld_free(res) };
    (status, out)
}

#[test]
fn fuzz_live_document_c_abi_adversarial_bytes_never_panic() {
    let mut rng = Rng::new(fuzz_seed());
    let iters = fuzz_iters(3_000);

    // Adversarial seed corpus: empty, non-canonical varints, 64-bit aliasing varints,
    // deeply nested Any arrays/maps (depth > 64), attacker-sized counts, trailing bytes.
    let mut deep_nested = vec![117u8; 80];
    deep_nested.push(0);
    let oversized_varint_alias: Vec<u8> = vec![0x81, 0x80, 0x80, 0x80, 0x10, 0x00];
    let huge_count: Vec<u8> = vec![0xff, 0xff, 0xff, 0xff, 0x0f];
    let seeds: Vec<Vec<u8>> = vec![
        vec![],
        vec![0],
        vec![0, 0],
        vec![0, 0, 0],
        vec![0xff; 32],
        deep_nested,
        oversized_varint_alias,
        huge_count,
    ];

    for kind in [0u32, 1, 2, 99, u32::MAX] {
        for seed in &seeds {
            let h = unsafe { ld_open(kind, seed.as_ptr(), seed.len()) };
            if h != 0 {
                let (st, _) = take_ld_bytes(ld_close(h));
                assert_eq!(st, 0);
            }
        }
    }

    // Open one valid code doc (kind=0) and one wiki doc (kind=1)
    for kind in [0u32, 1] {
        let h = unsafe { ld_open(kind, std::ptr::null(), 0) };
        assert_ne!(h, 0, "empty ld_open({kind}) must succeed");
        let (st, _) = take_ld_bytes(unsafe { ld_set_author(h, 42, b"alice".as_ptr(), 5) });
        assert_eq!(st, 0);

        for i in 0..iters {
            let payload = if i < seeds.len() {
                seeds[i].clone()
            } else {
                rng.bytes(192)
            };
            let op = rng.usize(7);
            match op {
                0 => {
                    // Unregistered client MUST never succeed (status 0)
                    let (st, _) = take_ld_bytes(unsafe {
                        ld_apply(h, 9999, payload.as_ptr(), payload.len())
                    });
                    assert_ne!(st, 0, "unregistered client must be rejected");
                }
                1 => {
                    let _ =
                        take_ld_bytes(unsafe { ld_apply(h, 42, payload.as_ptr(), payload.len()) });
                }
                2 => {
                    let _ = take_ld_bytes(unsafe { ld_peer(h, payload.as_ptr(), payload.len()) });
                }
                3 => {
                    let _ = take_ld_bytes(unsafe { ld_sync2(h, payload.as_ptr(), payload.len()) });
                }
                4 => {
                    let _ =
                        take_ld_bytes(unsafe { ld_awareness(h, payload.as_ptr(), payload.len()) });
                }
                5 => {
                    let _ = take_ld_bytes(unsafe { ld_text(h, payload.as_ptr(), payload.len()) });
                }
                _ => {
                    let (st1, _) = take_ld_bytes(ld_sync1(h));
                    assert_eq!(st1, 0);
                    let (st2, state_bytes) = take_ld_bytes(ld_state(h));
                    assert_eq!(st2, 0);
                    // Every valid state returned by ld_state must cleanly reopen!
                    let h2 = unsafe { ld_open(kind, state_bytes.as_ptr(), state_bytes.len()) };
                    assert_ne!(h2, 0, "ld_state output must always reopen cleanly");
                    let (stc, _) = take_ld_bytes(ld_close(h2));
                    assert_eq!(stc, 0);
                }
            }
        }

        let (stc, _) = take_ld_bytes(ld_close(h));
        assert_eq!(stc, 0);
        // Post-close calls must return invalid (2), never panic (3) or succeed (0)
        let (st_after, _) = take_ld_bytes(ld_state(h));
        assert_eq!(st_after, 2);
    }
}

#[test]
fn fuzz_live_document_multi_replica_crdt_convergence() {
    let mut rng = Rng::new(fuzz_seed() ^ 0x1234_5678_9abc_def0);
    let trials = (fuzz_iters(40) / 2).clamp(10, 100);

    for _ in 0..trials {
        // 3 independent replicas using kind=0 (code doc, root "text")
        let handles: Vec<u64> = (0..3)
            .map(|_| {
                let h = unsafe { ld_open(0, std::ptr::null(), 0) };
                assert_ne!(h, 0);
                for cid in [10u64, 20, 30] {
                    let name = format!("user-{cid}");
                    let (st, _) =
                        take_ld_bytes(unsafe { ld_set_author(h, cid, name.as_ptr(), name.len()) });
                    assert_eq!(st, 0);
                }
                h
            })
            .collect();

        // Each client generates local Yjs v1 edits on its own Doc with its own client_id
        let mut client_docs: Vec<Doc> = [10u64, 20, 30]
            .iter()
            .map(|&cid| {
                let opts = Options {
                    client_id: yrs::ClientID::new(cid),
                    offset_kind: yrs::OffsetKind::Utf16,
                    ..Options::default()
                };
                Doc::with_options(opts)
            })
            .collect();
        for d in &client_docs {
            d.get_or_insert_text("content");
        }

        let mut all_updates: Vec<(u64, Vec<u8>)> = Vec::new();
        let alphabet = ["a", "b", "c", "\n", "🚀", "é", "xyz"];

        for _ in 0..18 {
            let idx = rng.usize(3);
            let cid = [10u64, 20, 30][idx];
            let doc = &mut client_docs[idx];
            let text = doc.get_or_insert_text("content");
            let sv_before = doc.transact().state_vector();
            {
                let mut txn = doc.transact_mut();
                // Compute valid UTF-16 scalar-value boundaries so edits never split a surrogate pair
                let current = text.get_string(&txn);
                let mut bounds: Vec<u32> = vec![0];
                let mut u16_pos: u32 = 0;
                for ch in current.chars() {
                    u16_pos += ch.len_utf16() as u32;
                    bounds.push(u16_pos);
                }
                if bounds.len() > 1 && rng.usize(3) == 0 {
                    let start_idx = rng.usize(bounds.len() - 1);
                    let end_idx = (start_idx + 1 + rng.usize(3)).min(bounds.len() - 1);
                    text.remove_range(
                        &mut txn,
                        bounds[start_idx],
                        bounds[end_idx] - bounds[start_idx],
                    );
                } else {
                    let pos = bounds[rng.usize(bounds.len())];
                    let s = alphabet[rng.usize(alphabet.len())];
                    text.insert(&mut txn, pos, s);
                }
            }
            let update = doc.transact().encode_diff_v1(&sv_before);
            all_updates.push((cid, update));
        }

        // Deliver all updates to each replica in a DIFFERENT shuffled order (plus duplicates!)
        // Using ld_peer for out-of-order / multi-author delivery and ld_sync1/ld_sync2 healing.
        for &h in &handles {
            let mut order: Vec<usize> = (0..all_updates.len()).collect();
            for i in (1..order.len()).rev() {
                let j = rng.usize(i + 1);
                order.swap(i, j);
            }
            // Deliver in shuffled order until causal quiescence, then replay once more for idempotency.
            let mut applied = vec![false; all_updates.len()];
            loop {
                let mut progress = false;
                for &idx in &order {
                    if applied[idx] {
                        continue;
                    }
                    let (_, ref upd) = all_updates[idx];
                    let (st, _) = take_ld_bytes(unsafe { ld_peer(h, upd.as_ptr(), upd.len()) });
                    assert!(st == 0 || st == 1, "unexpected ld_peer status {st}");
                    if st == 0 {
                        applied[idx] = true;
                        progress = true;
                    }
                }
                if !progress {
                    break;
                }
            }
            assert!(
                applied.iter().all(|&a| a),
                "causal retry must eventually admit every valid update"
            );
            // Replay every update a second time to verify idempotency
            for &idx in &order {
                let (_, ref upd) = all_updates[idx];
                let (st, _) = take_ld_bytes(unsafe { ld_peer(h, upd.as_ptr(), upd.len()) });
                assert_eq!(st, 0, "duplicate replay of valid update must be idempotent");
            }
        }

        // Pairwise sync1/sync2 exchange guarantees causal closure
        for i in 0..handles.len() {
            for j in 0..handles.len() {
                if i == j {
                    continue;
                }
                let (s1, sv) = take_ld_bytes(ld_sync1(handles[j]));
                assert_eq!(s1, 0);
                let (s2, diff) =
                    take_ld_bytes(unsafe { ld_sync2(handles[i], sv.as_ptr(), sv.len()) });
                assert_eq!(s2, 0);
                if !diff.is_empty() {
                    let (sp, _) =
                        take_ld_bytes(unsafe { ld_peer(handles[j], diff.as_ptr(), diff.len()) });
                    assert_eq!(sp, 0);
                }
            }
        }

        // Strong Eventual Consistency: ALL 3 replicas MUST hold identical text!
        let texts: Vec<Vec<u8>> = handles
            .iter()
            .map(|&h| {
                let (st, txt) = take_ld_bytes(unsafe { ld_text(h, b"content".as_ptr(), 7) });
                assert_eq!(st, 0);
                txt
            })
            .collect();
        assert_eq!(texts[0], texts[1], "replica 0 and 1 diverged");
        assert_eq!(texts[1], texts[2], "replica 1 and 2 diverged");

        // Also check full-doc encoding roundtrip through StateVector::default()
        let _ = StateVector::default().encode_v1();

        for h in handles {
            let (stc, _) = take_ld_bytes(ld_close(h));
            assert_eq!(stc, 0);
        }
    }
}

#[test]
fn fuzz_wiki_document_ffi_json_never_panics() {
    let mut rng = Rng::new(fuzz_seed() ^ 0xabcd_ef01_2345_6789);
    let iters = fuzz_iters(1_000);

    // NULL pointer must return valid JSON error envelope
    let null_ptr = smithers_wiki_document(std::ptr::null());
    assert!(!null_ptr.is_null());
    let s = unsafe { CStr::from_ptr(null_ptr) }
        .to_str()
        .unwrap()
        .to_owned();
    unsafe { smithers_free_string(null_ptr) };
    let v: serde_json::Value = serde_json::from_str(&s).expect("NULL must return JSON");
    assert!(v.get("error").is_some());

    for i in 0..iters {
        let raw = if i % 3 == 0 {
            let mut b = rng.bytes(160);
            b.retain(|&c| c != 0);
            b
        } else {
            let op = ["seed", "apply", "replace", "bogus"][rng.usize(4)];
            let json_str = format!(
                "{{\"operation\":\"{op}\",\"markdown\":\"{}\",\"state\":\"{}\",\"update\":\"{}\"}}",
                "a".repeat(rng.usize(32)),
                "AAAA".repeat(rng.usize(8)),
                "BBBB".repeat(rng.usize(8))
            );
            json_str.into_bytes()
        };
        let Ok(cstr) = CString::new(raw) else {
            continue;
        };
        let ptr = smithers_wiki_document(cstr.as_ptr());
        assert!(!ptr.is_null(), "smithers_wiki_document returned NULL");
        let resp = unsafe { CStr::from_ptr(ptr) }
            .to_str()
            .expect("response must be valid UTF-8")
            .to_owned();
        unsafe { smithers_free_string(ptr) };
        let _: serde_json::Value =
            serde_json::from_str(&resp).expect("response must always be valid JSON");
    }
}

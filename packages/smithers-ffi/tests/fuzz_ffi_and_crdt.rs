//! Deterministic seeded fuzz suite for `smithers-ffi` C ABI, strict Yjs v1
//! CRDT decoding/convergence, and wiki document round-trips. Runs under
//! standard `cargo test` on every platform; configure intensity with
//! `SMITHERS_FUZZ_CASES` and `SMITHERS_FUZZ_SEED`.
//! For coverage-guided libFuzzer campaigns on Linux, run `cargo +nightly fuzz run`.

use std::ffi::{CStr, CString};

use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde_json::{json, Value};
use smithers_ffi::live_document::{
    ld_apply, ld_awareness, ld_close, ld_free, ld_open, ld_peer, ld_set_author, ld_state, ld_sync1,
    ld_sync2, ld_text, LdResult,
};
use smithers_ffi::{smithers_free_string, smithers_wiki_document};
use yrs::{Doc, GetString, OffsetKind, Options, ReadTxn, Text, Transact};

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed ^ 0xa076_1d64_78bd_642f)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn usize(&mut self, bound: usize) -> usize {
        (self.next_u64() as usize) % bound
    }
    fn bytes(&mut self, max_len: usize) -> Vec<u8> {
        let len = self.usize(max_len + 1);
        (0..len).map(|_| (self.next_u64() & 0xff) as u8).collect()
    }
    fn text(&mut self, max_chars: usize) -> String {
        const ALPHABET: &[char] = &[
            'a', 'Z', ' ', '\n', '#', '*', '`', '[', ']', '"', '\\', 'é', '中', '🚀',
        ];
        let len = self.usize(max_chars + 1);
        (0..len)
            .map(|_| ALPHABET[self.usize(ALPHABET.len())])
            .collect()
    }
}

fn take_ld(res: LdResult) -> (u32, Vec<u8>) {
    assert_ne!(res.status, 3, "live_document C ABI caught a Rust panic");
    let status = res.status;
    if res.len == 0 {
        assert!(
            res.data.is_null(),
            "C ABI returned non-null pointer with len=0"
        );
        unsafe { ld_free(res) };
        return (status, Vec::new());
    }
    assert!(
        !res.data.is_null(),
        "C ABI returned null pointer with len>0"
    );
    let owned = unsafe { std::slice::from_raw_parts(res.data, res.len) }.to_vec();
    unsafe { ld_free(res) };
    (status, owned)
}

fn call_wiki(input: &str) -> Value {
    let cstr = CString::new(input.replace('\0', "")).unwrap();
    let ptr = smithers_wiki_document(cstr.as_ptr());
    assert!(!ptr.is_null());
    let text = unsafe { CStr::from_ptr(ptr) }.to_str().unwrap().to_owned();
    unsafe { smithers_free_string(ptr) };
    serde_json::from_str(&text).expect("wiki FFI must emit valid JSON")
}

#[test]
fn fuzz_live_document_strict_decode_and_crdt_convergence() {
    let seed: u64 = std::env::var("SMITHERS_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_261_122);
    let cases: usize = std::env::var("SMITHERS_FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(250);
    let mut rng = Rng::new(seed);

    for case in 0..cases {
        // 1. Adversarial raw bytes (including varint-bomb patterns with 0x80..0xff runs).
        let raw = if case % 5 == 0 {
            let len = 1 + rng.usize(32);
            (0..len)
                .map(|_| 0x80 | ((rng.next_u64() & 0x7f) as u8))
                .collect()
        } else {
            rng.bytes(256)
        };
        let h_raw = unsafe { ld_open((case % 3) as u32, raw.as_ptr(), raw.len()) };
        if h_raw != 0 {
            let _ = take_ld(ld_state(h_raw));
            let _ = take_ld(ld_sync1(h_raw));
            let _ = take_ld(unsafe { ld_apply(h_raw, 1, raw.as_ptr(), raw.len()) });
            let _ = take_ld(unsafe { ld_peer(h_raw, raw.as_ptr(), raw.len()) });
            let _ = take_ld(unsafe { ld_sync2(h_raw, raw.as_ptr(), raw.len()) });
            let _ = take_ld(unsafe { ld_awareness(h_raw, raw.as_ptr(), raw.len()) });
            let _ = take_ld(ld_close(h_raw));
        }

        // 2. Commutativity & idempotency of concurrent Yjs edits across two replicas.
        let ca = 1 + (case as u64) * 2;
        let cb = ca + 1;
        let doc_a = Doc::with_options(Options {
            client_id: yrs::ClientID::new(ca),
            offset_kind: OffsetKind::Utf16,
            ..Default::default()
        });
        let doc_b = Doc::with_options(Options {
            client_id: yrs::ClientID::new(cb),
            offset_kind: OffsetKind::Utf16,
            ..Default::default()
        });
        for (doc, n_edits) in [(&doc_a, 1 + rng.usize(5)), (&doc_b, 1 + rng.usize(5))] {
            let text = doc.get_or_insert_text("content");
            let mut txn = doc.transact_mut();
            for _ in 0..n_edits {
                let cur = text.get_string(&txn);
                let mut bounds: Vec<u32> = vec![0];
                let mut u16_pos = 0u32;
                for ch in cur.chars() {
                    u16_pos += ch.len_utf16() as u32;
                    bounds.push(u16_pos);
                }
                let idx = bounds[rng.usize(bounds.len())];
                text.insert(&mut txn, idx, &rng.text(16));
            }
        }
        let upd_a = doc_a
            .transact()
            .encode_state_as_update_v1(&Default::default());
        let upd_b = doc_b
            .transact()
            .encode_state_as_update_v1(&Default::default());

        let h1 = unsafe { ld_open(0, std::ptr::null(), 0) };
        let h2 = unsafe { ld_open(0, std::ptr::null(), 0) };
        assert!(h1 != 0 && h2 != 0);
        // Security invariant: unauthenticated client update MUST be refused (status 1).
        assert_eq!(
            take_ld(unsafe { ld_apply(h1, ca, upd_a.as_ptr(), upd_a.len()) }).0,
            1
        );
        let a_actor = b"alice";
        let b_actor = b"bob";
        assert_eq!(
            take_ld(unsafe { ld_set_author(h1, ca, a_actor.as_ptr(), a_actor.len()) }).0,
            0
        );
        assert_eq!(
            take_ld(unsafe { ld_set_author(h1, cb, b_actor.as_ptr(), b_actor.len()) }).0,
            0
        );
        assert_eq!(
            take_ld(unsafe { ld_set_author(h2, ca, a_actor.as_ptr(), a_actor.len()) }).0,
            0
        );
        assert_eq!(
            take_ld(unsafe { ld_set_author(h2, cb, b_actor.as_ptr(), b_actor.len()) }).0,
            0
        );
        // Security invariant: spoofing client B update under client A identity MUST be refused.
        if !upd_b.is_empty() && upd_b != vec![0, 0] {
            let spoof_status = take_ld(unsafe { ld_apply(h1, ca, upd_b.as_ptr(), upd_b.len()) }).0;
            assert_ne!(
                spoof_status, 0,
                "spoofed foreign client update was accepted!"
            );
        }
        assert_eq!(
            take_ld(unsafe { ld_apply(h1, ca, upd_a.as_ptr(), upd_a.len()) }).0,
            0
        );
        assert_eq!(
            take_ld(unsafe { ld_apply(h1, cb, upd_b.as_ptr(), upd_b.len()) }).0,
            0
        );
        assert_eq!(
            take_ld(unsafe { ld_apply(h2, cb, upd_b.as_ptr(), upd_b.len()) }).0,
            0
        );
        assert_eq!(
            take_ld(unsafe { ld_apply(h2, ca, upd_a.as_ptr(), upd_a.len()) }).0,
            0
        );
        // Duplicate delivery must be idempotent.
        assert_eq!(
            take_ld(unsafe { ld_apply(h2, ca, upd_a.as_ptr(), upd_a.len()) }).0,
            0
        );

        let (s1_code, _s1) = take_ld(ld_state(h1));
        let (s2_code, _s2) = take_ld(ld_state(h2));
        assert_eq!(s1_code, 0);
        assert_eq!(s2_code, 0);
        let (t1_code, t1) = take_ld(unsafe { ld_text(h1, b"content".as_ptr(), b"content".len()) });
        let (t2_code, t2) = take_ld(unsafe { ld_text(h2, b"content".as_ptr(), b"content".len()) });
        assert_eq!(t1_code, 0);
        assert_eq!(t2_code, 0);
        assert_eq!(t1, t2, "case {case}: CRDT replicas diverged");
        let _ = take_ld(ld_close(h1));
        let _ = take_ld(ld_close(h2));
    }
}

#[test]
fn fuzz_wiki_document_seed_replace_and_malformed_updates() {
    let seed: u64 = std::env::var("SMITHERS_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_261_122);
    let cases: usize = std::env::var("SMITHERS_FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);
    let mut rng = Rng::new(seed ^ 0x5555_5555);

    for case in 0..cases {
        let md_a = rng.text(128);
        let md_b = rng.text(128);
        let seeded = call_wiki(&json!({ "operation": "seed", "markdown": md_a }).to_string());
        assert_eq!(
            seeded["markdown"].as_str(),
            Some(md_a.as_str()),
            "case {case}: seed mismatch"
        );
        let state = seeded["state"].as_str().expect("seed state");

        let replaced = call_wiki(
            &json!({ "operation": "replace", "state": state, "markdown": md_b }).to_string(),
        );
        assert_eq!(
            replaced["markdown"].as_str(),
            Some(md_b.as_str()),
            "case {case}: replace mismatch"
        );

        let junk = BASE64_STANDARD.encode(rng.bytes(128));
        let _ =
            call_wiki(&json!({ "operation": "apply", "state": state, "update": junk }).to_string());
        let raw_junk = String::from_utf8_lossy(&rng.bytes(96)).into_owned();
        let _ = call_wiki(&raw_junk);
    }
}

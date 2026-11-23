#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use smithers_ffi::live_document::{
    ld_apply, ld_awareness, ld_close, ld_free, ld_open, ld_peer, ld_set_author, ld_state, ld_sync1,
    ld_sync2, ld_text, LdResult,
};
use yrs::{Doc, GetString, OffsetKind, Options, ReadTxn, Text, Transact};

#[derive(Debug, Arbitrary)]
struct CrdtCase {
    kind: u8,
    raw_bytes: Vec<u8>,
    client_a: u32,
    client_b: u32,
    edits_a: Vec<(u8, String)>,
    edits_b: Vec<(u8, String)>,
}

fn take_result(res: LdResult) -> (u32, Vec<u8>) {
    assert!(
        res.status != 3,
        "live_document C ABI caught a Rust panic (status=3)!"
    );
    let status = res.status;
    if res.len == 0 {
        assert!(
            res.data.is_null(),
            "C ABI leaked non-null pointer with len=0"
        );
        unsafe { ld_free(res) };
        return (status, Vec::new());
    }
    assert!(!res.data.is_null(), "C ABI returned null with len>0");
    let slice = unsafe { std::slice::from_raw_parts(res.data, res.len) };
    let owned = slice.to_vec();
    unsafe { ld_free(res) };
    (status, owned)
}

fuzz_target!(|case: CrdtCase| {
    let raw = &case.raw_bytes[..case.raw_bytes.len().min(8192)];

    // 1. Adversarial raw bytes into ld_open, ld_apply, ld_peer, ld_sync2, ld_awareness, ld_text.
    let h_raw = unsafe { ld_open((case.kind % 3) as u32, raw.as_ptr(), raw.len()) };
    if h_raw != 0 {
        let _ = take_result(ld_state(h_raw));
        let _ = take_result(ld_sync1(h_raw));
        let _ =
            take_result(unsafe { ld_apply(h_raw, case.client_a as u64, raw.as_ptr(), raw.len()) });
        let _ = take_result(unsafe { ld_peer(h_raw, raw.as_ptr(), raw.len()) });
        let _ = take_result(unsafe { ld_sync2(h_raw, raw.as_ptr(), raw.len()) });
        let _ = take_result(unsafe { ld_awareness(h_raw, raw.as_ptr(), raw.len()) });
        let _ = take_result(unsafe { ld_text(h_raw, raw.as_ptr(), raw.len()) });
        let _ = take_result(ld_close(h_raw));
    }

    // 2. Structured CRDT commutativity & idempotency across two independent replicas.
    let ca = (case.client_a % 100_000).saturating_add(1) as u64;
    let cb = (case.client_b % 100_000).saturating_add(100_002) as u64;
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
    {
        let text_a = doc_a.get_or_insert_text("content");
        let mut txn = doc_a.transact_mut();
        for (pos, s) in case.edits_a.iter().take(6) {
            let chunk: String = s.chars().take(32).collect();
            let cur = text_a.get_string(&txn);
            let mut bounds: Vec<u32> = vec![0];
            let mut u16_pos = 0u32;
            for ch in cur.chars() {
                u16_pos += ch.len_utf16() as u32;
                bounds.push(u16_pos);
            }
            let idx = bounds[(*pos as usize) % bounds.len()];
            text_a.insert(&mut txn, idx, &chunk);
        }
    }
    {
        let text_b = doc_b.get_or_insert_text("content");
        let mut txn = doc_b.transact_mut();
        for (pos, s) in case.edits_b.iter().take(6) {
            let chunk: String = s.chars().take(32).collect();
            let cur = text_b.get_string(&txn);
            let mut bounds: Vec<u32> = vec![0];
            let mut u16_pos = 0u32;
            for ch in cur.chars() {
                u16_pos += ch.len_utf16() as u32;
                bounds.push(u16_pos);
            }
            let idx = bounds[(*pos as usize) % bounds.len()];
            text_b.insert(&mut txn, idx, &chunk);
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
    if h1 != 0 && h2 != 0 {
        assert_eq!(
            take_result(unsafe { ld_apply(h1, ca, upd_a.as_ptr(), upd_a.len()) }).0,
            1
        );
        let a_actor = b"alice";
        let b_actor = b"bob";
        let _ = take_result(unsafe { ld_set_author(h1, ca, a_actor.as_ptr(), a_actor.len()) });
        let _ = take_result(unsafe { ld_set_author(h1, cb, b_actor.as_ptr(), b_actor.len()) });
        let _ = take_result(unsafe { ld_set_author(h2, ca, a_actor.as_ptr(), a_actor.len()) });
        let _ = take_result(unsafe { ld_set_author(h2, cb, b_actor.as_ptr(), b_actor.len()) });
        let (sa1, _) = take_result(unsafe { ld_apply(h1, ca, upd_a.as_ptr(), upd_a.len()) });
        let (sb1, _) = take_result(unsafe { ld_apply(h1, cb, upd_b.as_ptr(), upd_b.len()) });
        let (sb2, _) = take_result(unsafe { ld_apply(h2, cb, upd_b.as_ptr(), upd_b.len()) });
        let (sa2, _) = take_result(unsafe { ld_apply(h2, ca, upd_a.as_ptr(), upd_a.len()) });
        let (sa3, _) = take_result(unsafe { ld_apply(h2, ca, upd_a.as_ptr(), upd_a.len()) });
        if sa1 == 0 && sb1 == 0 && sb2 == 0 && sa2 == 0 && sa3 == 0 {
            let (_, _s1) = take_result(ld_state(h1));
            let (_, _s2) = take_result(ld_state(h2));
            let (_, t1) =
                take_result(unsafe { ld_text(h1, b"content".as_ptr(), b"content".len()) });
            let (_, t2) =
                take_result(unsafe { ld_text(h2, b"content".as_ptr(), b"content".len()) });
            assert_eq!(
                t1, t2,
                "CRDT replicas diverged under reordered/duplicate updates"
            );
        }
    }
    if h1 != 0 {
        let _ = take_result(ld_close(h1));
    }
    if h2 != 0 {
        let _ = take_result(ld_close(h2));
    }
});

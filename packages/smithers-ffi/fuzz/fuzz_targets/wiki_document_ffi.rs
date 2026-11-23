#![no_main]

use std::ffi::{CStr, CString};

use arbitrary::Arbitrary;
use base64::prelude::{Engine as _, BASE64_STANDARD};
use libfuzzer_sys::fuzz_target;
use serde_json::{json, Value};
use smithers_ffi::{smithers_free_string, smithers_wiki_document};

#[derive(Debug, Arbitrary)]
struct WikiCase {
    raw_json: Vec<u8>,
    markdown_a: String,
    markdown_b: String,
    junk_update: Vec<u8>,
}

fn call_wiki(input: &str) -> Value {
    let cstr = CString::new(input).expect("no interior NUL");
    let ptr = smithers_wiki_document(cstr.as_ptr());
    assert!(!ptr.is_null(), "smithers_wiki_document returned NULL");
    let text = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .expect("smithers_wiki_document must return valid UTF-8")
        .to_owned();
    unsafe { smithers_free_string(ptr) };
    serde_json::from_str(&text).expect("smithers_wiki_document must return valid JSON")
}

fuzz_target!(|case: WikiCase| {
    // 1. Raw arbitrary bytes (sanitized of NUL for CString).
    let raw: String =
        String::from_utf8_lossy(&case.raw_json[..case.raw_json.len().min(4096)]).replace('\0', "");
    let _ = call_wiki(&raw);

    // 2. Structured Seed -> Replace round-trip preserving exact UTF-8/UTF-16/astral text.
    let md_a: String = case
        .markdown_a
        .chars()
        .take(1024)
        .filter(|&c| c != '\0')
        .collect();
    let md_b: String = case
        .markdown_b
        .chars()
        .take(1024)
        .filter(|&c| c != '\0')
        .collect();
    let seeded = call_wiki(&json!({ "operation": "seed", "markdown": md_a }).to_string());
    assert_eq!(
        seeded["markdown"].as_str(),
        Some(md_a.as_str()),
        "seed round-trip mismatch: {seeded}"
    );
    let state = seeded["state"].as_str().expect("seed must return state");

    // 3. Replace after Seed must yield exact md_b.
    let replaced =
        call_wiki(&json!({ "operation": "replace", "state": state, "markdown": md_b }).to_string());
    assert_eq!(
        replaced["markdown"].as_str(),
        Some(md_b.as_str()),
        "replace round-trip mismatch: {replaced}"
    );

    // 4. Malformed base64 / Yjs update must never panic.
    let junk_b64 = BASE64_STANDARD.encode(&case.junk_update[..case.junk_update.len().min(2048)]);
    let _ =
        call_wiki(&json!({ "operation": "apply", "state": state, "update": junk_b64 }).to_string());
});

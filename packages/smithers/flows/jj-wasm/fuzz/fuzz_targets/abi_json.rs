#![no_main]

use libfuzzer_sys::fuzz_target;
use serde_json::Value;

fn assert_valid_response(out: &[u8]) {
    let text = std::str::from_utf8(out).expect("flows_jj ABI must emit valid UTF-8");
    let value: Value = serde_json::from_str(text).expect("flows_jj ABI must emit valid JSON");
    let obj = value.as_object().expect("response must be JSON object");
    assert_eq!(
        obj.len(),
        1,
        "response must have exactly one ok or err key: {text}"
    );
    if let Some(err) = obj.get("err") {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("");
        assert!(
            !msg.starts_with("jj: panic:"),
            "ABI panicked on fuzz input: {text}"
        );
    } else {
        assert!(obj.contains_key("ok"), "response must be ok or err: {text}");
    }
}

fuzz_target!(|data: &[u8]| {
    // 1. Raw bytes through protocol parser (never touches filesystem).
    let _ = serde_json::from_slice::<flows_jj::protocol::Request>(data);

    // 2. If the bytes parse as JSON, sandbox any root/path into a fresh TempDir
    //    so libFuzzer explores full ABI dispatch safely without touching the host FS.
    if let Ok(mut value) = serde_json::from_slice::<Value>(data) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("repo");
        let ws = temp.path().join("ws");
        if let Some(obj) = value.as_object_mut() {
            if obj.contains_key("root") {
                obj.insert(
                    "root".into(),
                    Value::String(root.to_string_lossy().into_owned()),
                );
            }
            if obj.contains_key("path") {
                obj.insert(
                    "path".into(),
                    Value::String(ws.to_string_lossy().into_owned()),
                );
            }
            let encoded = serde_json::to_vec(&value).expect("re-encode");
            let out = flows_jj::abi::call_json(&encoded);
            assert_valid_response(&out);
            return;
        }
    }

    // 3. Malformed / non-object bytes directly through call_json.
    let out = flows_jj::abi::call_json(data);
    assert_valid_response(&out);
});

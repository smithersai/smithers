#![no_main]

use std::ffi::{CStr, CString};

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use serde_json::Value;
use smithers_ffi::{
    smithers_create_bookmark, smithers_create_snapshot, smithers_delete_bookmark,
    smithers_free_string, smithers_get_file_content, smithers_get_working_tree_status,
    smithers_init_repo, smithers_list_bookmarks, smithers_list_changes, smithers_list_directory,
    smithers_list_tree_files,
};

#[derive(Debug, Arbitrary)]
enum RepoOp {
    WriteFile { name_idx: u8, body: Vec<u8> },
    Snapshot,
    ListChanges { page: u32, per_page: u32 },
    ListTreeFiles,
    ListDirectory { path: String },
    GetFileContent { path: String },
    CreateBookmark { name: String },
    DeleteBookmark { name: String },
    ListBookmarks,
    Status,
}

const FILES: &[&str] = &["README.md", "src/main.ts", "dir/a b.txt", "data.bin"];

fn take_json(ptr: *mut std::ffi::c_char) -> Value {
    assert!(!ptr.is_null(), "FFI returned NULL");
    let text = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .expect("FFI must emit valid UTF-8")
        .to_owned();
    unsafe { smithers_free_string(ptr) };
    serde_json::from_str(&text).expect("FFI must emit valid JSON")
}

fn cstr(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap()
}

fuzz_target!(|ops: Vec<RepoOp>| {
    if ops.is_empty() || ops.len() > 16 {
        return;
    }
    let temp = tempfile::tempdir().expect("tempdir");
    let store = temp.path().join("repo");
    let store_s = store.to_string_lossy().into_owned();
    let store_c = cstr(&store_s);

    // NULL pointer safety check.
    let null_err = take_json(smithers_init_repo(std::ptr::null()));
    assert!(null_err.get("error").is_some());

    let init = take_json(smithers_init_repo(store_c.as_ptr()));
    assert_eq!(init["status"].as_str(), Some("ok"), "init failed: {init}");

    let changes = take_json(smithers_list_changes(store_c.as_ptr(), 1, 10));
    let mut last_change_id: Option<String> =
        changes["items"][0]["change_id"].as_str().map(str::to_owned);

    for op in ops {
        match op {
            RepoOp::WriteFile { name_idx, mut body } => {
                body.truncate(1024);
                let rel = FILES[(name_idx as usize) % FILES.len()];
                let full = store.join(rel);
                if let Some(p) = full.parent() {
                    let _ = std::fs::create_dir_all(p);
                }
                let _ = std::fs::write(full, body);
            }
            RepoOp::Snapshot => {
                if let Some(cid) = &last_change_id {
                    let c = cstr(cid);
                    let _ = take_json(smithers_create_snapshot(store_c.as_ptr(), c.as_ptr()));
                }
            }
            RepoOp::ListChanges { page, per_page } => {
                let _ = take_json(smithers_list_changes(store_c.as_ptr(), page, per_page));
            }
            RepoOp::ListTreeFiles => {
                if let Some(cid) = &last_change_id {
                    let c = cstr(cid);
                    let _ = take_json(smithers_list_tree_files(
                        store_c.as_ptr(),
                        c.as_ptr(),
                        std::ptr::null(),
                    ));
                }
            }
            RepoOp::ListDirectory { path } => {
                if let Some(cid) = &last_change_id {
                    let c = cstr(cid);
                    let p = cstr(&path.chars().take(64).collect::<String>());
                    let _ = take_json(smithers_list_directory(
                        store_c.as_ptr(),
                        c.as_ptr(),
                        p.as_ptr(),
                        std::ptr::null(),
                        50,
                    ));
                }
            }
            RepoOp::GetFileContent { path } => {
                if let Some(cid) = &last_change_id {
                    let c = cstr(cid);
                    let p = cstr(&path.chars().take(64).collect::<String>());
                    let _ = take_json(smithers_get_file_content(
                        store_c.as_ptr(),
                        c.as_ptr(),
                        p.as_ptr(),
                    ));
                }
            }
            RepoOp::CreateBookmark { name } => {
                if let Some(cid) = &last_change_id {
                    let n = cstr(&name.chars().take(32).collect::<String>());
                    let c = cstr(cid);
                    let _ = take_json(smithers_create_bookmark(
                        store_c.as_ptr(),
                        n.as_ptr(),
                        c.as_ptr(),
                    ));
                }
            }
            RepoOp::DeleteBookmark { name } => {
                let n = cstr(&name.chars().take(32).collect::<String>());
                let _ = take_json(smithers_delete_bookmark(store_c.as_ptr(), n.as_ptr()));
            }
            RepoOp::ListBookmarks => {
                let _ = take_json(smithers_list_bookmarks(store_c.as_ptr(), 1, 50));
            }
            RepoOp::Status => {
                let _ = take_json(smithers_get_working_tree_status(store_c.as_ptr()));
            }
        }
    }
});

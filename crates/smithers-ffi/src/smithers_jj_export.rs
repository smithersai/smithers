use std::io::Read as _;
use std::path::Path;

#[cfg(unix)]
mod atomic_fs;
#[cfg(windows)]
#[path = "atomic_windows_fs.rs"]
mod atomic_fs;
mod atomic_glob;
mod atomic_protocol;
#[cfg(windows)]
mod atomic_windows_handle;
mod file_eligibility;
mod source_create;
mod source_import;
mod source_publish;
mod workspace_engine;
mod workspace_files;
mod workspace_local;
mod workspace_projections;

const USAGE: &str = "usage: smithers-jj-export [--engine|--local] < JSON request\n       smithers-jj-export --eligible <repository-root> < JSON request\n       smithers-jj-export --projections <repository-root> <workspace-id> [cursor]\n       smithers-jj-export --head-projections <repository-root> <workspace-id> <cursor> <change-id> <commit-id> <ahead> <behind>\n       smithers-jj-export --check-config <repository-root> <workspace-id> <actor-id>\n       smithers-jj-export --create-source|--publish-source <repository-root> < JSON request\n       smithers-jj-export <repository-root> <full-commit-id> <output-parent>";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--atomic-fs" {
        return Ok(atomic_fs::serve()?);
    }
    #[cfg(windows)]
    if args.len() == 2 && args[0] == "--process-info" {
        let pid: u32 = args[1]
            .to_str()
            .ok_or("process ID must be UTF-8")?
            .parse()?;
        let observed = windows_process::started_at_ms(pid)?;
        println!(
            "{}",
            match observed {
                Some(started) => serde_json::json!({"status":"started", "startedAtMs":started}),
                None => serde_json::json!({"status":"gone"}),
            }
        );
        return Ok(());
    }
    // Provisioning stages this helper into every workspace guest and smoke-tests
    // the staged copy before trusting it (internal/services/workspace_scripts).
    // The smoke must prove the dynamic loader resolved the binary without
    // touching a repository, so both flags exit 0 with no side effects.
    if args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    if args.len() == 1 && (args[0] == "--version" || args[0] == "-V") {
        println!("smithers-jj-export {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.len() == 1 && args[0] == "--capabilities" {
        println!("{{\"capabilities\":[\"create-source/v1\",\"publish-created-source/v1\"]}}");
        return Ok(());
    }
    if args.len() == 4 && args[0] == "--check-config" {
        let repo = Path::new(&args[1]);
        let owner = source_create::provisioned_owner(repo)
            .map_err(|_| "workspace coding config is unavailable")?;
        let workspace = args[2].to_str().ok_or("workspace ID must be UTF-8")?;
        let actor: i64 = args[3].to_str().ok_or("actor ID must be UTF-8")?.parse()?;
        if owner.workspace_id != workspace || owner.actor_id != actor {
            return Err("workspace coding config owner does not match".into());
        }
        println!("ok");
        return Ok(());
    }
    if args.len() == 2 && args[0] == "--create-source" {
        match source_create::run(Path::new(&args[1])) {
            Ok(result) => println!("{}", serde_json::to_string(&result)?),
            Err(error) => {
                println!("{}", serde_json::json!({"error": error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() == 2 && args[0] == "--publish-source" {
        match source_publish::run(Path::new(&args[1])) {
            Ok(result) => println!("{}", serde_json::to_string(&result)?),
            Err(error) => {
                println!("{}", serde_json::json!({"error": error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() == 2 && args[0] == "--eligible" {
        let mut raw = Vec::new();
        std::io::stdin().take((1 << 20) + 1).read_to_end(&mut raw)?;
        if raw.len() > 1 << 20 {
            return Err("eligibility request exceeds 1 MiB".into());
        }
        let input = serde_json::from_slice(&raw)?;
        let result = file_eligibility::check(Path::new(&args[1]), input)?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    if args.len() == 1 && args[0] == "--engine" {
        let mut raw = Vec::new();
        std::io::stdin().take((1 << 20) + 1).read_to_end(&mut raw)?;
        let result = if raw.len() > 1 << 20 {
            Err(workspace_engine::Failure::new(
                "invalid_request",
                "engine request exceeds 1 MiB",
            ))
        } else {
            workspace_engine::run(&raw)
        };
        match result {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() == 1 && args[0] == "--local" {
        let mut raw = Vec::new();
        std::io::stdin().take((2 << 20) + 1).read_to_end(&mut raw)?;
        let result = if raw.len() > 2 << 20 {
            Err(workspace_engine::Failure::new(
                "invalid_request",
                "coding request exceeds 2 MiB",
            ))
        } else {
            workspace_local::run(&raw)
        };
        match result {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if (args.len() == 4 || args.len() == 3) && args[0] == "--projections" {
        let repo = Path::new(&args[1]);
        let workspace = args[2].to_str().ok_or("workspace ID must be UTF-8")?;
        let after = if args.len() == 4 {
            args[3].to_str().ok_or("cursor must be UTF-8")?
        } else {
            ""
        };
        match workspace_projections::run(repo, workspace, after) {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() == 8 && args[0] == "--head-projections" {
        let repo = Path::new(&args[1]);
        let values: Vec<_> = args[2..]
            .iter()
            .map(|arg| arg.to_str().ok_or("head report argument must be UTF-8"))
            .collect::<Result<_, _>>()?;
        let ahead: u32 = values[4].parse()?;
        let behind: u32 = values[5].parse()?;
        let projection = workspace_projections::run(repo, values[0], values[1]);
        match projection {
            Ok(value) => {
                println!("{}", value["cursor"].as_str().unwrap_or(""));
                println!("{}", if value["more"] == true { "yes" } else { "no" });
                println!(
                    "{}",
                    serde_json::json!({"change_id":values[2], "commit_id":values[3],
                    "ahead":ahead, "behind":behind, "coding_operations":value["coding_operations"]})
                );
            }
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() != 3 {
        return Err(USAGE.into());
    }
    let commit = args[1].to_str().ok_or("commit ID must be UTF-8")?;
    let result = smithers_ffi::tree_export::export_commit_tree(
        Path::new(&args[0]),
        commit,
        Path::new(&args[2]),
    )?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

// Process handles pin the kernel object while its identity is inspected. This
// observation is read-only; an unreadable object never becomes a dead process.
#[cfg(windows)]
mod windows_process {
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{
        ERROR_INVALID_PARAMETER, FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    pub(super) fn started_at_ms(pid: u32) -> io::Result<Option<u64>> {
        if pid <= 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "reserved process ID",
            ));
        }
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => return Ok(None),
            WAIT_TIMEOUT => {}
            _ => return Err(io::Error::last_os_error()),
        }
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        if unsafe {
            GetProcessTimes(
                handle.as_raw_handle(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        let unix_ticks = ticks.checked_sub(116_444_736_000_000_000).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "process creation time precedes Unix epoch",
            )
        })?;
        Ok(Some(unix_ticks / 10_000))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::process::{Child, Command, Stdio};
        use std::time::{SystemTime, UNIX_EPOCH};

        struct OwnedChild(Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        fn now() -> u64 {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        }

        #[test]
        fn observes_live_and_exited_processes_without_signalling_them() {
            let before = now();
            let mut child = OwnedChild(
                Command::new("node")
                    .args(["-e", "setInterval(()=>{},1000)"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let first = started_at_ms(child.0.id()).unwrap().unwrap();
            assert!(first >= before.saturating_sub(1000) && first <= now());
            assert_eq!(started_at_ms(child.0.id()).unwrap(), Some(first));
            assert!(child.0.try_wait().unwrap().is_none());
            child.0.kill().unwrap();
            child.0.wait().unwrap();
            // Child still owns the handle, so the kernel cannot reuse its PID.
            assert_eq!(started_at_ms(child.0.id()).unwrap(), None);
            assert!(started_at_ms(std::process::id()).unwrap().unwrap() <= now());
        }

        #[test]
        fn refuses_reserved_ids_and_observes_a_missing_process() {
            for pid in [0, 1] {
                assert_eq!(
                    started_at_ms(pid).unwrap_err().kind(),
                    io::ErrorKind::InvalidInput
                );
            }
            assert_eq!(started_at_ms(u32::MAX).unwrap(), None);
        }
    }
}

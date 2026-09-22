use std::io::Read as _;
use std::path::Path;

mod file_eligibility;
mod source_create;
mod source_publish;
mod workspace_engine;
mod workspace_files;
mod workspace_local;

const USAGE: &str = "usage: smithers-jj-export <repository-root> <full-commit-id> <output-parent>";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
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

---
"@smthrs/migrate": minor
"@smthrs/platform-node": minor
"@smthrs/cli": patch
---

`migrate --apply` runs every verification command (install, format, typecheck, tests) in the host's process sandbox: bubblewrap on Linux, seatbelt on macOS. The rewrite agent edits `package.json`, tests, and tool configuration, so those commands execute text the agent wrote; they used to run with the operator's privileges and environment. A command now gets the project, the toolchain on the operator's `PATH`, a private home, and a bootstrap environment. Dotenv files (`.env*`) are hidden from it.

New default: on a host with no sandbox (Windows, Linux without `bwrap`), `--apply` refuses with `no-sandbox` and exit 1 before any unit runs. `--verify-unconfined` is the explicit opt-out and prints a warning. `--verify-read <path>` opens one more path to the sandbox.

`@smthrs/platform-node`'s `ProcessConfinement` gains the `verification` option that implements this, with `ProcessSandbox.toolchainReads` and `ProcessSandbox.hiddenEntries`.

A verification command that creates `.git` or `.jj` in a project that had none fails the verification and the host removes it. Checkpoint `git` commands start no hook and no filesystem monitor.

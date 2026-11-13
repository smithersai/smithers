import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"

/** A Rust string literal that never interprets fixture text as source code. */
const literal = (text: string): string => {
  let hashes = "#"
  while (text.includes(`"${hashes}`)) hashes += "#"
  return `r${hashes}"${text}"${hashes}`
}

/** MSYS sh does not decode Microsoft CRT quoting. Transfer arguments as data. */
const shellArguments = `#!/bin/sh
set --
SMTHRS_FIXTURE_I=0
while [ "$SMTHRS_FIXTURE_I" -lt "$SMTHRS_FIXTURE_ARGC" ]; do
  SMTHRS_FIXTURE_NAME="SMTHRS_FIXTURE_ARG_$SMTHRS_FIXTURE_I"
  set -- "$@" "\${!SMTHRS_FIXTURE_NAME}"
  unset "$SMTHRS_FIXTURE_NAME"
  SMTHRS_FIXTURE_I=$((SMTHRS_FIXTURE_I + 1))
done
unset SMTHRS_FIXTURE_I SMTHRS_FIXTURE_NAME SMTHRS_FIXTURE_ARGC
`

/**
 * Writes an actual executable fixture. Windows cannot execute shebang scripts;
 * its native dispatcher retains literal argv, inherited pipes, and exit status.
 * Rust is already required by this repository's Windows native test lane.
 */
export const writeExecutable = async (
  path: string,
  source: string,
  platform: NodeJS.Platform = process.platform,
  nodeInterpreter = process.execPath
): Promise<string> => {
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, source, { mode: 0o755 })
  if (platform !== "win32") return path
  const shell = source.startsWith("#!/bin/sh\n")
  if (!shell && !source.startsWith("#!/usr/bin/env node\n")) throw new Error("Unknown fixture interpreter")
  // The Windows interpreter is Git's Bash running as sh. Use Bash when this
  // transport is exercised on a POSIX host, whose /bin/sh may instead be dash.
  const interpreter = shell ? process.platform === "win32" ? "sh" : "bash" : nodeInterpreter
  const programSource = shell ? shellArguments + source.slice(source.indexOf("\n") + 1) : source
  await Fs.writeFile(path, programSource, { mode: 0o755 })
  const executable = `${path}.exe`
  const code = `use std::{env, fs, process::{Command, exit}};
fn take_input() -> std::process::Stdio {
  // Own the input handle so dropping Command after spawn releases the parent's
  // reader. Windows also has a CRT descriptor, which may be a distinct handle.
  #[cfg(unix)] {
    use std::os::fd::FromRawFd;
    unsafe { std::process::Stdio::from(fs::File::from_raw_fd(0)) }
  }
  #[cfg(windows)] {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    extern "C" { fn _get_osfhandle(fd: i32) -> isize; fn _close(fd: i32) -> i32; }
    #[link(name="kernel32")] extern "system" {
      fn SetHandleInformation(handle: RawHandle, mask: u32, flags: u32) -> i32;
    }
    let standard = std::io::stdin().as_raw_handle();
    let descriptor = unsafe { _get_osfhandle(0) };
    let handle = if !standard.is_null() && standard as isize != -1 { standard }
      else if descriptor != -1 && descriptor != -2 { descriptor as RawHandle }
      else { return std::process::Stdio::null(); };
    if descriptor != -1 && descriptor != -2 && descriptor != handle as isize { unsafe { _close(0); } }
    // Only Command's selected duplicate may be inherited, not the original.
    assert_ne!(unsafe { SetHandleInformation(handle, 1, 0) }, 0);
    unsafe { std::process::Stdio::from(fs::File::from_raw_handle(handle)) }
  }
}
fn main() {
  if fs::read_to_string(${literal(path)}).ok().as_deref() != Some(${literal(programSource)}) {
    eprintln!("fixture source changed without recompilation"); exit(95);
  }
  let mut command = Command::new(${literal(interpreter)});
  command.arg(${literal(path)});
  if ${shell} {
    let args: Vec<_> = env::args_os().skip(1).collect();
    command.env("SMTHRS_FIXTURE_ARGC", args.len().to_string());
    for (index, value) in args.iter().enumerate() {
      command.env(format!("SMTHRS_FIXTURE_ARG_{}", index), value);
    }
  } else {
    command.args(env::args_os().skip(1));
  }
  command.stdin(take_input());
  let status = match command.spawn() {
    Ok(mut child) => { drop(command); child.wait() },
    Err(error) => Err(error)
  };
  match status { Ok(status) => exit(status.code().unwrap_or(1)), Err(error) => { eprintln!("{}", error); exit(96); } }
}
`
  return writeNativeExecutable(executable, code)
}

/** Compiles a real native fixture with no interpreter or dispatcher process. */
export const writeNativeExecutable = async (path: string, code: string): Promise<string> => {
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-native-fixture-"))
  try {
    const program = Path.join(directory, "fixture.rs")
    await Fs.writeFile(program, code)
    await promisify(execFile)("rustc", ["--edition=2021", "--crate-name=fixture_cli", program, "-o", path])
    return path
  } finally {
    await Fs.rm(directory, { recursive: true, force: true })
  }
}

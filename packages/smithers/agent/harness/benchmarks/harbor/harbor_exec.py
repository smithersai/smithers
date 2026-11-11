#!/usr/bin/env python3
"""A `docker` that reaches the task through the runner's own environment.

The harness's `bash` and file flows deliver every containerised command as
`docker exec [-i] [-w cwd] [-e KEY]... -- <container> <file> <args…>`
(`packages/smithers/agent/std/src/Container.ts`). That reaches a task only
when the task is a container on this host's Docker daemon. Harbor also runs
tasks on Runta, Daytona, Modal, E2B and the rest, and each of them is reached
the same way by every agent: `environment.exec(command, cwd, env)`.

This file is both halves of that route:

- `Bridge` runs inside the runner's process. It listens on a Unix socket and
  answers each request by awaiting `environment.exec`, so a command takes
  whatever route the environment takes (a Runta runtime, a container inside
  one, a compose service) and gets the task's own environment variables and
  default user, exactly as a stock agent's commands do.
- Run as `docker` (a link to this file, first on the CLI's PATH), it parses
  the `docker exec` argv, forwards it and the standard input over the socket,
  replays stdout and stderr, and exits with the command's status. Any other
  docker verb is refused with exit 125.

The socket's path and the one container name the link answers for are in
`harbor-exec.json` beside the link, never in the ambient environment: the
harness spawns this program with a least-authority environment (PATH, HOME,
USER, LANG, TERM, TMPDIR, SHELL; `flows/kernel/src/ChildProcessEnvironment.ts`).

Standard input has no parameter in `environment.exec`. Up to `INLINE_STDIN`
bytes travel in the command as base64 and are decoded in the task by
`base64 -d`; anything larger is uploaded to a temporary file with
`environment.upload_file`, redirected in and removed. One Linux argument holds
131,072 bytes, so the inline limit keeps the whole command under that.

A shim the harness kills (its own ceiling, a frame's clock, a stopped run)
gives up on the call, and cancelling the coroutine awaiting `environment.exec`
does not stop the command in the task. So each command records its process id
in a per-call file in the task's `/tmp`, removed when it ends, and a cancelled
call is followed by one more `environment.exec` that sends that process `TERM`,
gives it `STOP_GRACE_SEC` to go, then sends `KILL`. The harness's `bash`
wrapper (`TreeFingerprint.around`) answers `TERM` by stopping its command's
whole process group. That follow-up is best effort: bounded by
`STOP_TIMEOUT_SEC`, and its failure is never the bridge's.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import sys
from pathlib import Path
from typing import Any

if __name__ != "__main__":
    # The bridge's half. The shim starts once per command, and on a loaded
    # host each of these imports is time every command waits.
    import asyncio
    import contextlib
    import shlex
    import shutil
    import tempfile
    import time
    import uuid

CONFIG_NAME = "harbor-exec.json"
SHIM = Path(__file__).resolve()
# Raw bytes of standard input sent inside the command. Base64 grows them by a
# third, and the command is one argument to `bash -c`, at most 131,072 bytes.
INLINE_STDIN = 48_000
# The harness kills this program at its own per-call ceiling; the remote
# command is given a little longer so the harness's timeout is the one read.
DEFAULT_TIMEOUT_SEC = 3_600
# How much of each argument a logged request keeps.
ARGUMENT_HEAD = 400
# How long a cancelled command has between TERM and KILL. The harness's `bash`
# wrapper spends two seconds stopping its own command's process group first.
STOP_GRACE_SEC = 4
# The most the follow-up that stops a cancelled command may take.
STOP_TIMEOUT_SEC = 30
# Run in the task in front of a command: write this shell's process id to the
# file named by $0, then become the command, so the id is the command's.
RECORD = '{ printf %s "$$" > "$0"; } 2>/dev/null; exec "$@"'
# Run in the task after a cancelled call: TERM the process the file names, wait
# for it, KILL it if it is still there, and remove the file.
STOP = ('p=$(cat "$1" 2>/dev/null) || exit 0; kill -TERM "$p" 2>/dev/null; i=0; '
        'while [ "$i" -lt "$2" ] && kill -0 "$p" 2>/dev/null; do sleep 1; i=$((i + 1)); done; '
        'kill -KILL "$p" 2>/dev/null; rm -f "$1"')
_HEADER = struct.Struct(">I")


def parse_exec(argv: list[str], environ: dict[str, str]) -> dict[str, Any]:
    """`docker exec …` argv as a request: container, program, cwd, env, stdin."""
    if not argv or argv[0] != "exec":
        raise ValueError(f"harbor docker shim serves `docker exec` only, got: {argv[:1]}")
    rest = argv[1:]
    stdin = False
    cwd: str | None = None
    env: dict[str, str] = {}
    index = 0
    while index < len(rest):
        token = rest[index]
        if token == "--":
            index += 1
            break
        if token == "-i":
            stdin = True
        elif token == "-w":
            index += 1
            cwd = rest[index]
        elif token == "-e":
            index += 1
            key = rest[index]
            if "=" in key:
                name, value = key.split("=", 1)
                env[name] = value
            elif key in environ:
                env[key] = environ[key]
        elif token.startswith("-"):
            raise ValueError(f"harbor docker shim: unsupported docker exec flag {token}")
        else:
            break
        index += 1
    command = rest[index:]
    if len(command) < 2:
        raise ValueError("harbor docker shim: expected <container> <file> [args…]")
    return {"container": command[0], "argv": command[1:], "cwd": cwd, "env": env, "stdin": stdin}


def shim_directory(directory: Path, socket_path: Path, container: str) -> Path:
    """A directory whose `docker` is this file, to go first on PATH, with the
    socket and the container name beside it. Delete it when the run ends."""
    directory = directory / "bin"
    directory.mkdir(parents=True, exist_ok=True)
    link = directory / "docker"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(SHIM)
    SHIM.chmod(SHIM.stat().st_mode | 0o111)
    target = directory / CONFIG_NAME
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({"socket": str(socket_path), "container": container}, handle)
    return directory


def load_config(invoked: str) -> dict[str, Any]:
    """The per-trial configuration beside the `docker` link that was run."""
    path = Path(os.path.abspath(invoked)).parent / CONFIG_NAME
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"harbor docker shim: no readable {path}: {error}") from error
    if not isinstance(config, dict) or not config.get("socket") or not config.get("container"):
        raise ValueError(f"harbor docker shim: {path} names no socket and container")
    return config


def _pack(document: dict[str, Any]) -> bytes:
    body = json.dumps(document).encode("utf-8")
    return _HEADER.pack(len(body)) + body


def _receive(connection: socket.socket, size: int) -> bytes:
    chunks = []
    while size > 0:
        chunk = connection.recv(min(size, 1 << 20))
        if not chunk:
            raise ConnectionError("harbor docker shim: the bridge closed the connection")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def main(argv: list[str]) -> int:
    try:
        config = load_config(sys.argv[0])
        request = parse_exec(argv, dict(os.environ))
    except ValueError as error:
        sys.stderr.write(f"{error}\n")
        return 125
    if request["container"] != config["container"]:
        sys.stderr.write(f"harbor docker shim: this run reaches {config['container']!r} only, "
                         f"not {request['container']!r}\n")
        return 125
    payload = sys.stdin.buffer.read() if request.pop("stdin") else None
    request["stdin"] = None if payload is None else base64.b64encode(payload).decode("ascii")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(config["socket"])
            connection.sendall(_pack(request))
            (size,) = _HEADER.unpack(_receive(connection, _HEADER.size))
            answer = json.loads(_receive(connection, size))
    except (OSError, ValueError) as error:
        sys.stderr.write(f"harbor docker shim: bridge unreachable: {error}\n")
        return 126
    if "error" in answer:
        sys.stderr.write(f"harbor exec failed: {answer['error']}\n")
        return 126
    sys.stdout.write(answer.get("stdout") or "")
    sys.stderr.write(answer.get("stderr") or "")
    sys.stdout.flush()
    sys.stderr.flush()
    return int(answer.get("code", 126))


def command_line(argv: list[str], stdin: bytes | None, pidfile: str, remote_stdin: str | None = None) -> str:
    """The one Bash line that runs `argv` in the task, with standard input
    decoded inline, redirected from an uploaded file (removed afterwards), or
    closed. The program's process id is in `pidfile` while it runs (see
    `stop_line`), and the program's status is the line's."""
    recorded = f"sh -c {shlex.quote(RECORD)} {shlex.quote(pidfile)} {shlex.join(argv)}"
    removed = [shlex.quote(pidfile)]
    if remote_stdin is not None:
        removed.insert(0, shlex.quote(remote_stdin))
        run = f"{recorded} < {removed[0]}"
    elif stdin is None:
        run = f"{recorded} < /dev/null"
    else:
        encoded = base64.b64encode(stdin).decode("ascii")
        run = f"printf %s {shlex.quote(encoded)} | base64 -d | {recorded}"
    return f"{run}; code=$?; rm -f {' '.join(removed)}; exit $code"


def stop_line(pidfile: str) -> str:
    """The Bash line that stops the command `command_line` recorded in `pidfile`."""
    return f"sh -c {shlex.quote(STOP)} sh {shlex.quote(pidfile)} {STOP_GRACE_SEC}"


class Bridge:
    """Serves `docker exec` requests from the shim with `environment.exec`.

    One per trial, inside the runner's process and event loop:

        async with Bridge(environment, container) as bridge:
            env["PATH"] = f"{bridge.bin}{os.pathsep}{env['PATH']}"

    `calls` counts the requests answered and `failures` the ones the
    environment raised on, for the trial's record. With `log`, every request
    is also one JSON line there: when it ended, how long the environment took,
    the exit status, the byte counts and the head of each argument. Standard
    input and environment values are never written.
    """

    def __init__(self, environment: Any, container: str, timeout_sec: int = DEFAULT_TIMEOUT_SEC,
                 log: Path | None = None) -> None:
        self.environment = environment
        self.container = container
        self.timeout_sec = timeout_sec
        self.log = log
        self.calls = 0
        self.failures = 0
        self.exec_ms = 0
        self._home: Path | None = None
        self._server: asyncio.AbstractServer | None = None
        self.bin: Path | None = None

    async def __aenter__(self) -> "Bridge":
        # A Unix socket path holds about 100 bytes; the default temporary
        # directory on macOS is half of that already.
        self._home = Path(tempfile.mkdtemp(prefix="sb-", dir="/tmp"))
        path = self._home / "s"
        self._server = await asyncio.start_unix_server(self._serve, path=str(path))
        os.chmod(path, 0o600)
        self.bin = shim_directory(self._home, path, self.container)
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
        if self._home is not None:
            shutil.rmtree(self._home, ignore_errors=True)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            (size,) = _HEADER.unpack(await reader.readexactly(_HEADER.size))
            request = json.loads(await reader.readexactly(size))
            # The shim sends nothing more: a read that returns is the harness
            # killing it, and the remote call is dropped and its command stopped.
            pidfile = f"/tmp/.smithers-exec-{uuid.uuid4().hex}.pid"
            work = asyncio.ensure_future(self.run(request, pidfile))
            gone = asyncio.ensure_future(reader.read(1))
            await asyncio.wait({work, gone}, return_when=asyncio.FIRST_COMPLETED)
            if not work.done():
                work.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await work
                await self.stop(pidfile)
                return
            gone.cancel()
            writer.write(_pack(work.result()))
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, ValueError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def stop(self, pidfile: str) -> None:
        """Stops the command a cancelled call recorded in `pidfile`. Best
        effort: a stop that fails or outlasts `STOP_TIMEOUT_SEC` is dropped."""
        with contextlib.suppress(Exception):
            await asyncio.wait_for(
                self.environment.exec(stop_line(pidfile), timeout_sec=STOP_TIMEOUT_SEC), STOP_TIMEOUT_SEC)

    async def run(self, request: dict[str, Any], pidfile: str) -> dict[str, Any]:
        """One request to one `environment.exec`, as the shim's answer."""
        self.calls += 1
        loop = asyncio.get_running_loop()
        started = loop.time()
        answer: dict[str, Any] = {"error": "cancelled"}
        argv: list[str] = []
        stdin: bytes | None = None
        try:
            argv = [str(part) for part in request["argv"]]
            stdin = None if request.get("stdin") is None else base64.b64decode(request["stdin"])
            remote = None
            if stdin is not None and len(stdin) > INLINE_STDIN:
                remote = f"/tmp/.smithers-stdin-{uuid.uuid4().hex}"
                with tempfile.NamedTemporaryFile(prefix="smithers-stdin-", delete=False) as handle:
                    handle.write(stdin)
                try:
                    await self.environment.upload_file(handle.name, remote)
                finally:
                    os.unlink(handle.name)
            result = await self.environment.exec(
                command_line(argv, stdin, pidfile, remote),
                cwd=request.get("cwd") or None,
                env=request.get("env") or None,
                timeout_sec=self.timeout_sec,
            )
            answer = {"code": int(result.return_code), "stdout": result.stdout or "", "stderr": result.stderr or ""}
            return answer
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - every transport failure is the shim's exit 126
            self.failures += 1
            answer = {"error": f"{type(error).__name__}: {str(error)[:500]}"}
            return answer
        finally:
            elapsed = int((loop.time() - started) * 1000)
            self.exec_ms += elapsed
            self._record(request, argv, stdin, answer, elapsed)

    def _record(self, request: dict[str, Any], argv: list[str], stdin: bytes | None, answer: dict[str, Any],
                elapsed: int) -> None:
        if self.log is None:
            return
        line = {
            "endedAt": round(time.time(), 3),
            "ms": elapsed,
            "code": answer.get("code"),
            "error": answer.get("error"),
            "cwd": request.get("cwd"),
            "env": sorted(request.get("env") or {}),
            "stdinBytes": None if stdin is None else len(stdin),
            "stdoutBytes": len((answer.get("stdout") or "").encode("utf-8", "replace")),
            "stderrBytes": len((answer.get("stderr") or "").encode("utf-8", "replace")),
            "argv": [part if len(part) <= ARGUMENT_HEAD else f"{part[:ARGUMENT_HEAD]}… [{len(part)} chars]"
                     for part in argv],
        }
        with contextlib.suppress(OSError), self.log.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""A `docker` that reaches a Smithers Cloud workspace.

The harness's `bash` flow delivers every containerised command as
`docker exec [-i] [-w cwd] [-e KEY]... -- <container> <file> <args…>`
(`packages/smithers/agent/std/src/Container.ts`). On plue the "container" is
a workspace id, so `smithers_agent.py` puts this file first on the CLI's PATH
under the name `docker` and every exec becomes one public CLI call:

    <cli> workspace exec <id> --repo <repo> --user root [--cwd …]
        [--env KEY=VALUE …] --timeout 0 --format json --command 'exec <file> <args…>'

Standard input is forwarded when `-i` was asked for, the command's stdout and
stderr are replayed, and its exit code is this process's. An exec without
stdin carries a durable `--exec-id` (plue CLI 71c3ed6a+): when OpenSSH or the
gateway loses the transport, the same id is reattached, so the command is
neither lost nor run twice. An exec with stdin stays one connection. Without
`-w` the command runs in `workdir` from the config (the image's WORKDIR). Any other docker
verb is refused with exit 125: nothing but exec is expected here.

Configuration comes from `plue-docker.json` beside the invoked `docker` link,
written per trial by `smithers_agent.shim_config`: `repo` (owner/name), `cli`
(absolute path of the plue CLI) and `env` (what that CLI needs, such as
SMITHERS_TOKEN and XDG_CONFIG_HOME). Never from the ambient environment: the
harness spawns this shim with a least-authority environment (PATH, HOME, USER,
LANG, TERM, TMPDIR, SHELL; `flows/kernel/src/ChildProcessEnvironment.ts`), so
PLUE_REPO and SMITHERS_CLI never arrive, and `smithers` on PATH is the flows
CLI, not the plue one. The ambient environment is read only for the `-e KEY`
values the harness forwards on purpose.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import outcome  # noqa: E402
import plue_env  # noqa: E402

CONFIG_NAME = "plue-docker.json"

# Same as plue_env.EGRESS_PREFIX: the SSH session does not carry the
# sandbox's egress proxy, so the command sources it first when it is there.
EGRESS_ENV = "/etc/smithers/egress.env"
EGRESS_PREFIX = f"if [ -r {EGRESS_ENV} ]; then set -a; . {EGRESS_ENV}; set +a; fi; "


def load_config(invoked: str) -> dict:
    """The per-trial configuration beside the `docker` link that was run.

    `invoked` is the path this process was started as (`sys.argv[0]`), not its
    symlink target, so each trial's shim directory carries its own file."""
    path = Path(os.path.abspath(invoked)).parent / CONFIG_NAME
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"plue docker shim: no readable {path}: {error}") from error
    if not isinstance(config, dict):
        raise ValueError(f"plue docker shim: {path} is not an object")
    return config


def translate(argv: list[str], environ: dict[str, str], config: dict) -> tuple[list[str], bool]:
    """`docker exec …` argv to the plue CLI argv, and whether stdin is forwarded."""
    if not argv or argv[0] != "exec":
        raise ValueError(f"plue docker shim serves `docker exec` only, got: {argv[:1]}")
    rest = argv[1:]
    stdin = False
    cwd: str | None = None
    env: list[str] = []
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
                env.append(key)
            elif key in environ:
                env.append(f"{key}={environ[key]}")
        elif token.startswith("-"):
            raise ValueError(f"plue docker shim: unsupported docker exec flag {token}")
        else:
            break
        index += 1
    command = rest[index:]
    if len(command) < 2:
        raise ValueError("plue docker shim: expected <container> <file> [args…]")
    container, program = command[0], command[1:]
    repo = str(config.get("repo") or "").strip()
    if "/" not in repo:
        raise ValueError("plue docker shim: config `repo` must be owner/name")
    cli = str(config.get("cli") or "")
    if not os.path.isabs(cli) or not os.access(cli, os.X_OK):
        raise ValueError(f"plue docker shim: config `cli` must be an executable absolute path, got {cli!r}")
    args = [
        cli,
        "workspace", "exec", container, "--repo", repo, "--user", "root",
        "--timeout", "0", "--format", "json",
    ]
    cwd = cwd or config.get("workdir") or None
    if cwd is not None:
        args += ["--cwd", cwd]
    for pair in env:
        args += ["--env", pair]
    args += ["--command", EGRESS_PREFIX + "exec " + shlex.join(program)]
    return args, stdin


def envelope(stdout: str) -> dict:
    text = stdout.strip()
    start = text.find("{")
    return json.loads(text[start:]) if start >= 0 else {}


def main(argv: list[str]) -> int:
    try:
        config = load_config(sys.argv[0])
        args, stdin = translate(argv, dict(os.environ), config)
    except ValueError as error:
        sys.stderr.write(f"{error}\n")
        return 125
    extra = config.get("env") or {}
    waits: list = [None]
    if not stdin:
        args = args[:-2] + ["--exec-id", f"shim-{uuid.uuid4().hex[:16]}"] + args[-2:]
        waits = [*config.get("reattach_backoff_sec", plue_env._EXEC_REATTACH_BACKOFF_SEC), None]
    for wait in waits:
        result = subprocess.run(
            args,
            stdin=None if stdin else subprocess.DEVNULL,
            capture_output=True,
            env={**os.environ, **{str(k): str(v) for k, v in extra.items()}},
        )
        try:
            data = envelope(result.stdout.decode(errors="replace"))
        except ValueError:
            data = {}
        payload = data.get("data", data) if isinstance(data, dict) else {}
        stderr = (payload.get("stderr") or "") + "\n" + result.stderr.decode(errors="replace")
        lost = None
        if "error" in data and "exit_code" not in payload:
            error = data["error"]
            lost = plue_env.PlueError(error.get("message", ""), error.get("code", ""))
            if wait is None or not plue_env.reattachable(lost):
                sys.stderr.write(f"plue exec failed: {error.get('code', '')} {error.get('message', '')}\n")
                return 126
        elif int(payload.get("exit_code", result.returncode)) == 255 and outcome.ssh_transport_error(stderr):
            if wait is None:
                sys.stderr.write(stderr.strip() + "\n")
                return 255
            lost = True
        if lost is not None:
            time.sleep(wait)
            continue
        if not payload and result.returncode != 0:
            sys.stderr.write(result.stderr.decode(errors="replace"))
            return result.returncode or 126
        sys.stdout.write(payload.get("stdout") or "")
        sys.stderr.write(payload.get("stderr") or "")
        sys.stdout.flush()
        sys.stderr.flush()
        return int(payload.get("exit_code", result.returncode))
    return 255


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""A `docker` that reaches a Smithers Cloud workspace.

The harness's `bash` flow delivers every containerised command as
`docker exec [-i] [-w cwd] [-e KEY]... -- <container> <file> <args…>`
(`packages/smithers/agent/std/src/Container.ts`). On plue the "container" is
a workspace id, so `smithers_agent.py` puts this file first on the CLI's PATH
under the name `docker` and every exec becomes one public CLI call:

    smithers workspace exec <id> --repo $PLUE_REPO --user root [--cwd …]
        [--env KEY=VALUE …] --timeout 0 --format json --command 'exec <file> <args…>'

Standard input is forwarded when `-i` was asked for, the command's stdout and
stderr are replayed, and its exit code is this process's. Any other docker
verb is refused with exit 125: nothing but exec is expected here.

Environment: SMITHERS_CLI (the plue CLI), PLUE_REPO (owner/name), and whatever
the CLI itself needs (SMITHERS_TOKEN, XDG_CONFIG_HOME).
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys

# Same as plue_env.EGRESS_PREFIX: the SSH session does not carry the
# sandbox's egress proxy, so the command sources it first when it is there.
EGRESS_ENV = "/etc/smithers/egress.env"
EGRESS_PREFIX = f"if [ -r {EGRESS_ENV} ]; then set -a; . {EGRESS_ENV}; set +a; fi; "


def translate(argv: list[str], environ: dict[str, str]) -> tuple[list[str], bool]:
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
    repo = environ.get("PLUE_REPO", "").strip()
    if "/" not in repo:
        raise ValueError("PLUE_REPO must be owner/name")
    args = [
        environ.get("SMITHERS_CLI", "smithers"),
        "workspace", "exec", container, "--repo", repo, "--user", "root",
        "--timeout", "0", "--format", "json",
    ]
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
        args, stdin = translate(argv, dict(os.environ))
    except ValueError as error:
        sys.stderr.write(f"{error}\n")
        return 125
    result = subprocess.run(
        args,
        stdin=None if stdin else subprocess.DEVNULL,
        capture_output=True,
    )
    try:
        data = envelope(result.stdout.decode(errors="replace"))
    except ValueError:
        data = {}
    if "error" in data and "exit_code" not in data.get("data", data):
        error = data["error"]
        sys.stderr.write(f"plue exec failed: {error.get('code', '')} {error.get('message', '')}\n")
        return 126
    payload = data.get("data", data)
    if not payload and result.returncode != 0:
        sys.stderr.write(result.stderr.decode(errors="replace"))
        return result.returncode or 126
    sys.stdout.write(payload.get("stdout") or "")
    sys.stderr.write(payload.get("stderr") or "")
    sys.stdout.flush()
    sys.stderr.flush()
    return int(payload.get("exit_code", result.returncode))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

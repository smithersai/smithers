#!/usr/bin/env python3
"""Pins `harbor_exec.py`: the `docker exec` argv the harness spawns reaches
`environment.exec` whole, with its standard input, working directory,
environment and exit status, and nothing but the trial's one container.

The environment here runs each command with a real `bash -c` in a scratch
directory, which is what every Harbor environment does with the string it is
handed; the shim is run as a real `docker` process through its link.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import harbor_exec  # noqa: E402


class LocalEnvironment:
    """`environment.exec` as a runner gives it: one Bash line, a cwd, an env."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.commands: list[str] = []
        self.uploads: list[str] = []
        self.fail = False

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        if self.fail:
            raise RuntimeError("runtime gone")
        self.commands.append(command)
        # HOME is the scratch root, so a login shell reads no profile of this host's.
        child = await asyncio.create_subprocess_exec(
            "bash", "-c", command, cwd=cwd or str(self.root),
            env={"PATH": os.environ["PATH"], "HOME": str(self.root), **(env or {})},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = await child.communicate()
        return SimpleNamespace(stdout=stdout.decode(), stderr=stderr.decode(), return_code=child.returncode)

    async def upload_file(self, source, target):
        self.uploads.append(target)
        shutil.copy(source, target)


def check_parse() -> None:
    request = harbor_exec.parse_exec(
        ["exec", "-i", "-w", "/app", "-e", "SMITHERS_CONTAINER_ENV_A", "-e", "B=2", "--", "task-1", "bash", "-lc", "ls"],
        {"SMITHERS_CONTAINER_ENV_A": "1", "UNRELATED": "x"})
    assert request == {"container": "task-1", "argv": ["bash", "-lc", "ls"], "cwd": "/app",
                       "env": {"SMITHERS_CONTAINER_ENV_A": "1", "B": "2"}, "stdin": True}, request
    bare = harbor_exec.parse_exec(["exec", "--", "task-1", "true"], {})
    assert bare["stdin"] is False and bare["cwd"] is None and bare["env"] == {}
    for bad in (["run", "task-1", "true"], ["exec", "--privileged", "--", "task-1", "true"], ["exec", "--", "task-1"]):
        try:
            harbor_exec.parse_exec(bad, {})
        except ValueError:
            continue
        raise AssertionError(f"{bad} is refused")


def check_command_line() -> None:
    assert harbor_exec.command_line(["bash", "-lc", "echo 'a b'"], None) == "exec bash -lc 'echo '\"'\"'a b'\"'\"'' < /dev/null"
    inline = harbor_exec.command_line(["cat"], b"hi\x00there")
    assert inline == "printf %s aGkAdGhlcmU= | base64 -d | cat", inline
    remote = harbor_exec.command_line(["cat"], b"x", "/tmp/in put")
    assert remote == "cat < '/tmp/in put'; code=$?; rm -f '/tmp/in put'; exit $code", remote


async def docker(bridge: harbor_exec.Bridge, *argv: str, stdin: bytes | None = None, env: dict | None = None):
    """The shim as the harness spawns it: a `docker` on PATH with a
    least-authority environment plus the variables it forwards."""
    child = await asyncio.create_subprocess_exec(
        str(bridge.bin / "docker"), *argv,
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/"), **(env or {})})
    stdout, stderr = await child.communicate(stdin)
    return child.returncode, stdout.decode(), stderr.decode()


async def check_bridge() -> None:
    root = Path(tempfile.mkdtemp(prefix="harbor-exec-fixture-")).resolve()
    try:
        environment = LocalEnvironment(root)
        log = root / "bridge.jsonl"
        async with harbor_exec.Bridge(environment, "task-1", log=log) as bridge:
            assert len(str(bridge.bin.parent / "s")) < 100, "the socket path fits a Unix socket address"
            assert (bridge.bin / harbor_exec.CONFIG_NAME).stat().st_mode & 0o077 == 0, "the config is owner-only"

            code, out, err = await docker(bridge, "exec", "--", "task-1", "bash", "-lc", "pwd; echo err >&2; exit 7")
            assert (code, out.strip(), err.strip()) == (7, str(root), "err"), (code, out, err)

            sub = root / "sub dir"
            sub.mkdir()
            code, out, _ = await docker(bridge, "exec", "-w", str(sub), "--", "task-1", "bash", "-lc", "pwd")
            assert (code, out.strip()) == (0, str(sub)), "the cwd is the request's, spaces and all"

            # Standard input arrives byte for byte, and a command that reads none sees end of input.
            payload = "print(open(0).read()[::-1])\n# \"quotes\" $HOME `ticks` \\ and 'more'\n"
            code, out, _ = await docker(bridge, "exec", "-i", "--", "task-1", "bash", "-lc", 'exec "$@"', "bash", "cat",
                                        stdin=payload.encode())
            assert (code, out) == (0, payload), out
            code, out, _ = await docker(bridge, "exec", "--", "task-1", "bash", "-lc", "cat; echo done")
            assert (code, out) == (0, "done\n"), "no -i: standard input is closed, never the runner's"

            # The harness forwards env under its prefix and renames it in the task.
            code, out, _ = await docker(
                bridge, "exec", "-e", "SMITHERS_CONTAINER_ENV_GREETING", "--", "task-1", "sh", "-c",
                'GREETING="$SMITHERS_CONTAINER_ENV_GREETING"; export GREETING; exec "$@"', "sh", "bash", "-lc",
                'printf %s "$GREETING"', env={"SMITHERS_CONTAINER_ENV_GREETING": "hi there"})
            assert (code, out) == (0, "hi there"), out

            # Past the inline limit the bytes are uploaded, redirected and removed.
            big = os.urandom(harbor_exec.INLINE_STDIN + 1)
            code, out, _ = await docker(bridge, "exec", "-i", "--", "task-1", "bash", "-lc", "wc -c | tr -d ' '", stdin=big)
            assert (code, out.strip()) == (0, str(len(big))), out
            assert len(environment.uploads) == 1 and not Path(environment.uploads[0]).exists(), "the upload is removed"
            assert all(len(command) < 131_072 for command in environment.commands), "no command outgrows one argument"

            # Another container, or another verb, starts nothing.
            before = len(environment.commands)
            code, _, err = await docker(bridge, "exec", "--", "task-2", "true")
            assert code == 125 and "task-1" in err, err
            code, _, err = await docker(bridge, "run", "--rm", "alpine", "true")
            assert code == 125 and "docker exec" in err, err
            assert len(environment.commands) == before

            # A transport failure is the shim's own exit, never the command's status.
            environment.fail = True
            code, _, err = await docker(bridge, "exec", "--", "task-1", "true")
            assert code == 126 and "runtime gone" in err, (code, err)
            environment.fail = False
            assert bridge.failures == 1 and bridge.calls >= 7

            # The harness kills the shim at its own ceiling; the bridge drops the call and keeps serving.
            child = await asyncio.create_subprocess_exec(
                str(bridge.bin / "docker"), "exec", "--", "task-1", "bash", "-lc", "sleep 30",
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={"PATH": os.environ["PATH"]})
            await asyncio.sleep(0.5)
            child.kill()
            await child.wait()
            code, out, _ = await asyncio.wait_for(docker(bridge, "exec", "--", "task-1", "bash", "-lc", "echo alive"), 10)
            assert (code, out) == (0, "alive\n")
            home = bridge.bin.parent
        assert not home.exists(), "the shim directory is removed with the bridge"
        # One line per request, without standard input or environment values.
        lines = [json.loads(line) for line in log.read_text().splitlines()]
        assert len(lines) == bridge.calls, (len(lines), bridge.calls)
        assert lines[0]["code"] == 7 and lines[0]["argv"][:2] == ["bash", "-lc"] and lines[0]["ms"] >= 0, lines[0]
        text = log.read_text()
        assert "hi there" not in text and "from stdin" not in text and payload[:20] not in text, "no stdin or env value is logged"
        assert any(line["env"] == ["SMITHERS_CONTAINER_ENV_GREETING"] for line in lines), "env names are logged"
        assert any(line["stdinBytes"] == len(big) for line in lines)
        assert any(line["error"] and "runtime gone" in line["error"] for line in lines)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def check_transport_choice() -> None:
    import smithers_agent as agent
    docker_env = SimpleNamespace(type=lambda: SimpleNamespace(value="docker"))
    runta_env = SimpleNamespace(type=lambda: SimpleNamespace(value="runta"))
    assert agent.transport_of(docker_env, None) == "docker"
    assert agent.transport_of(SimpleNamespace(), None) == "docker", "an environment that names no kind is local docker"
    assert agent.transport_of(runta_env, None) == "harbor"
    assert agent.transport_of(docker_env, "harbor") == "harbor", "the operator's choice wins"
    try:
        agent.transport_of(runta_env, "ssh")
    except ValueError:
        pass
    else:
        raise AssertionError("an unknown transport is refused")
    name = agent.harbor_container_name("fix-git__AbC/../x y")
    assert name == "task-fix-git__AbC-..-x-y" and not name.startswith("-"), name


def main() -> None:
    check_parse()
    check_command_line()
    asyncio.run(check_bridge())
    check_transport_choice()
    print("check_harbor_exec.py: the exec bridge carries argv, stdin, cwd, env and exit status to environment.exec, "
          "serves one container, survives a killed shim, and the adapter picks it off this host's daemon.")


if __name__ == "__main__":
    main()

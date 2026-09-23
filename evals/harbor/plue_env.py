"""Smithers Cloud (plue) environments for Harbor and Pier.

Every call goes through the public `smithers` CLI exactly as a user would run
it: `workspace create --image … --cpus … --wait`, `workspace exec --format
json`, `workspace cp`, `workspace delete`. No admin or benchmark-only routes.

Configuration (environment variables of the harness host):

    SMITHERS_TOKEN   personal access token of a normal account (CLI auth)
    PLUE_REPO        owner/name of the repository workspaces are created in
    SMITHERS_CLI     path to the smithers binary (default: "smithers" on PATH)
    PLUE_WAIT_SEC    workspace boot wait (default 900)

Usage:

    harbor run -d terminal-bench/terminal-bench@4.0.0 \
        -e evals.harbor.plue_env:PlueEnvironment --agent oracle -k 1
    pier run -p <task-dir> --environment-import-path evals.harbor.plue_env:PluePierEnvironment

The task image must be a prebuilt OCI image (`docker_image` in task.toml). A
`Dockerfile` is honoured only when it is a single `FROM <image>` plus `COPY`
and `RUN chmod` lines (the DeepSWE verifier shape); plue does not build images.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

_DEFAULT_WAIT_SEC = 900
_DEFAULT_EXEC_TIMEOUT_SEC = 8 * 3600
_DEFAULT_USER = "root"
_DIRS = ("/logs/agent", "/logs/verifier", "/logs/artifacts", "/tests", "/solution")


class PlueError(RuntimeError):
    """A plue CLI call failed. `code` is the CLI's typed error code."""

    def __init__(self, message: str, code: str = "", command: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.command = command or []


class PlueImageError(PlueError):
    """The task environment cannot be expressed as a prebuilt image."""


_COPY_RE = re.compile(r"^\s*COPY\s+(?:--chmod=\S+\s+)?(\S+)\s+(\S+)\s*$", re.I)
_FROM_RE = re.compile(r"^\s*FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$", re.I)
_CHMOD_RE = re.compile(r"^\s*RUN\s+chmod\s+(\S+)\s+(.+?)\s*$", re.I)


def parse_trivial_dockerfile(text: str) -> tuple[str, list[tuple[str, str]], list[tuple[str, str]]]:
    """Return (image, copies, chmods) for a FROM+COPY+RUN chmod Dockerfile.

    Raises PlueImageError for anything plue cannot reproduce without a build.
    """
    image = ""
    copies: list[tuple[str, str]] = []
    chmods: list[tuple[str, str]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if m := _FROM_RE.match(line):
            if image:
                raise PlueImageError("multi-stage Dockerfile needs an image build")
            image = m.group(1)
            continue
        if m := _COPY_RE.match(line):
            copies.append((m.group(1), m.group(2)))
            continue
        if m := _CHMOD_RE.match(line):
            chmods.append((m.group(1), m.group(2)))
            continue
        raise PlueImageError(f"Dockerfile instruction needs an image build: {line}")
    if not image:
        raise PlueImageError("Dockerfile has no FROM")
    return image, copies, chmods


def _sanitize_name(value: str) -> str:
    name = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-")
    return (name or "trial")[:63]


def _envelope(stdout: str) -> dict[str, Any]:
    """The CLI prints one JSON document with --format json; parse it."""
    text = stdout.strip()
    if not text:
        return {}
    start = text.find("{")
    return json.loads(text[start:]) if start >= 0 else {}


class _PlueOps:
    """CLI-backed lifecycle shared by the Harbor and Pier subclasses.

    Subclasses provide: self.environment_dir, self.session_id,
    self.task_env_config (docker_image, cpus, memory_mb, storage_mb, workdir),
    self.logger, self._plue_network() -> (mode, allow), and a result factory
    `_exec_result(stdout, stderr, return_code)`.
    """

    _workspace_id: str = ""
    _plue_image: str = ""
    _plue_copies: list[tuple[str, str]]
    _plue_chmods: list[tuple[str, str]]

    # --- configuration -------------------------------------------------

    @staticmethod
    def _cli() -> str:
        return os.environ.get("SMITHERS_CLI", "smithers")

    @staticmethod
    def _repo() -> str:
        repo = os.environ.get("PLUE_REPO", "").strip()
        if not repo or "/" not in repo:
            raise PlueError("PLUE_REPO must be owner/name")
        return repo

    def _resolve_image(self) -> None:
        image = getattr(self.task_env_config, "docker_image", None)
        self._plue_copies, self._plue_chmods = [], []
        dockerfile = Path(self.environment_dir) / "Dockerfile"
        if image:
            # A published image is the built form of the Dockerfile beside it.
            self._plue_image = image
            return
        if dockerfile.exists():
            self._plue_image, self._plue_copies, self._plue_chmods = parse_trivial_dockerfile(
                dockerfile.read_text()
            )
            return
        raise PlueImageError(
            f"{self.environment_dir} has neither docker_image nor a Dockerfile"
        )

    # --- CLI plumbing ----------------------------------------------------

    async def _run(self, *args: str, stdin: bytes | None = None, timeout: float | None = None,
                   check: bool = True) -> subprocess.CompletedProcess[bytes]:
        command = [self._cli(), *args]
        self.logger.debug("plue: %s", " ".join(shlex.quote(a) for a in command))
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise PlueError(f"timed out after {timeout}s", "timeout", command)
        result = subprocess.CompletedProcess(command, proc.returncode or 0, out, err)
        if check and result.returncode != 0:
            envelope = {}
            try:
                envelope = _envelope(out.decode(errors="replace"))
            except (ValueError, json.JSONDecodeError):
                pass
            error = envelope.get("error") or {}
            raise PlueError(
                error.get("message") or err.decode(errors="replace").strip() or f"exit {result.returncode}",
                error.get("code", ""),
                command,
            )
        return result

    def _ws(self, *args: str) -> list[str]:
        if not self._workspace_id:
            raise PlueError("workspace not started")
        return [self._workspace_id, "--repo", self._repo(), *args]

    # --- lifecycle ---------------------------------------------------------

    async def _plue_start(self) -> None:
        cfg = self.task_env_config
        mode, allow = self._plue_network()
        args = [
            "workspace", "create",
            "--repo", self._repo(),
            "--name", _sanitize_name(self.session_id),
            "--image", self._plue_image,
            "--network", mode,
            "--idle-timeout", "0",
            "--wait", "--wait-timeout", os.environ.get("PLUE_WAIT_SEC", str(_DEFAULT_WAIT_SEC)),
            "--format", "json",
        ]
        if getattr(cfg, "cpus", None):
            args += ["--cpus", str(cfg.cpus)]
        if getattr(cfg, "memory_mb", None):
            args += ["--memory", str(cfg.memory_mb)]
        if getattr(cfg, "storage_mb", None):
            args += ["--disk", str(cfg.storage_mb)]
        for host in allow:
            args += ["--allow", host]
        try:
            result = await self._run(*args, timeout=_DEFAULT_WAIT_SEC + 120)
        except PlueError:
            # `create --wait` reported a failed boot; the row still exists.
            await self._plue_delete_by_name(_sanitize_name(self.session_id))
            raise
        data = _envelope(result.stdout.decode(errors="replace"))
        self._workspace_id = str(data.get("id") or data.get("data", {}).get("id") or "")
        if not self._workspace_id:
            raise PlueError(f"workspace create returned no id: {data}")
        status = data.get("status") or data.get("data", {}).get("status")
        if status != "running":
            raise PlueError(f"workspace {self._workspace_id} is {status}: {data.get('failure_message', '')}")
        await self._plue_exec(f"mkdir -p {' '.join(_DIRS)}", user="root", timeout_sec=120)
        for src, dst in self._plue_copies:
            await self._plue_upload(Path(self.environment_dir) / src, dst)
        for mode_bits, target in self._plue_chmods:
            await self._plue_exec(f"chmod {mode_bits} {target}", user="root", timeout_sec=120)

    async def _plue_delete_by_name(self, name: str) -> None:
        try:
            result = await self._run("workspace", "list", "--repo", self._repo(), "--format", "json", timeout=120)
            text = result.stdout.decode(errors="replace")
            rows = json.loads(text[text.find("["):]) if "[" in text else []
        except (PlueError, ValueError, json.JSONDecodeError):
            return
        for row in rows:
            if row.get("name") == name and row.get("id"):
                await self._run("workspace", "delete", row["id"], "--repo", self._repo(), "--format", "json",
                                timeout=300, check=False)

    async def _plue_stop(self) -> None:
        if not self._workspace_id:
            return
        try:
            await self._run("workspace", "delete", *self._ws(), "--format", "json", timeout=300)
        finally:
            self._workspace_id = ""

    # --- exec --------------------------------------------------------------

    async def _plue_exec(self, command: str, cwd: str | None = None, env: dict[str, str] | None = None,
                         timeout_sec: int | None = None, user: str | int | None = None) -> tuple[str, str, int]:
        timeout = int(timeout_sec or _DEFAULT_EXEC_TIMEOUT_SEC)
        args = ["workspace", "exec", *self._ws(), "--user", str(user or _DEFAULT_USER),
                "--timeout", str(timeout), "--format", "json"]
        workdir = cwd or getattr(self.task_env_config, "workdir", None)
        if workdir:
            args += ["--cwd", workdir]
        for key, value in (env or {}).items():
            args += ["--env", f"{key}={value}"]
        args += ["--command", command]
        result = await self._run(*args, timeout=timeout + 60, check=False)
        data = _envelope(result.stdout.decode(errors="replace"))
        if "error" in data and "exit_code" not in data:
            error = data["error"]
            raise PlueError(error.get("message", "exec failed"), error.get("code", ""), result.args)
        payload = data.get("data", data)
        return (
            payload.get("stdout", "") or "",
            payload.get("stderr", "") or "",
            int(payload.get("exit_code", result.returncode)),
        )

    # --- files -------------------------------------------------------------

    async def _plue_upload(self, source: Path | str, target: str) -> None:
        self._ws()  # refuse to let the CLI auto-detect some other workspace
        await self._run("workspace", "cp", str(source), f"{self._workspace_id}:{target}",
                        "--repo", self._repo(), "--user", "root", "--timeout", "1800",
                        "--format", "json", timeout=1900)

    async def _plue_upload_contents(self, source_dir: Path | str, target_dir: str) -> None:
        # pathlib drops a trailing "." segment, so build the docker-cp style
        # "dir/." spelling as a string: the CLI then merges the directory's
        # CONTENTS into target_dir instead of nesting the directory inside it.
        await self._plue_upload(str(Path(source_dir)) + "/.", target_dir)

    async def _plue_download(self, source: str, target: Path | str) -> None:
        self._ws()
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        await self._run("workspace", "cp", f"{self._workspace_id}:{source}", str(target),
                        "--repo", self._repo(), "--user", "root", "--timeout", "1800",
                        "--format", "json", timeout=1900)

    async def _plue_download_dir(self, source: str, target: Path | str) -> None:
        target = Path(target)
        target.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / PurePosixPath(source).name
            await self._plue_download(source, staged)
            if staged.is_dir():
                shutil.copytree(staged, target, dirs_exist_ok=True)
            elif staged.exists():
                shutil.copy2(staged, target / staged.name)

    async def _plue_is(self, path: str, kind: str, user: str | int | None) -> bool:
        flag = "-d" if kind == "dir" else "-f"
        _, _, code = await self._plue_exec(f"test {flag} {shlex.quote(path)}", user=user, timeout_sec=60)
        return code == 0


def _harbor_classes():
    from harbor.environments.base import BaseEnvironment, ExecResult
    from harbor.environments.capabilities import (
        EnvironmentCapabilities,
        EnvironmentResourceCapabilities,
    )
    from harbor.models.task.config import NetworkMode

    class PlueEnvironment(_PlueOps, BaseEnvironment):
        """Harbor environment on Smithers Cloud workspaces."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.default_user = _DEFAULT_USER

        @staticmethod
        def type() -> str:
            return "plue"

        @classmethod
        def resource_capabilities(cls) -> EnvironmentResourceCapabilities:
            return EnvironmentResourceCapabilities(cpu_limit=True, memory_limit=True)

        @property
        def capabilities(self) -> EnvironmentCapabilities:
            return EnvironmentCapabilities(
                disable_internet=True,
                network_allowlist=True,
                network_allowlist_hostnames=True,
                network_allowlist_wildcard_hostnames=True,
            )

        def _validate_definition(self):
            self._resolve_image()

        def _plue_network(self) -> tuple[str, list[str]]:
            policy = self.network_policy
            if policy.network_mode == NetworkMode.NO_NETWORK:
                return "none", []
            if policy.network_mode == NetworkMode.ALLOWLIST:
                return "allowlist", list(policy.allowed_hosts)
            return "proxy", []

        async def start(self, force_build: bool) -> None:
            await self._plue_start()

        async def stop(self, delete: bool):
            await self._plue_stop()

        async def upload_file(self, source_path, target_path: str):
            await self._plue_upload(source_path, target_path)

        async def upload_dir(self, source_dir, target_dir: str):
            await self._plue_upload_contents(source_dir, target_dir)

        async def download_file(self, source_path: str, target_path):
            await self._plue_download(source_path, target_path)

        async def download_dir(self, source_dir: str, target_dir):
            await self._plue_download_dir(source_dir, target_dir)

        async def is_dir(self, path: str, user=None) -> bool:
            return await self._plue_is(path, "dir", user)

        async def is_file(self, path: str, user=None) -> bool:
            return await self._plue_is(path, "file", user)

        async def exec(self, command: str, cwd=None, env=None, timeout_sec=None, user=None) -> ExecResult:
            stdout, stderr, code = await self._plue_exec(
                command, cwd=cwd, env=self._merge_env(env), timeout_sec=timeout_sec,
                user=self._resolve_user(user),
            )
            return ExecResult(stdout=stdout, stderr=stderr, return_code=code)

    return PlueEnvironment


def _pier_classes():
    from pier.environments.base import BaseEnvironment, ExecResult
    from pier.environments.capabilities import EnvironmentCapabilities

    class PluePierEnvironment(_PlueOps, BaseEnvironment):
        """Pier environment on Smithers Cloud workspaces."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.default_user = _DEFAULT_USER

        @staticmethod
        def type() -> str:
            return "plue"

        @property
        def capabilities(self) -> EnvironmentCapabilities:
            return EnvironmentCapabilities(disable_internet=True, filtered_egress=True)

        def _validate_definition(self):
            self._resolve_image()

        def _plue_network(self) -> tuple[str, list[str]]:
            allow = [d.lstrip(".") if not d.startswith(".") else "*" + d for d in self.network_allowlist.domains]
            if getattr(self.task_env_config, "allow_internet", False):
                return "proxy", []
            if allow:
                return "allowlist", allow
            return "none", []

        async def start(self, force_build: bool) -> None:
            await self._plue_start()

        async def stop(self, delete: bool):
            await self._plue_stop()

        async def upload_file(self, source_path, target_path: str):
            await self._plue_upload(source_path, target_path)

        async def upload_dir(self, source_dir, target_dir: str):
            await self._plue_upload_contents(source_dir, target_dir)

        async def download_file(self, source_path: str, target_path):
            await self._plue_download(source_path, target_path)

        async def download_dir(self, source_dir: str, target_dir):
            await self._plue_download_dir(source_dir, target_dir)

        async def exec(self, command: str, cwd=None, env=None, timeout_sec=None, user=None) -> ExecResult:
            stdout, stderr, code = await self._plue_exec(
                command, cwd=cwd, env=env, timeout_sec=timeout_sec, user=user or self.default_user,
            )
            return ExecResult(stdout=stdout, stderr=stderr, return_code=code)

    return PluePierEnvironment


def __getattr__(name: str):
    if name == "PlueEnvironment":
        return _harbor_classes()
    if name == "PluePierEnvironment":
        return _pier_classes()
    raise AttributeError(name)

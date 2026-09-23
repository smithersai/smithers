"""Smithers Cloud (plue) environments for Harbor and Pier.

Every call goes through the public `smithers` CLI exactly as a user would run
it: `workspace create --image … --cpus … --wait`, `workspace exec --format
json`, `workspace cp`, `workspace delete`. No admin or benchmark-only routes.

Configuration (environment variables of the harness host):

    SMITHERS_TOKEN   personal access token of a normal account (CLI auth)
    PLUE_REPO        owner/name of the repository workspaces are created in
    SMITHERS_CLI     path to the smithers binary (default: "smithers" on PATH)
    PLUE_WAIT_SEC    workspace boot wait (default 900)
    PLUE_CAPACITY_WAIT_SEC  how long a create waits for a slot (cluster
                     capacity or the plan's concurrent-workspace cap) before
                     failing (default 14400); the PlueError it fails with is
                     retried by `harbor run -r N --retry-include PlueError`
    PLUE_SLOTS       host-wide slot count shared by every harness process on
                     this machine through PLUE_SLOT_LEDGER (default
                     ~/.cache/plue-slots.json). A slot is 2 vCPU, so a 4-vCPU
                     task holds 2. Grants are first come, first served across
                     processes, so two arms launched with the same -n share
                     the cluster evenly. Unset: no ledger.
    PLUE_MAX_CPUS    the largest guest a sandbox worker can place. A task
                     asking for more raises PlueUnplaceable at once instead
                     of waiting for capacity that cannot appear.

Capacity waits happen before Harbor's environment-start timer. Harbor wraps
`environment.start()` in `asyncio.wait_for(build_timeout_sec)`; importing
PlueEnvironment installs a pre-step (`install_untimed_reserve`) that awaits
`environment.reserve()` first: the slot, the capacity wait and the workspace
boot. `start()` then does only the in-guest setup under the timer.

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
import fcntl
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import Any

_DEFAULT_WAIT_SEC = 900
_DEFAULT_EXEC_TIMEOUT_SEC = 8 * 3600
_DEFAULT_USER = "root"
# The wait runs before Harbor's environment-start timer (see
# install_untimed_reserve), so it is bounded only by this.
_DEFAULT_CAPACITY_WAIT_SEC = 14400
_CAPACITY_POLL_SEC = 60
_SLOT_VCPUS = 2
_SLOT_POLL_SEC = 5
# What the workspace SSH gateway prints on the session's stderr when the
# transport, not the command, failed (plue internal/ssh/server.go). The
# command's exit status is then meaningless.
TRANSPORT_ERRORS = (
    "ERROR: workspace SSH session failed",
    "ERROR: workspace SSH is unavailable",
)
_DIRS = ("/logs/agent", "/logs/verifier", "/logs/artifacts", "/tests", "/solution")
# The worker writes the sandbox's egress proxy and CA trust to this file and
# hands it to the services it starts; an SSH exec session does not read it,
# so every command sources it first. Absent (network none), nothing happens.
EGRESS_ENV = "/etc/smithers/egress.env"
EGRESS_PREFIX = f"if [ -r {EGRESS_ENV} ]; then set -a; . {EGRESS_ENV}; set +a; fi; "


def with_egress(command: str) -> str:
    """The command, run with the workspace's egress proxy in its environment."""
    return EGRESS_PREFIX + command


class PlueError(RuntimeError):
    """A plue CLI call failed. `code` is the CLI's typed error code."""

    def __init__(self, message: str, code: str = "", command: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.command = command or []


class PlueImageError(PlueError):
    """The task environment cannot be expressed as a prebuilt image."""


class PlueUnplaceable(PlueError):
    """The task asks for a bigger guest than any sandbox worker can hold
    (PLUE_MAX_CPUS). An infrastructure limit: never scored, never retried."""


def transport_failure(stderr: str) -> str | None:
    """The gateway's transport error when it is the last thing on stderr."""
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    if lines and lines[-1] in TRANSPORT_ERRORS:
        return lines[-1]
    return None


def slots_for(cpus: float | int | None) -> int:
    """Ledger slots a guest of `cpus` vCPU holds: one per 2 vCPU."""
    return max(1, math.ceil(float(cpus or 1) / _SLOT_VCPUS))


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class SlotLedger:
    """Workspace slots shared by every harness process on one host.

    State is one JSON file guarded by flock: `holders` {key: {pid, slots}}
    and `waiters`, a FIFO list. Only the head waiter can be granted, and only
    when its slots fit, so a 2-slot task is not starved by 1-slot ones and
    two arms with the same -n get the same share. Entries of dead processes
    are dropped on every update.
    """

    def __init__(self, path: Path | str, capacity: int):
        self.path = Path(path)
        self.capacity = capacity
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _update(self, change):
        with open(self.path.with_suffix(self.path.suffix + ".lock"), "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                state = json.loads(self.path.read_text())
            except (OSError, ValueError):
                state = {}
            holders = {k: v for k, v in (state.get("holders") or {}).items() if _pid_alive(int(v["pid"]))}
            waiters = [w for w in (state.get("waiters") or []) if _pid_alive(int(w["pid"]))]
            state = {"capacity": self.capacity, "holders": holders, "waiters": waiters}
            result = change(state)
            state["used"] = sum(int(v["slots"]) for v in state["holders"].values())
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(state, indent=2))
            tmp.replace(self.path)
            return result

    def enqueue(self, key: str, slots: int, pid: int | None = None) -> None:
        pid = pid or os.getpid()

        def change(state):
            if key in state["holders"] or any(w["key"] == key for w in state["waiters"]):
                return
            state["waiters"].append({"key": key, "slots": slots, "pid": pid, "since": time.time()})
        self._update(change)

    def try_grant(self, key: str) -> bool:
        def change(state):
            if key in state["holders"]:
                return True
            if not state["waiters"] or state["waiters"][0]["key"] != key:
                return False
            head = state["waiters"][0]
            used = sum(int(v["slots"]) for v in state["holders"].values())
            if used + int(head["slots"]) > self.capacity and state["holders"]:
                return False
            state["waiters"].pop(0)
            state["holders"][key] = {"pid": head["pid"], "slots": head["slots"], "since": time.time()}
            return True
        return self._update(change)

    def release(self, key: str) -> None:
        def change(state):
            state["holders"].pop(key, None)
            state["waiters"] = [w for w in state["waiters"] if w["key"] != key]
        self._update(change)

    @classmethod
    def from_environment(cls) -> "SlotLedger | None":
        capacity = int(os.environ.get("PLUE_SLOTS", "0") or 0)
        if capacity <= 0:
            return None
        path = os.environ.get("PLUE_SLOT_LEDGER") or str(Path.home() / ".cache" / "plue-slots.json")
        return cls(path, capacity)


def install_untimed_reserve(trial_cls) -> None:
    """Make Harbor await `environment.reserve()` before its timed start.

    Harbor's `Trial._start_agent_environment` is `wait_for(start(),
    build_timeout_sec)`. Waiting for a plue slot is not building the
    environment, and inside that timer it turned a full cluster into
    EnvironmentStartTimeoutError. Environments without `reserve` are
    untouched."""
    original = trial_cls._start_agent_environment
    if getattr(original, "_plue_untimed_reserve", False):
        return

    async def _start_agent_environment(self) -> None:
        reserve = getattr(self.agent_environment, "reserve", None)
        if reserve is not None:
            await reserve()
        await original(self)

    _start_agent_environment._plue_untimed_reserve = True  # type: ignore[attr-defined]
    trial_cls._start_agent_environment = _start_agent_environment


def is_capacity_error(error: PlueError) -> bool:
    """A create that found no room: none on the cluster (`no_capacity`), or
    none under the account's plan (402, "Your … plan allows N running
    workspaces"). Either frees up when a neighbouring trial finishes, so the
    caller waits rather than fails."""
    text = f"{error.code} {error}".lower()
    return ("no_capacity" in text or "no capacity" in text
            or bool(re.search(r"plan allows \d+ running", text)))


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

    _plue_reserved: bool = False
    _plue_ledger_key: str = ""

    def _plue_ledger(self) -> SlotLedger | None:
        return SlotLedger.from_environment()

    async def _plue_reserve(self) -> None:
        """Hold a host slot, then create the workspace and wait for it to run.
        Harbor awaits this before its environment-start timer."""
        if self._plue_reserved:
            return
        cpus = getattr(self.task_env_config, "cpus", None) or 1
        limit = os.environ.get("PLUE_MAX_CPUS", "").strip()
        if limit and float(cpus) > float(limit):
            raise PlueUnplaceable(
                f"task asks for {cpus} vCPU; the largest guest a sandbox worker can place is {limit} vCPU",
                "unplaceable")
        ledger = self._plue_ledger()
        if ledger is not None:
            key = f"{os.getpid()}:{self.session_id}"
            slots = slots_for(cpus)
            await asyncio.to_thread(ledger.enqueue, key, slots)
            self._plue_ledger_key = key
            try:
                while not await asyncio.to_thread(ledger.try_grant, key):
                    await asyncio.sleep(_SLOT_POLL_SEC)
            except BaseException:
                await asyncio.to_thread(ledger.release, key)
                self._plue_ledger_key = ""
                raise
            self.logger.info("plue: holding %s slot(s) of %s", slots, ledger.capacity)
        try:
            await self._plue_create()
        except BaseException:
            await self._plue_release()
            raise
        self._plue_reserved = True

    async def _plue_release(self) -> None:
        if not self._plue_ledger_key:
            return
        ledger = self._plue_ledger()
        if ledger is not None:
            await asyncio.to_thread(ledger.release, self._plue_ledger_key)
        self._plue_ledger_key = ""

    async def _plue_start(self) -> None:
        await self._plue_reserve()
        await self._plue_exec(f"mkdir -p {' '.join(_DIRS)}", user="root", timeout_sec=120)
        for src, dst in self._plue_copies:
            await self._plue_upload(Path(self.environment_dir) / src, dst)
        for mode_bits, target in self._plue_chmods:
            await self._plue_exec(f"chmod {mode_bits} {target}", user="root", timeout_sec=120)

    async def _plue_create(self) -> None:
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
        deadline = asyncio.get_event_loop().time() + float(os.environ.get("PLUE_CAPACITY_WAIT_SEC", _DEFAULT_CAPACITY_WAIT_SEC))
        while True:
            try:
                result = await self._run(*args, timeout=_DEFAULT_WAIT_SEC + 120)
                break
            except PlueError as error:
                # `create --wait` reported a failed boot; the row still exists.
                await self._plue_delete_by_name(_sanitize_name(self.session_id))
                if not is_capacity_error(error) or asyncio.get_event_loop().time() >= deadline:
                    raise
                self.logger.info("plue: no capacity, retrying in %ss", _CAPACITY_POLL_SEC)
                await asyncio.sleep(_CAPACITY_POLL_SEC)
        data = _envelope(result.stdout.decode(errors="replace"))
        self._workspace_id = str(data.get("id") or data.get("data", {}).get("id") or "")
        if not self._workspace_id:
            raise PlueError(f"workspace create returned no id: {data}")
        status = data.get("status") or data.get("data", {}).get("status")
        if status != "running":
            raise PlueError(f"workspace {self._workspace_id} is {status}: {data.get('failure_message', '')}")

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
        try:
            if self._workspace_id:
                await self._run("workspace", "delete", *self._ws(), "--format", "json", timeout=300)
        finally:
            self._workspace_id = ""
            self._plue_reserved = False
            await self._plue_release()

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
        args += ["--command", with_egress(command)]
        result = await self._run(*args, timeout=timeout + 60, check=False)
        data = _envelope(result.stdout.decode(errors="replace"))
        if "error" in data and "exit_code" not in data:
            error = data["error"]
            raise PlueError(error.get("message", "exec failed"), error.get("code", ""), result.args)
        payload = data.get("data", data)
        stderr = payload.get("stderr", "") or ""
        code = int(payload.get("exit_code", result.returncode))
        failure = transport_failure(stderr) or transport_failure(result.stderr.decode(errors="replace"))
        if code != 0 and failure:
            # The gateway lost the session; the command may still be running
            # or may never have started. Not the command's exit status.
            raise PlueError(failure, "ssh_session_failed", result.args)
        return payload.get("stdout", "") or "", stderr, code

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
    from harbor.trial.trial import Trial

    install_untimed_reserve(Trial)

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

        async def reserve(self) -> None:
            await self._plue_reserve()

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

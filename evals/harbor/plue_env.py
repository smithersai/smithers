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
    PLUE_MAX_WORKSPACES  running workspaces the ledger allows at once: the
                     account plan's concurrent-sandbox cap (a create over it
                     is refused with 402). Unset or 0: no count cap.
    PLUE_MAX_CPUS    the largest guest a sandbox worker can place. A task
                     asking for more raises PlueUnplaceable at once instead
                     of waiting for capacity that cannot appear. So does a
                     task that needs a GPU, a TPU or anything else the
                     workspace backend lacks: Harbor's constructor check is
                     deferred to reserve(), inside the trial.
    A task whose docker-compose file adds services beside `main` is
    unplaceable too (see compose_sidecars).
    PLUE_IMAGE_CONFIG_CACHE  where the image's WORKDIR is cached (see
                     image_config.py): commands run there unless the caller
                     names a cwd, as `docker exec` does.
    PLUE_LEAK_LOG    where stop() records a workspace it could not delete
                     (default ~/.cache/plue-leaks.log); stop() never raises.

Every environment method raises PlueError (or a subclass) and nothing else,
so a plue failure is always a trial's exception and never the job's.

A task whose verifier runs in a separate environment (all of TB4) hands its
ledger slot from the agent workspace straight to the verifier workspace, and
Harbor awaits the verifier's reserve() before its build timer as well.
Queueing that verifier behind fresh trials inside the timer was every
VerifierTimeoutError of the 2026-09-23 pass.

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
import contextlib
import fcntl
import functools
import importlib.metadata
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from . import image_config, outcome
except ImportError:  # run as a top-level module (fixtures)
    import image_config  # type: ignore[no-redef]
    import outcome  # type: ignore[no-redef]

_DEFAULT_WAIT_SEC = 900
_DEFAULT_EXEC_TIMEOUT_SEC = 8 * 3600
_DEFAULT_USER = "root"
# The wait runs before Harbor's environment-start timer (see
# install_untimed_reserve), so it is bounded only by this.
_DEFAULT_CAPACITY_WAIT_SEC = 14400
_CAPACITY_POLL_SEC = 60
_SLOT_VCPUS = 2
_SLOT_POLL_SEC = 5
# How long a finished agent workspace keeps its slot for the same trial's
# verifier workspace. Harbor stops one and creates the other seconds apart.
_HEIR_TTL_SEC = 180
_DELETE_ATTEMPTS = 3
# A lost exec transport reattaches to the same durable exec id (plue CLI
# 71c3ed6a+ detaches the command in the guest and keeps its output); the CLI
# already reconnects on its own, so these are the waits after it gives up.
_EXEC_REATTACH_BACKOFF_SEC = (10, 30, 60, 120, 240)
_DELETE_BACKOFF_SEC = 10
# Harbor versions whose Trial._separate_verifier_env is copied below.
_VERIFIER_PATCH_HARBOR = ("0.23.0",)
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
# Intel OpenMP (PyTorch's libiomp) asserts in kmp_affinity.cpp(642) on the
# guest's CPU topology, each vCPU presented as its own socket; disabling its
# thread pinning changes no result. A task's own KMP_AFFINITY wins.
GUEST_DEFAULTS = 'export KMP_AFFINITY="${KMP_AFFINITY:-disabled}"; '
EGRESS_PREFIX = f"if [ -r {EGRESS_ENV} ]; then set -a; . {EGRESS_ENV}; set +a; fi; {GUEST_DEFAULTS}"


# The microsandbox guest init mounts a 512 MiB tmpfs over /tmp, hiding the
# image's own /tmp (layout-config-recreation2 ships 1393 fonts there) and
# capping temp space. Under Docker /tmp is the image's directory, so the
# tmpfs is lazily unmounted (a guest service may hold a log open in it) and
# the overlay's disk-backed /tmp shows through.
IMAGE_TMP = ("if grep -qs ' /tmp tmpfs ' /proc/mounts; then umount -l /tmp; fi; "
             "[ -d /tmp ] || { mkdir -p /tmp && chmod 1777 /tmp; }")


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


def reattachable(error: "PlueError") -> bool:
    """A failure after which the same durable exec id may still be running or
    finished in the guest: a lost SSH transport, a gateway or API that was
    briefly away. A VM that no longer exists, or a refused plan limit, is not."""
    if error.code in ("ssh_transport", "ssh_session_failed"):
        return True
    text = str(error).lower()
    if "no longer exists" in text or "plan allows" in text or "not found" in text:
        return False
    return bool(re.search(r"did not become ssh-ready|-> 5\d\d|timed out|connection reset|connection refused|eof", text))


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


def heir_of(session_id: str) -> str | None:
    """The session-id prefix of the verifier workspace that follows an agent
    workspace in the same trial (Harbor: `<trial>__env`, then
    `<trial>__verifier__<key>`)."""
    if session_id.endswith("__env"):
        return session_id[: -len("__env")] + "__verifier__"
    return None


class SlotLedger:
    """Workspace slots shared by every harness process on one host.

    State is one JSON file guarded by flock: `holders` {key: {pid, slots}}
    and `waiters`, a FIFO list. Only the head waiter can be granted, and only
    when its slots fit and fewer than `max_holders` workspaces run, so a
    2-slot task is not starved by 1-slot ones and two arms with the same -n
    get the same share. A holder released with an `heir` keeps its slot until
    `until` for the first key starting with that prefix: the heir queues
    first and takes the slot at once. Entries of dead processes and expired
    handovers are dropped on every update.
    """

    def __init__(self, path: Path | str, capacity: int, max_holders: int = 0):
        self.path = Path(path)
        self.capacity = capacity
        self.max_holders = max_holders
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _update(self, change):
        with open(self.path.with_suffix(self.path.suffix + ".lock"), "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                state = json.loads(self.path.read_text())
            except (OSError, ValueError):
                state = {}
            now = time.time()
            holders = {k: v for k, v in (state.get("holders") or {}).items()
                       if _pid_alive(int(v["pid"])) and float(v.get("until", now + 1)) > now}
            waiters = [w for w in (state.get("waiters") or []) if _pid_alive(int(w["pid"]))]
            state = {"capacity": self.capacity, "max_holders": self.max_holders,
                     "holders": holders, "waiters": waiters}
            result = change(state)
            state["used"] = sum(int(v["slots"]) for v in state["holders"].values())
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(state, indent=2))
            tmp.replace(self.path)
            return result

    @staticmethod
    def _handover(state, key: str) -> str | None:
        for holder, entry in state["holders"].items():
            if entry.get("heir") and key.startswith(entry["heir"]):
                return holder
        return None

    def enqueue(self, key: str, slots: int, pid: int | None = None) -> None:
        pid = pid or os.getpid()

        def change(state):
            if key in state["holders"] or any(w["key"] == key for w in state["waiters"]):
                return
            entry = {"key": key, "slots": slots, "pid": pid, "since": time.time()}
            if self._handover(state, key):
                heirs = sum(1 for w in state["waiters"] if w.get("heir"))
                state["waiters"].insert(heirs, {**entry, "heir": True})
            else:
                state["waiters"].append(entry)
        self._update(change)

    def try_grant(self, key: str) -> bool:
        def change(state):
            if key in state["holders"]:
                return True
            waiter = next((w for w in state["waiters"] if w["key"] == key), None)
            if waiter is None:
                return False
            used = sum(int(v["slots"]) for v in state["holders"].values())
            previous = self._handover(state, key)
            if previous is not None:
                others = used - int(state["holders"][previous]["slots"])
                if others + int(waiter["slots"]) <= self.capacity or len(state["holders"]) == 1:
                    state["holders"].pop(previous)
                    state["waiters"].remove(waiter)
                    state["holders"][key] = {"pid": waiter["pid"], "slots": waiter["slots"], "since": time.time()}
                    return True
            if state["waiters"][0]["key"] != key:
                return False
            if state["holders"]:
                if used + int(waiter["slots"]) > self.capacity:
                    return False
                if self.max_holders and len(state["holders"]) >= self.max_holders:
                    return False
            state["waiters"].pop(0)
            state["holders"][key] = {"pid": waiter["pid"], "slots": waiter["slots"], "since": time.time()}
            return True
        return self._update(change)

    def release(self, key: str, heir: str | None = None, ttl: float = _HEIR_TTL_SEC) -> None:
        def change(state):
            state["waiters"] = [w for w in state["waiters"] if w["key"] != key]
            if heir and key in state["holders"]:
                state["holders"][key].update(heir=heir, until=time.time() + ttl)
            else:
                state["holders"].pop(key, None)
        self._update(change)

    @classmethod
    def from_environment(cls) -> "SlotLedger | None":
        capacity = int(os.environ.get("PLUE_SLOTS", "0") or 0)
        if capacity <= 0:
            return None
        path = os.environ.get("PLUE_SLOT_LEDGER") or str(Path.home() / ".cache" / "plue-slots.json")
        return cls(path, capacity, int(os.environ.get("PLUE_MAX_WORKSPACES", "0") or 0))


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


def install_trial_containment(trial_cls) -> None:
    """Keep Harbor's Trial-constructor refusals inside the trial.

    `Trial.__init__` validates the artifact configuration and the network
    policy, and a refusal there (payments-pipeline-fix names its `kafka`
    sidecar in its artifacts; plue has no compose) raises from `Trial.create`,
    outside the trial's exception handling, which ends the whole job. The
    refusal is kept and raised by `_prepare()` as PlueUnplaceable, where the
    trial records it."""
    for name in ("_validate_artifact_configuration", "_validate_network_policy_modes"):
        check = getattr(trial_cls, name, None)
        if check is None or getattr(check, "_plue_contained", False):
            continue

        def deferred(self, _check=check):
            try:
                _check(self)
            except Exception as error:  # noqa: BLE001
                if getattr(self, "_plue_deferred_init", None) is None:
                    self._plue_deferred_init = PlueUnplaceable(
                        f"the plue workspace backend cannot hold this task: {error}", "unsupported")

        deferred._plue_contained = True  # type: ignore[attr-defined]
        setattr(trial_cls, name, deferred)

    prepare = trial_cls._prepare
    if getattr(prepare, "_plue_contained", False):
        return

    async def _prepare(self, _prepare=prepare):
        deferred_error = getattr(self, "_plue_deferred_init", None)
        if deferred_error is not None:
            raise deferred_error
        await _prepare(self)

    _prepare._plue_contained = True  # type: ignore[attr-defined]
    trial_cls._prepare = _prepare


def install_untimed_verifier_reserve(trial_cls) -> bool:
    """The same pre-step for the separate verifier environment.

    Harbor creates it inside `Trial._separate_verifier_env` and starts it
    under `wait_for(start(), build_timeout_sec)` with no hook in between, so
    this is a copy of that method (Harbor 0.23.0) with one added line: await
    `env.reserve()` before the timer. Other Harbor versions are left alone and
    say so. Returns whether the patch is installed."""
    current = trial_cls._separate_verifier_env
    if getattr(current, "_plue_untimed_reserve", False):
        return True
    version = importlib.metadata.version("harbor")
    if version not in _VERIFIER_PATCH_HARBOR:
        import logging
        logging.getLogger(__name__).warning(
            "plue: Harbor %s is not %s; the separate verifier environment still reserves inside the build timer",
            version, _VERIFIER_PATCH_HARBOR)
        return False
    from harbor.environments.factory import EnvironmentFactory

    @contextlib.asynccontextmanager
    async def _separate_verifier_env(self, env_config, *, key, plan, step_cfg=None):
        verifier_runtime_config = self.config.environment.model_copy(update={"extra_docker_compose": []})
        if plan.verifier_env_baseline is None:
            raise RuntimeError("separate verifier env requires a verifier baseline in the network plan")
        env = EnvironmentFactory.create_environment_from_config(
            config=verifier_runtime_config,
            environment_dir=self._verifier_env_build_context(step_cfg),
            environment_name=self.task.short_name,
            session_id=self._separate_verifier_session_id(key),
            trial_paths=self.paths,
            task_env_config=env_config,
            logger=self.logger,
            mounts=self._verifier_env_mounts(env_config),
            network_policy=plan.verifier_env_baseline,
            phase_network_policies=[plan.verifier_phase],
        )
        env.context_id = self._id
        self._validate_separate_verifier_env_policies(env, plan=plan)
        try:
            reserve = getattr(env, "reserve", None)
            if reserve is not None:
                await reserve()
            await asyncio.wait_for(env.start(force_build=False), timeout=self._environment_build_timeout_sec)
            yield env
        finally:
            try:
                await asyncio.shield(env.stop(delete=self.config.environment.delete))
            except Exception as exc:
                self.logger.debug(f"Failed to stop verifier env '{key}': {exc}")

    _separate_verifier_env._plue_untimed_reserve = True  # type: ignore[attr-defined]
    trial_cls._separate_verifier_env = _separate_verifier_env
    return True


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


def compose_sidecars(environment_dir: Path | str) -> list[str]:
    """Services the task's docker-compose file runs beside `main`.

    Harbor's Docker environment starts them as separate containers on a
    private network. A plue workspace is one guest: running a sidecar inside
    it would hand the agent the sidecar's filesystem (freight-dispatch-shift's
    event feed exists to hide future records), and plue has no network
    between workspaces, so such a task is unplaceable here."""
    for name in ("docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"):
        path = Path(environment_dir) / name
        if path.is_file():
            import yaml
            services = (yaml.safe_load(path.read_text()) or {}).get("services") or {}
            return sorted(name for name in services if name != "main")
    return []


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

    def _validate_definition(self) -> None:
        sidecars = compose_sidecars(self.environment_dir)
        if sidecars:
            raise PlueUnplaceable(
                f"task runs {len(sidecars)} sidecar container(s) ({', '.join(sidecars)}); "
                "a plue workspace is one guest with no network to other workspaces", "sidecars")
        self._resolve_image()

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
        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            raise PlueError(f"cannot run the plue CLI: {error}", "cli_unavailable", command) from error
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
    # A check Harbor runs in the constructor that this backend fails (GPU,
    # an image plue cannot build, …), raised by reserve() inside the trial.
    _plue_deferred: PlueError | None = None
    # The image's WORKDIR: the default cwd of every exec, as under Docker.
    _plue_workdir: str | None = None

    def _plue_ledger(self) -> SlotLedger | None:
        return SlotLedger.from_environment()

    async def _plue_reserve(self) -> None:
        """Hold a host slot, then create the workspace and wait for it to run.
        Harbor awaits this before its environment-start timer."""
        if self._plue_deferred is not None:
            raise self._plue_deferred
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

    async def _plue_release(self, heir: str | None = None) -> None:
        if not self._plue_ledger_key:
            return
        ledger = self._plue_ledger()
        if ledger is not None:
            await asyncio.to_thread(ledger.release, self._plue_ledger_key, heir)
        self._plue_ledger_key = ""

    def _plue_verifies_separately(self) -> bool:
        """Whether the task's verifier runs in its own environment, read from
        the task.toml beside this environment directory."""
        try:
            import tomllib
            config = tomllib.loads((Path(self.environment_dir).parent / "task.toml").read_text())
        except (OSError, ValueError):
            return False
        verifier = config.get("verifier") or {}
        return verifier.get("environment_mode") == "separate" or "environment" in verifier

    def _plue_heir(self) -> str | None:
        heir = heir_of(str(getattr(self, "session_id", "")))
        if heir is None or not self._plue_ledger_key or not self._plue_verifies_separately():
            return None
        return self._plue_ledger_key.split(":", 1)[0] + ":" + heir

    async def _plue_start(self) -> None:
        await self._plue_reserve()
        if self._plue_image:
            self._plue_workdir = await asyncio.to_thread(image_config.working_dir, self._plue_image)
        await self._plue_exec(f"{IMAGE_TMP}; mkdir -p {' '.join(_DIRS)}", user="root", timeout_sec=120)
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
        """Delete the workspace and free the slot. Never raises: a workspace
        that survives every attempt is logged to PLUE_LEAK_LOG, because an
        undeleted workspace is not the trial's failure."""
        workspace = self._workspace_id
        heir = self._plue_heir()
        try:
            last: PlueError | None = None
            for attempt in range(_DELETE_ATTEMPTS if workspace else 0):
                try:
                    await self._run("workspace", "delete", workspace, "--repo", self._repo(),
                                    "--format", "json", timeout=300)
                    last = None
                    break
                except PlueError as error:
                    if "not found" in str(error).lower():
                        last = None
                        break
                    last = error
                    await asyncio.sleep(_DELETE_BACKOFF_SEC * (attempt + 1))
            if last is not None:
                self._plue_record_leak(workspace, last)
        except Exception as error:  # noqa: BLE001 - stop() must not raise
            self._plue_record_leak(workspace, error)
        finally:
            self._workspace_id = ""
            self._plue_reserved = False
            try:
                await self._plue_release(heir)
            except Exception as error:  # noqa: BLE001
                self.logger.warning("plue: could not release ledger slot: %s", error)

    def _plue_record_leak(self, workspace: str, error: BaseException) -> None:
        self.logger.warning("plue: workspace %s was not deleted: %s", workspace, error)
        path = Path(os.environ.get("PLUE_LEAK_LOG") or Path.home() / ".cache" / "plue-leaks.log")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as log:
                log.write(json.dumps({"at": time.time(), "workspace": workspace, "repo": os.environ.get("PLUE_REPO", ""),
                                      "session": getattr(self, "session_id", ""), "error": str(error)[:500]}) + "\n")
        except OSError:
            pass

    # --- exec --------------------------------------------------------------

    async def _plue_exec(self, command: str, cwd: str | None = None, env: dict[str, str] | None = None,
                         timeout_sec: int | None = None, user: str | int | None = None) -> tuple[str, str, int]:
        """Run `command` durably: one exec id for its whole life, reattached
        after a lost transport; a guest that is gone is a PlueError."""
        timeout = int(timeout_sec or _DEFAULT_EXEC_TIMEOUT_SEC)
        exec_id = f"{_sanitize_name(str(getattr(self, 'session_id', '')))[:40]}-{uuid.uuid4().hex[:12]}"
        args = ["workspace", "exec", *self._ws(), "--user", str(user or _DEFAULT_USER),
                "--timeout", str(timeout), "--format", "json", "--exec-id", exec_id]
        workdir = cwd or getattr(self.task_env_config, "workdir", None) or self._plue_workdir
        if workdir:
            args += ["--cwd", workdir]
        for key, value in (env or {}).items():
            args += ["--env", f"{key}={value}"]
        args += ["--command", with_egress(command)]
        for wait in (*_EXEC_REATTACH_BACKOFF_SEC, None):
            try:
                return await self._plue_exec_once(args, timeout)
            except PlueError as error:
                if wait is None or not reattachable(error):
                    raise
                self.logger.info("plue: exec %s lost its transport (%s); reattaching in %ss", exec_id, error, wait)
                await asyncio.sleep(wait)
        raise AssertionError("unreachable")

    async def _plue_exec_once(self, args: list[str], timeout: int) -> tuple[str, str, int]:
        result = await self._run(*args, timeout=timeout + 60, check=False)
        try:
            data = _envelope(result.stdout.decode(errors="replace"))
        except ValueError as error:
            raise PlueError(f"unreadable workspace exec reply: {error}", "cli_reply", result.args) from error
        if not isinstance(data, dict) or not data:
            raise PlueError(f"empty workspace exec reply (exit {result.returncode})", "cli_reply", result.args)
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
        client = outcome.ssh_transport_error(stderr + "\n" + result.stderr.decode(errors="replace"))
        if code == 255 and client:
            # OpenSSH exits 255 on its own errors: connect timeout, the remote
            # closing the connection, a dead read. Not the command's status.
            raise PlueError(client, "ssh_transport", result.args)
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


def contained(method):
    """Every failure of an environment method is a PlueError, so Harbor
    records it on the trial. Cancellation passes through untouched."""
    @functools.wraps(method)
    async def wrapper(self, *args, **kwargs):
        try:
            return await method(self, *args, **kwargs)
        except PlueError:
            raise
        except Exception as error:
            raise PlueError(f"{type(error).__name__}: {error}", "harness_internal") from error
    return wrapper


def _deferring(check_name: str):
    """A constructor check whose failure is kept for reserve() to raise."""
    def check(self):
        try:
            getattr(super(_Deferring, self), check_name)()
        except PlueError as error:
            self._plue_deferred = self._plue_deferred or error
        except Exception as error:  # GPU, TPU, Windows, network policy …
            self._plue_deferred = self._plue_deferred or PlueUnplaceable(
                f"the plue workspace backend cannot hold this task: {error}", "unsupported")
    check.__name__ = check_name
    return check


class _Deferring:
    """Mixin: Harbor's constructor-time checks never raise out of __init__.

    Harbor constructs the environment in `Trial.create`, outside the trial's
    exception handling, so a raise there ends the whole job (the 2026-09-23
    06:02 and 06:45 crashes: `Task requires 1 GPU(s)`). The first failure is
    raised by reserve() instead, where the trial records it."""


for _name in ("_validate_definition", "_validate_resource_mode_support", "_validate_gpu_support",
              "_validate_tpu_support", "_validate_network_policy_support", "_validate_windows_support",
              "_validate_extra_docker_compose_support"):
    setattr(_Deferring, _name, _deferring(_name))


def _harbor_classes():
    from harbor.environments.base import BaseEnvironment, ExecResult
    from harbor.environments.capabilities import (
        EnvironmentCapabilities,
        EnvironmentResourceCapabilities,
    )
    from harbor.models.task.config import NetworkMode
    from harbor.trial.trial import Trial

    install_untimed_reserve(Trial)
    install_untimed_verifier_reserve(Trial)
    install_trial_containment(Trial)

    class PlueEnvironment(_Deferring, _PlueOps, BaseEnvironment):
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

        def _plue_network(self) -> tuple[str, list[str]]:
            policy = self.network_policy
            if policy.network_mode == NetworkMode.NO_NETWORK:
                return "none", []
            if policy.network_mode == NetworkMode.ALLOWLIST:
                return "allowlist", list(policy.allowed_hosts)
            return "proxy", []

        @contained
        async def reserve(self) -> None:
            await self._plue_reserve()

        @contained
        async def start(self, force_build: bool) -> None:
            await self._plue_start()

        async def stop(self, delete: bool):
            await self._plue_stop()  # never raises

        @contained
        async def upload_file(self, source_path, target_path: str):
            await self._plue_upload(source_path, target_path)

        @contained
        async def upload_dir(self, source_dir, target_dir: str):
            await self._plue_upload_contents(source_dir, target_dir)

        @contained
        async def download_file(self, source_path: str, target_path):
            await self._plue_download(source_path, target_path)

        @contained
        async def download_dir(self, source_dir: str, target_dir):
            await self._plue_download_dir(source_dir, target_dir)

        @contained
        async def is_dir(self, path: str, user=None) -> bool:
            return await self._plue_is(path, "dir", user)

        @contained
        async def is_file(self, path: str, user=None) -> bool:
            return await self._plue_is(path, "file", user)

        @contained
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

    class PluePierEnvironment(_Deferring, _PlueOps, BaseEnvironment):
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

        def _plue_network(self) -> tuple[str, list[str]]:
            allow = [d.lstrip(".") if not d.startswith(".") else "*" + d for d in self.network_allowlist.domains]
            if getattr(self.task_env_config, "allow_internet", False):
                return "proxy", []
            if allow:
                return "allowlist", allow
            return "none", []

        @contained
        async def start(self, force_build: bool) -> None:
            await self._plue_start()

        async def stop(self, delete: bool):
            await self._plue_stop()  # never raises

        @contained
        async def upload_file(self, source_path, target_path: str):
            await self._plue_upload(source_path, target_path)

        @contained
        async def upload_dir(self, source_dir, target_dir: str):
            await self._plue_upload_contents(source_dir, target_dir)

        @contained
        async def download_file(self, source_path: str, target_path):
            await self._plue_download(source_path, target_path)

        @contained
        async def download_dir(self, source_dir: str, target_dir):
            await self._plue_download_dir(source_dir, target_dir)

        @contained
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

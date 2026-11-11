"""The Smithers flows harness as a Harbor (and Pier) external agent.

    harbor run -p <tasks> -a packages.smithers.agent.harness.benchmarks.harbor.smithers_agent:SmithersAgent -m openai/gpt-6.1-sol
    pier run -p <tasks> --agent-import-path packages.smithers.agent.harness.benchmarks.harbor.smithers_agent:SmithersAgent -m openai/gpt-6.1-sol

Harbor starts the task's container and hands this class the instruction. The
agent runs OUR harness on the host, the `smthrs` CLI out of this checkout, with
the instruction as the flow's whole task and the task container as the only
thing its `bash` flow may touch: every command is delivered by `docker exec`
(`packages/smithers/agent/std/src/Container.ts`), which is the same seam the
SWE-bench rig uses. The model is reached from the host, so the container needs
no network and the task's `no-network` seal is kept.

One prompt for every task, `prompt.md` beside this file. It carries the
instruction verbatim and how to reach the container, nothing else: no
task-specific hints, no `tests/` or `solution/` directory is ever read or
uploaded, and nothing is written into the container after the run except, in
commit mode, the commit itself.

What every trial records under its Harbor logs directory:

    smithers-run.json   seat, auth mode, route binding, harness revision, subject
                        fingerprint, wall clock, tokens, exit status, tokens by
                        purpose and where the time went
    trajectory.json     ATIF-v1.8 trajectory folded from the harness journal:
                        one step per model call the agent made, and every
                        model call of the run, the judge's included, as a row
                        (`calls.py`)
    smithers-run.log    the CLI's own stdout and stderr
    workspace/          the flow file and `.flows/control.db`, the journal itself

The chatgpt route is proven, not assumed: when the seat authenticates through
the ChatGPT subscription the CLI is started with `OPENAI_API_KEY` removed from
its environment, so an api-key fallback cannot succeed silently, and the
journal's `model-requested` binding is copied into `smithers-run.json`.

On Smithers Cloud (`-e packages.smithers.agent.harness.benchmarks.harbor.plue_env:PlueEnvironment`) the task
lives in a plue workspace instead of a local container. The "container" the
prompt names is then the workspace id, and `plue_docker.py` is placed first on
the CLI's PATH under the name `docker`, so the same `docker exec` seam reaches
the workspace through the public `smithers workspace exec` command.

The ChatGPT seat is drawn per trial from `accounts.Pool`: every logged-in
Codex subscription on the host in round-robin (`CODEX_HOME` of the CLI), the
label recorded in `smithers-run.json`, and an account that reports a usage
limit taken out of rotation.

Environment:

    SMITHERS_ROOT          the Smithers checkout to run; default: this file's
    SMITHERS_OPENAI_AUTH   `chatgpt` (default for openai seats) or `api-key`
    SMITHERS_BENCH_DOCKER  the docker CLI; default `docker`
    SMITHERS_CLI, PLUE_REPO, SMITHERS_TOKEN, XDG_CONFIG_HOME
                           the plue CLI and its account, on Smithers Cloud

Agent kwargs (`--ak key=value`):

    commit=1        commit the container's repository after the run (DeepSWE
                    grades `git diff base..HEAD`; default on under Pier)
    cwd=/app        working directory inside the container; default: the
                    task's `workdir`, else `/app`
    budget_sec=N    wall-clock budget for the run; default: the agent timeout
                    the runner enforces on the trial, minus 30 s. A trial
                    whose timeout cannot be found is refused (`BudgetUnknown`)
    reasoning_effort=E
                    the flow's reasoning effort; default `xhigh`
                    (`accounts.DEFAULT_EFFORT`), the kwarg and the default of
                    the stock Codex arm (`codex_pool.py`)
    transport=T     how commands reach the task: `docker` (`docker exec` on
                    this host's daemon) or `harbor` (the runner's own
                    `environment.exec`, through `harbor_exec.py`). Default:
                    `docker` for a local Docker environment, `harbor` for
                    every other one (Runta, Daytona, Modal, ...)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import locale
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    from . import accounts, calls, harbor_exec, plue_docker
except ImportError:  # imported by file path (fixtures)
    import accounts  # type: ignore[no-redef]
    import calls  # type: ignore[no-redef]
    import harbor_exec  # type: ignore[no-redef]
    import plue_docker  # type: ignore[no-redef]

# Pier ships Harbor as a dependency, so under Pier both import; the runner
# that calls `install_spec()` and `network_allowlist()` is Pier's, and its
# `BaseAgent` is the one to subclass there. Harbor alone has no `pier`.
try:
    from pier.agents.base import BaseAgent  # type: ignore[import-not-found]
    from pier.environments.base import BaseEnvironment  # type: ignore[import-not-found]
    from pier.models.agent.context import AgentContext  # type: ignore[import-not-found]

    AgentCapabilities = None
    FRAMEWORK = "pier"
except ImportError:
    try:
        from harbor.agents.base import BaseAgent  # type: ignore[no-redef]
        from harbor.agents.capabilities import AgentCapabilities  # type: ignore[no-redef]
        from harbor.environments.base import BaseEnvironment  # type: ignore[no-redef]
        from harbor.models.agent.context import AgentContext  # type: ignore[no-redef]

        FRAMEWORK = "harbor"
    except ImportError:
        # Neither runner is installed: the module still imports so the offline
        # fixtures can exercise the prompt, the journal fold and the trajectory.
        from abc import ABC

        class BaseAgent(ABC):  # type: ignore[no-redef]
            def __init__(self, logs_dir: "Path", model_name: "str | None" = None, **kwargs: "Any") -> None:
                self.logs_dir = logs_dir
                self.model_name = model_name

        AgentCapabilities = None
        BaseEnvironment = Any  # type: ignore[assignment,misc]
        AgentContext = Any  # type: ignore[assignment,misc]
        FRAMEWORK = "none"

HERE = Path(__file__).resolve().parent
PROMPT_PATH = HERE / "prompt.md"
PLUE_SHIM = plue_docker.SHIM
CLI_RELATIVE = Path("packages/smithers/bin/smithers.mjs")
BUILT_RELATIVE = Path("packages/smithers/dist/esm/bin.js")
SUBJECT_RELATIVE = Path("packages/smithers/agent/harness/benchmarks/swebench/lib/subject.mjs")
FLOW_NAME = "task"
# The task's agent can hand a sub-task to a copy of itself: a second markdown
# flow beside the task's, which a cell calls as `ctx.call("worker", { args })`.
# It names no model and no effort, so it runs on the trial's own seat.
WORKER_PATH = HERE / "worker.md"
WORKER_NAME = "worker"
# The scratch workspace's own note of the container its CLI is sealed to, for
# `audit_host_calls.py` to find a running attempt's journal by.
SEAL_FILE = "smithers-bench.json"
# Where the sealed CLI runs a `bash` call that names no container
# (`Bash.sealed`): the task container. Recorded per trial because a CLI from
# before that refused such a call instead.
UNNAMED_BASH = "container"

COMMIT_PARAGRAPH = """
- The task directory is a git repository, and only committed work counts:
  anything left uncommitted when you complete is discarded. Commit everything
  you changed before completing (`git add -A && git commit -m "<summary>"`,
  with `-c user.name=agent -c user.email=agent@localhost` if git asks for an
  identity).
"""


def _truthy(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def compose_project_name(session_id: str) -> str:
    """Docker Compose's sanitization of a project name; Harbor and Pier both
    name the task project after the environment's session id."""
    name = session_id.lower()
    if not re.match(r"^[a-z0-9]", name):
        name = "0" + name
    return re.sub(r"[^a-z0-9_-]", "-", name)


def seat_of(model_name: str | None) -> str:
    """`openai/gpt-6.1-sol` (Harbor's spelling) to `openai:gpt-6.1-sol` (the CLI's)."""
    if not model_name:
        raise ValueError("SmithersAgent needs a model, e.g. -m openai/gpt-6.1-sol")
    if "/" in model_name:
        provider, model = model_name.split("/", 1)
        return f"{provider}:{model}"
    if ":" in model_name:
        return model_name
    return f"openai:{model_name}"


# The efforts the harness knows (`ModelRequest.ReasoningEffort`). It reads any
# other `effort:` as unset and runs the flow at `high` (`effortFor` in
# `AgentSession.ts`), which would change the arm without a word, so an unknown
# effort is refused before a flow file is written.
EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
DEFAULT_EFFORT = accounts.DEFAULT_EFFORT


def effort_of(value: Any) -> str:
    """`value` when it is an effort the harness knows, else a ValueError."""
    if not isinstance(value, str) or value not in EFFORTS:
        raise ValueError(f"reasoning_effort must be one of {', '.join(EFFORTS)}; got {value!r}")
    return value


def render_prompt(instruction: str, *, seat: str, cwd: str, commit: bool,
                  effort: str = DEFAULT_EFFORT) -> str:
    """The one flow file, with the instruction verbatim. It names no
    container: the CLI is sealed to the task's (`SMITHERS_BASH_CONTAINER`)
    and runs every command there."""
    template = PROMPT_PATH.read_text(encoding="utf-8")
    return (
        template.replace("{{effort}}", effort_of(effort))
        .replace("{{seat}}", seat)
        .replace("{{cwd}}", cwd)
        .replace("{{commit}}", COMMIT_PARAGRAPH if commit else "")
        .replace("{{instruction}}", instruction.strip() + "\n")
    )


def render_worker(*, cwd: str) -> str:
    """The worker flow file. The registry appends the caller's `args` to it."""
    return WORKER_PATH.read_text(encoding="utf-8").replace("{{cwd}}", cwd)


HELPER_VARIABLE = "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"

# Nobody answers a benchmark run, so an in-run `ask` is refused at once with a
# typed failure the cell reads, instead of parking the run until the agent
# timeout (luna-A-smoke2 mp-checkpoint tGyE6hv waited at `waiting-approval`
# from frame 46 to 3534 s). Nothing is approved on anyone's behalf.
ASKS_VARIABLE = "SMITHERS_ASKS"
ASKS = "refuse"
HELPER_DEFAULT = Path("/usr/local/bin/smithers-jj-export")
HELPER_BUILT_RELATIVE = Path("target/release/smithers-jj-export")


def helper_binary(root: Path, base: dict[str, str]) -> Path | None:
    """The atomic filesystem helper the CLI shells out to
    (`platform-node/src/AtomicFileSystem.ts`): the configured one, else the
    installed one, else this checkout's release build."""
    configured = base.get(HELPER_VARIABLE)
    for candidate in (Path(configured) if configured else None, HELPER_DEFAULT, root / HELPER_BUILT_RELATIVE):
        if candidate is not None and candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


# The shim's configuration and directory belong to the shim (`plue_docker.py`),
# which the SWE-bench rig's plue transport writes the same way.
SHIM_ENV_NAMES = plue_docker.SHIM_ENV_NAMES
shim_config = plue_docker.shim_config
shim_directory = plue_docker.shim_directory


def container_commands(events: list[dict[str, Any]], container: str) -> dict[str, int]:
    """Commands the agent sent to the task container, and how many exited 0.

    A `bash` `cell-call-started` joined by call id to its `cell-call-settled`.
    The CLI is sealed to `container`, so a call that names no container ran
    there; one that names another was refused and is not counted. Zero
    successes means the agent never reached the task: the trial measured the
    transport, not the model."""
    targeted: set[str] = set()
    attempted = succeeded = 0
    for event in events:
        payload = event["payload"]
        if event["type"] == "control.agent.cell-call-started":
            given = payload.get("input")
            if (isinstance(given, dict) and payload.get("flowName") == "bash"
                    and given.get("container") in (None, container)):
                targeted.add(str(payload.get("callId")))
        elif event["type"] == "control.agent.cell-call-settled" and str(payload.get("callId")) in targeted:
            attempted += 1
            value = payload.get("value")
            if payload.get("outcome") == "success" and isinstance(value, dict) and value.get("exitCode") == 0:
                succeeded += 1
    return {"attempted": attempted, "succeeded": succeeded}


async def container_lost(environment: Any, timeout_sec: int = 180) -> str | None:
    """Why the task container can no longer be graded, or None when it answers.

    Probed once after the run. A container that died mid-run (a plue VM that
    "no longer exists", a removed docker container) leaves the verifier grading
    an empty tree, so the trial is infrastructure, never a score."""
    try:
        result = await environment.exec("true", timeout_sec=timeout_sec)
    except Exception as error:  # noqa: BLE001 - any transport failure means the task is gone
        return f"{type(error).__name__}: {str(error)[:300]}"
    code = getattr(result, "return_code", None)
    if code != 0:
        stderr = (getattr(result, "stderr", "") or "").strip()
        return f"liveness probe exited {code}: {stderr[:300]}"
    return None


def cli_environment(base: dict[str, str], *, auth_mode: str, helper: Path | None = None,
                    shim: Path | None = None, codex_home: Path | None = None,
                    container: str | None = None, cwd: str | None = None) -> dict[str, str]:
    """The environment the CLI runs under.

    The chatgpt mode removes `OPENAI_API_KEY` so the seat can only be served by
    the ChatGPT session: an unset `SMITHERS_OPENAI_AUTH` means api-key
    (`NativeEquipment.ts`), which is exactly the silent fallback this guards
    against. The `test` flow's variables are dropped because no benchmark task
    declares a runner; a stale one from the caller's shell would bind a `test`
    flow against the wrong container. The helper is named explicitly so the
    run does not depend on what `/usr/local/bin` holds.

    `container` seals the run to the task container (`SMITHERS_BASH_CONTAINER`):
    a `bash` call naming no container, which would run on this host beside
    every task's `tests/` and `solution/`, fails with `outside_container`, and
    the file flows (`read`, `grep`, `edit`, `apply_patch`) act on the
    container's files through the same transport, never on this host's.
    `cwd` is where in the container those flows resolve a relative path
    (`SMITHERS_TEST_CWD`, the CLI's name for the repository inside the
    container); without it the sealed CLI offers no file flow. The stock Codex
    arm is sealed the same way by running inside the container.
    """
    env = dict(base)
    for name in ("SMITHERS_TEST_COMMAND", "SMITHERS_TEST_CONTAINER", "SMITHERS_TEST_CWD", "SMITHERS_TEST_TIMEOUT_MS"):
        env.pop(name, None)
    env["SMITHERS_OPENAI_AUTH"] = auth_mode
    env[ASKS_VARIABLE] = ASKS
    if auth_mode == "chatgpt":
        env.pop("OPENAI_API_KEY", None)
    if helper is not None:
        env[HELPER_VARIABLE] = str(helper)
    if shim is not None:
        env["PATH"] = f"{shim}{os.pathsep}{env.get('PATH', '')}"
    if codex_home is not None:
        env["CODEX_HOME"] = str(codex_home)
    if container is not None:
        env["SMITHERS_BASH_CONTAINER"] = container
        if cwd:
            env["SMITHERS_TEST_CWD"] = cwd
    else:
        env.pop("SMITHERS_BASH_CONTAINER", None)
    return env


# Finding and reading the journal belongs to the module that folds it into
# call rows (`calls.py`), which the report reads without this adapter.
JOURNAL_FILES = calls.JOURNAL_FILES
journal_path = calls.journal_path
read_journal = calls.read_journal
_iso = calls.iso


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _own_call(payload: dict[str, Any], requested: Any) -> bool:
    """Whether a `model-settled` is the agent's own call. A call's purpose is
    on its settle when the harness writes it there, else on its request; a
    journal from before either names one made only the agent's own."""
    purpose = payload.get("purpose", requested)
    return not isinstance(purpose, str) or purpose == "frame"


def summarize(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Tokens, calls, route bindings and the run's own verdict, off the journal.

    `usage` and `modelCalls` are the agent's own calls, the figures Harbor
    reads and every earlier report printed. `byPurpose` and `allPurposes`
    add the compaction calls and the judge's readings (`calls.totals`);
    `ledgerTokens`, `ledgerEntries` and `ledgerByPurpose` are the run's own
    count of all of them, `time` is where the wall clock went, and
    `compactions` is one record per compaction.
    """
    usage = {"inputTokens": None, "cachedInputTokens": None, "outputTokens": None, "reasoningTokens": None}
    missing_usage = {name: False for name in usage}
    seat = None
    frames = model_calls = cell_calls = asks_refused = 0
    bindings: list[Any] = []
    efforts: list[str] = []
    status = None
    output = None
    cause = None
    requested = None
    for event in events:
        kind, payload = event["type"], event["payload"]
        if kind == "control.agent.turn-opened":
            frames += 1
            seat = payload.get("seat", seat)
        elif kind == "control.agent.model-requested":
            requested = payload.get("purpose")
            # rc.1 journals the resolved route as `routeId`/`protocolId`/
            # `modelId`; an older host names it `binding`. Either is the proof
            # of which backend served the call, so both are kept.
            binding = {
                key: payload[key]
                for key in ("routeId", "protocolId", "modelId", "binding")
                if payload.get(key) is not None
            }
            if binding and binding not in bindings:
                bindings.append(binding)
            params = payload.get("params")
            effort = params.get("reasoningEffort") if isinstance(params, dict) else None
            if isinstance(effort, str) and effort not in efforts:
                efforts.append(effort)
        elif kind == "control.agent.model-settled":
            if not _own_call(payload, requested):
                continue
            model_calls += 1
            counters = payload.get("usage") or {}
            for name in usage:
                value = counters.get(name)
                if isinstance(value, (int, float)):
                    usage[name] = (usage[name] or 0) + int(value)
                else:
                    missing_usage[name] = True
        elif kind == "control.agent.cell-call-started":
            cell_calls += 1
        elif kind == "control.agent.cell-call-settled":
            if payload.get("flowName") == "ask" and payload.get("outcome") != "success":
                asks_refused += 1
        elif kind == "control.agent.transition-applied":
            transition = payload.get("transition") or {}
            if transition.get("_tag") == "complete":
                output = transition.get("output")
        elif kind.startswith("control.run."):
            status = kind[len("control.run."):]
            if kind == "control.run.failed":
                cause = payload.get("cause")
    for name in usage:
        if missing_usage[name]:
            usage[name] = None
    folded = calls.fold_journal(events)
    return {
        "cause": (cause.split("\n", 1)[0][:500] if isinstance(cause, str) else None),
        "seat": seat,
        "frames": frames,
        "modelCalls": model_calls,
        "calls": cell_calls,
        "asksRefused": asks_refused,
        "usage": usage,
        "byPurpose": folded["byPurpose"],
        "allPurposes": folded["allPurposes"],
        "ledgerTokens": folded["ledgerTokens"],
        "ledgerEntries": folded["ledgerEntries"],
        "ledgerByPurpose": folded["ledgerByPurpose"],
        "time": folded["time"],
        "compactions": folded["compactions"],
        "bindings": bindings,
        "efforts": efforts,
        "status": status,
        "output": output,
        "spanMillis": (events[-1]["at"] - events[0]["at"]) if events else 0,
    }


def trajectory(events: list[dict[str, Any]], *, agent_name: str, agent_version: str, seat: str, instruction: str,
               session_id: str | None, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Folds the harness journal into one ATIF-v1.8 trajectory.

    One `user` step carries the instruction. Each model call the agent made
    becomes one `agent` step: its message is the reply the model settled with,
    its tool calls are the flow calls the cell made, and the observation holds
    each call's result in call order. A frame whose reply held no runnable cell
    asks again, so it is two steps, the first marked `rejected`. Tokens ride
    on the step's metrics and are summed into `final_metrics`, so Harbor's
    usage columns read them back without a per-agent parser.

    The steps and `final_metrics.total_*` are the agent's own calls. Every
    model call of the run, the compaction calls and the judge's readings
    included, is a row of `extra.calls`; `final_metrics.extra` sums the rows
    by purpose and says where the wall clock went (`calls.fold_journal`).
    """
    steps: list[dict[str, Any]] = [{
        "step_id": 1,
        "timestamp": _iso(events[0]["at"]) if events else None,
        "source": "user",
        "message": instruction,
    }]
    turn: dict[str, Any] | None = None
    started: list[dict[str, Any]] = []
    settled: list[dict[str, Any]] = []
    totals = {"prompt": None, "completion": None, "cached": None}
    missing = {"prompt": False, "completion": False, "cached": False}
    requested: dict[str, Any] = {}
    requested_at: int | None = None

    def open_turn(seq: int, at: int) -> None:
        nonlocal turn
        turn = {"seq": seq, "timestamp": _iso(at), "message": "", "cell": None, "metrics": None, "rejected": None}

    def close_turn() -> None:
        nonlocal turn, started, settled
        if turn is None:
            return
        tool_calls = []
        results = []
        for index, call in enumerate(started):
            call_id = f"call-{turn['seq']}-{index}"
            arguments = call.get("input")
            tool_calls.append({
                "tool_call_id": call_id,
                "function_name": str(call.get("flowName") or "?"),
                "arguments": arguments if isinstance(arguments, dict) else {"input": arguments},
            })
            if index < len(settled):
                result = settled[index]
                content = result.get("message") if result.get("outcome") == "failure" else result.get("value")
                results.append({
                    "source_call_id": call_id,
                    "content": _text(content),
                    "extra": {"outcome": result.get("outcome"), "code": result.get("code")},
                })
        step: dict[str, Any] = {
            "step_id": len(steps) + 1,
            "timestamp": turn.get("timestamp"),
            "source": "agent",
            "message": turn.get("message") or "",
        }
        noted = {name: turn[name] for name in ("cell", "rejected") if turn.get(name)}
        if noted:
            step["extra"] = noted
        if tool_calls:
            step["tool_calls"] = tool_calls
        if results:
            step["observation"] = {"results": results}
        if turn.get("metrics"):
            step["metrics"] = turn["metrics"]
        steps.append(step)
        turn = None
        started, settled = [], []

    for event in events:
        kind, payload = event["type"], event["payload"]
        if kind == "control.agent.model-requested":
            requested, requested_at = payload, event["at"]
        if kind == "control.agent.turn-opened":
            close_turn()
            open_turn(event["seq"], event["at"])
        elif turn is None:
            continue
        elif kind == "control.agent.model-settled":
            if not _own_call(payload, requested.get("purpose")):
                continue
            if turn["metrics"] is not None:
                # The frame asked again: this reply is its own call, so its
                # own step. One step per frame lost the first reply's tokens.
                close_turn()
                open_turn(event["seq"], event["at"] if requested_at is None else requested_at)
            counters = payload.get("usage") or {}
            prompt = counters.get("inputTokens")
            completion = counters.get("outputTokens")
            cached = counters.get("cachedInputTokens")
            for key, value in (("prompt", prompt), ("completion", completion), ("cached", cached)):
                if isinstance(value, (int, float)):
                    totals[key] = (totals[key] or 0) + int(value)
                else:
                    missing[key] = True
            turn["message"] = _text(payload.get("text"))
            turn["metrics"] = {
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "cached_tokens": cached,
                "extra": {
                    "reasoning_tokens": counters.get("reasoningTokens"),
                    "duration_millis": payload.get("durationMillis"),
                    "purpose": "frame",
                    # The settle's own keys where the journal carries them:
                    # position files a call under the request before it.
                    "frame": payload.get("frame", requested.get("frame")),
                    "attempt": payload.get("attempt", requested.get("attempt")),
                },
            }
            requested, requested_at = {}, None
        elif kind == "control.agent.cell-rejected-in-frame":
            turn["rejected"] = {"code": payload.get("code"), "message": payload.get("message")}
        elif kind == "control.agent.cell-produced":
            # The journal writes the cell flat: `{language, digest, text}`.
            turn["cell"] = _text(payload.get("text"))
        elif kind == "control.agent.cell-call-started":
            started.append(payload)
        elif kind == "control.agent.cell-call-settled":
            settled.append(payload)
    close_turn()
    for key in totals:
        if missing[key]:
            totals[key] = None
    folded = calls.fold_journal(events)

    return {
        "schema_version": "ATIF-v1.8",
        "session_id": session_id,
        "agent": {"name": agent_name, "version": agent_version, "model_name": seat, "extra": extra or {}},
        "steps": steps,
        "extra": {"calls": folded["calls"]},
        "final_metrics": {
            "total_prompt_tokens": totals["prompt"],
            "total_completion_tokens": totals["completion"],
            "total_cached_tokens": totals["cached"],
            "total_steps": len(steps),
            # ATIF's FinalMetrics forbids unknown keys; custom aggregates go in `extra`.
            "extra": {
                "cached_share": (
                    totals["cached"] / totals["prompt"]
                    if totals["prompt"] is not None and totals["prompt"] > 0 and totals["cached"] is not None
                    else None
                ),
                "byPurpose": folded["byPurpose"],
                "allPurposes": folded["allPurposes"],
                "ledgerTokens": folded["ledgerTokens"],
                "ledgerEntries": folded["ledgerEntries"],
                "ledgerByPurpose": folded["ledgerByPurpose"],
                "time": folded["time"],
                "compactions": folded["compactions"],
            },
        },
    }


def harness_revision(root: Path) -> str | None:
    """The commit the checkout under `root` is at, from jj where it is a jj
    workspace and from git otherwise. jj reads the repository without
    snapshotting: a stale or orphaned working copy (another workspace's
    `jj op abandon`) refuses every snapshotting command, and a trial must not
    record a null revision for it."""
    for command in (
        ["jj", "--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"],
        ["git", "rev-parse", "HEAD"],
    ):
        try:
            result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return None


def subject_fingerprint(root: Path) -> dict[str, Any] | None:
    """The SWE-bench rig's fingerprint of the exact CLI bytes, when it can be
    taken. Refusals are recorded, never hidden."""
    script = root / SUBJECT_RELATIVE
    if not script.is_file():
        return None
    try:
        result = subprocess.run(["node", str(script), "--json"], cwd=root, capture_output=True, text=True, timeout=300)
        document = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    return {"stamp": document.get("stamp"), "head": document.get("head"), "refusals": document.get("refusals", [])}


TRANSPORTS = ("docker", "harbor")


def environment_kind(environment: Any) -> str | None:
    """The runner's name for the environment (`docker`, `runta`, `plue`, ...).
    Harbor answers with an enum, plue with a string."""
    kind = getattr(environment, "type", None)
    if not callable(kind):
        return None
    try:
        value = kind()
    except Exception:  # noqa: BLE001 - an environment that cannot name itself is not local docker
        return None
    return str(getattr(value, "value", value))


def transport_of(environment: Any, asked: str | None) -> str:
    """`docker` when the task is a container on this host's daemon, else
    `harbor`: the runner's own `environment.exec`. `asked` overrides."""
    if asked is not None:
        if asked not in TRANSPORTS:
            raise ValueError(f"transport must be one of {', '.join(TRANSPORTS)}; got {asked!r}")
        return asked
    return "docker" if environment_kind(environment) in (None, "docker") else "harbor"


def harbor_container_name(session_id: str) -> str:
    """The name the prompt and the seal use for a task reached through the
    runner's environment: no daemon knows it, the bridge answers for it."""
    return "task-" + re.sub(r"[^A-Za-z0-9_.-]", "-", session_id)[:48]


def plue_workspace_of(environment: Any) -> str | None:
    """The workspace id when `environment` is a running plue environment."""
    kind = getattr(environment, "type", None)
    if not callable(kind) or kind() != "plue":
        return None
    return str(getattr(environment, "_workspace_id", "") or "") or None


def failure_cause(log_text: str, summary: dict[str, Any]) -> str | None:
    """What the run failed on: the journal's `control.run.failed` cause,
    else the CLI's last `status: failed` line, else nothing."""
    if summary.get("cause"):
        return summary["cause"]
    for line in reversed(log_text.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            document = json.loads(line)
        except ValueError:
            continue
        if isinstance(document, dict) and document.get("status") == "failed" and document.get("cause"):
            return str(document["cause"]).split("\n", 1)[0][:500]
    return None


def parked(summary: dict[str, Any]) -> str | None:
    """Why the run is waiting rather than finished, when it is. A benchmark
    host answers no wait, so a run that ends at one was held by the harness."""
    status = summary.get("status")
    if isinstance(status, str) and status.startswith("waiting"):
        return f"run ended at {status} after {summary.get('frames')} frames; nobody answers a benchmark run"
    return None


def verdict(log_text: str, summary: dict[str, Any], events: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    """(`seat` | `infra` | None, cause): whether the run's end was the
    infrastructure's and not the model's. A `quota_exceeded` retry in the
    journal is a seat verdict even when the run went on to fail otherwise."""
    cause = failure_cause(log_text, summary)
    kind = accounts.classify_cause(cause)
    if kind is None:
        for event in events:
            if event["type"] == "control.agent.model-retried" and event["payload"].get("code") == "quota_exceeded":
                return "seat", f"quota_exceeded: model-retried (attempt {event['payload'].get('attempt')})"
        for line in log_text.splitlines():
            if accounts.mentions_usage_limit(line):
                return "seat", line.strip()[:500]
    return kind, cause


# The CLI is stopped half a minute inside the runner's agent timeout: the time
# this adapter needs to fold the journal, write the record, probe the task and
# commit the work before the runner cancels `run()`. Measured 2026-11-11 on a
# host at load 115: 2.4 s. It was a minute, 7% of a 900 s task the stock arm
# keeps.
BUDGET_MARGIN_SEC = 30.0
BUDGET_FLOOR_SEC = 60.0
# When the runner cancels `run()` anyway, the CLI gets SIGTERM and this long to
# exit before SIGKILL.
CANCEL_GRACE_SEC = 30.0


class BudgetUnknown(Exception):
    """No `budget_sec` was given and the agent timeout the runner enforces on
    this trial could not be found.

    There is no default. The 2026-09-26 runs fell back to 3,600 s here while
    the stock Codex arm had each DeepSWE task's own 5,400 s, and 14 of 109
    scored trials ended at the 3,600 s cap: a budget nobody chose is an
    unequal pair that still prints a score. Raised before the CLI starts, so
    a refusal costs no model call, and the message names the way out."""


def _seconds(value: Any) -> float | None:
    """A positive number of seconds, else None; the runners read 0 as unset."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    return float(value)


def trial_config(logs_dir: Path) -> dict[str, Any] | None:
    """The runner's own record of how this trial was configured: `config.json`
    beside the agent's logs directory, which Harbor (`Trial._init_result`) and
    Pier (`Trial.run`) both write before the agent is set up. It holds the
    operator's timeout override, cap and multipliers and nothing of the task;
    `report.py` reads the same fields from it."""
    try:
        document = json.loads((logs_dir.parent / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def task_agent_timeout(environment: Any) -> float | None:
    """`[agent] timeout_sec` from the task's `task.toml`.

    This is the one thing the adapter reads from the task directory, and one
    number of it, because neither runner hands a non-oracle agent its timeout:
    it is `Trial._agent_timeout_sec` in Harbor 0.23.0 and
    `TrialExecution.agent_timeout_sec` in Pier 0.3.1, passed only to the
    `asyncio.wait_for` around `run()`, and `environment.task_env_config` is the
    `[environment]` table alone. The file is found beside the environment
    directory the runner gave the environment, where `plue_env.py` already
    reads the `[verifier]` table. `tests/`, `solution/` and the instruction
    file are never opened, and the number never reaches the prompt
    (`fixtures/check_budget.py`).
    """
    directory = getattr(environment, "environment_dir", None)
    if directory is None:
        return None
    try:
        import tomllib
        document = tomllib.loads((Path(directory).parent / "task.toml").read_text(encoding="utf-8"))
    except (ImportError, OSError, ValueError):
        return None
    table = document.get("agent")
    return _seconds(table.get("timeout_sec")) if isinstance(table, dict) else None


def enforced_agent_timeout(logs_dir: Path, environment: Any) -> tuple[float, str]:
    """The agent timeout the runner enforces on this trial, and where its base
    came from, by the rule Harbor (`Trial._compute_agent_timeout_sec`) and
    Pier (`TrialExecution._resolve_agent_timeout`) share:

        min(override or the task's timeout, cap or inf) * multiplier

    The multiplier is `--agent-timeout-multiplier` when set, else
    `--timeout-multiplier`. The task's timeout is read only when the trial
    does not override it."""
    way_out = "pass --ak budget_sec=<seconds> to choose the budget on the record"
    config = trial_config(logs_dir)
    if config is None:
        raise BudgetUnknown(
            f"{logs_dir.parent / 'config.json'} is not a trial config, so the timeout override and "
            f"multipliers of this trial are unknown; {way_out}")
    knobs = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    source = "override_timeout_sec"
    base = _seconds(knobs.get("override_timeout_sec"))
    if base is None:
        source = "task.toml"
        base = task_agent_timeout(environment)
    if base is None:
        raise BudgetUnknown(
            f"no [agent] timeout_sec in the task.toml beside {getattr(environment, 'environment_dir', None)} "
            f"and no override in the trial config; {way_out}")
    cap = _seconds(knobs.get("max_timeout_sec")) or float("inf")
    multiplier = config.get("agent_timeout_multiplier")
    if multiplier is None:
        multiplier = config.get("timeout_multiplier")
    return min(base, cap) * (1.0 if multiplier is None else multiplier), source


def resolve_budget(budget_sec: float | None, agent_timeout_sec: float | None, logs_dir: Path,
                   environment: Any) -> dict[str, Any]:
    """The run's wall-clock budget, where it came from, and the agent timeout
    it was cut from, as the trial records them.

        budget_sec            `--ak budget_sec=N`, used as given
        agent_timeout_sec     a runner that hands the agent its timeout
        override_timeout_sec  the trial's override of the task's timeout
        task.toml             the task's own `[agent] timeout_sec`
    """
    if budget_sec is not None:
        return {"budgetSec": budget_sec, "budgetSource": "budget_sec", "agentTimeoutSec": None}
    if agent_timeout_sec:
        timeout, source = agent_timeout_sec, "agent_timeout_sec"
    else:
        timeout, source = enforced_agent_timeout(logs_dir, environment)
    return {"budgetSec": max(BUDGET_FLOOR_SEC, timeout - BUDGET_MARGIN_SEC), "budgetSource": source,
            "agentTimeoutSec": timeout}


async def run_child(argv: list[str], *, timeout: float, grace: float = CANCEL_GRACE_SEC,
                    capture_output: bool = False, **options: Any) -> subprocess.CompletedProcess:
    """`subprocess.run(argv, text=True, timeout=timeout, ...)` that a cancelled
    trial reaches. Harbor cancels `run()` at the agent timeout or a job stop;
    a thread blocked in `subprocess.run` outlived that, and on nyc-02
    (2026-10-14) its CLI held the runner open until it was killed by hand.
    Here the child gets SIGTERM, `grace` seconds, then SIGKILL, and the
    cancellation is re-raised."""
    if capture_output:
        options.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child = await asyncio.create_subprocess_exec(*argv, **options)
    try:
        stdout, stderr = await asyncio.wait_for(child.communicate(), timeout)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            child.kill()
        await child.communicate()
        raise subprocess.TimeoutExpired(argv, timeout) from None
    except asyncio.CancelledError:
        with contextlib.suppress(ProcessLookupError):
            child.terminate()
        try:
            await asyncio.wait_for(child.communicate(), grace)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                child.kill()
            await child.communicate()
        raise
    return subprocess.CompletedProcess(argv, child.returncode, _decoded(stdout), _decoded(stderr))


def _decoded(data: bytes | None) -> str | None:
    """What `text=True` makes of a child's output: the locale's encoding and
    universal newlines."""
    if data is None:
        return None
    return data.decode(locale.getpreferredencoding(False)).replace("\r\n", "\n").replace("\r", "\n")


class SmithersAgent(BaseAgent):
    """The Smithers flows harness, driven from the host against the task container."""

    if AgentCapabilities is not None:
        # Harbor 0.25 refuses `reasoning_effort` for an agent that does not
        # declare it; 0.23 has no such field and forbids unknown ones.
        capabilities = AgentCapabilities(atif=True, **(
            {"reasoning_effort": True} if "reasoning_effort" in AgentCapabilities.model_fields else {}))
    else:  # Pier still reads the flag
        SUPPORTS_ATIF = True

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *,
        agent_timeout_sec: float | None = None,
        commit: Any = None,
        cwd: str | None = None,
        budget_sec: Any = None,
        reasoning_effort: Any = None,
        transport: str | None = None,
        **kwargs: Any,
    ) -> None:
        # Harbor hands the task and trial paths to every agent; this one never
        # opens them, which is how it stays blind to tests/ and solution/. The
        # one read of the task directory is `task_agent_timeout`: one number.
        kwargs.pop("task_dir", None)
        kwargs.pop("trial_paths", None)
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._agent_timeout_sec = float(agent_timeout_sec) if agent_timeout_sec is not None else None
        self._commit = _truthy(commit) if commit is not None else FRAMEWORK == "pier"
        self._cwd_override = cwd
        self._budget_sec = float(budget_sec) if budget_sec is not None else None
        self._effort = effort_of(reasoning_effort) if reasoning_effort is not None else DEFAULT_EFFORT
        if transport is not None and transport not in TRANSPORTS:
            raise ValueError(f"transport must be one of {', '.join(TRANSPORTS)}; got {transport!r}")
        self._transport_asked = transport
        self._transport = "docker"
        self.root = Path(os.environ.get("SMITHERS_ROOT") or HERE.parents[5]).resolve()
        self.docker = os.environ.get("SMITHERS_BENCH_DOCKER", "docker")
        self.seat = seat_of(self.model_name)
        provider = self.seat.split(":", 1)[0]
        configured = os.environ.get("SMITHERS_OPENAI_AUTH", "").strip()
        self.auth_mode = configured or ("chatgpt" if provider == "openai" else "api-key")
        self._summary: dict[str, Any] | None = None
        # What this checkout is, read once in `setup()`: the runner's agent
        # timeout covers `run()` alone, and these took 13.6 s of it.
        self._revision: str | None = None
        self._subject: dict[str, Any] | None = None
        self._plue = False
        self._pool: accounts.Pool | None = None
        self._account: accounts.Account | None = None

    @staticmethod
    def name() -> str:
        return "smithers"

    def version(self) -> str | None:
        manifest = self.root / "packages/smithers/package.json"
        try:
            return str(json.loads(manifest.read_text())["version"])
        except (OSError, ValueError, KeyError):
            return None

    def network_allowlist(self):  # Pier: the container needs no egress, the model is called from the host
        try:
            from pier.models.agent.network import NetworkAllowlist  # type: ignore[import-not-found]
        except ImportError:
            return None
        return NetworkAllowlist()

    async def setup(self, environment: BaseEnvironment) -> None:
        # Without the key the CLI judges on a subscription seat instead of
        # Jev, and that trial is not comparable; refuse it before any model call.
        if not os.environ.get("AI_GATEWAY_API_KEY"):
            raise RuntimeError("AI_GATEWAY_API_KEY is not set: the Smithers arm is judged by Jev; export it before a trial")
        built = self.root / BUILT_RELATIVE
        if not built.is_file():
            raise RuntimeError(
                f"{built} is missing: build the CLI first (cd {self.root} && pnpm --filter @smthrs/cli build)"
            )
        if helper_binary(self.root, dict(os.environ)) is None:
            raise RuntimeError(
                f"no atomic filesystem helper: build it with (cd {self.root} && cargo build --release "
                f"-p smithers-ffi --bin smithers-jj-export) or set {HELPER_VARIABLE}"
            )
        self._revision = await asyncio.to_thread(harness_revision, self.root)
        self._subject = await asyncio.to_thread(subject_fingerprint, self.root)
        if self.auth_mode == "chatgpt":
            self._pool = accounts.Pool.from_environment()
            if self._pool.accounts:
                # Waits here while the pool is paused, before any agent work.
                self._account = await asyncio.to_thread(self._pool.lease, self.logs_dir.parent.name)
            store = (self._account.auth if self._account
                     else Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "auth.json")
            if not store.is_file():
                raise RuntimeError(f"SMITHERS_OPENAI_AUTH=chatgpt but {store} does not exist; run `codex login`")

    def container_of(self, environment: BaseEnvironment) -> str:
        """The task container's id: the plue workspace id on Smithers Cloud,
        else the container found through the compose project Harbor named
        after the environment's session id."""
        override = os.environ.get("SMITHERS_BENCH_CONTAINER")
        if override:
            self._transport = self._transport_asked or "docker"
            return override
        workspace_id = plue_workspace_of(environment)
        if workspace_id:
            self._plue = True
            self._transport = "plue"
            return workspace_id
        self._transport = transport_of(environment, self._transport_asked)
        if self._transport == "harbor":
            return harbor_container_name(environment.session_id)
        project = compose_project_name(environment.session_id)
        result = subprocess.run(
            [self.docker, "ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
             "--filter", "label=com.docker.compose.service=main"],
            capture_output=True, text=True, timeout=60, check=True,
        )
        ids = result.stdout.split()
        if len(ids) != 1:
            raise RuntimeError(f"expected one running `main` container for compose project {project}, found {ids}")
        return ids[0]

    async def container_cwd(self, environment: BaseEnvironment) -> str:
        """Where the task's commands run: `--ak cwd`, else the task's declared
        `workdir`, else the directory the environment itself starts a command
        in (the image's WORKDIR), asked once with `pwd`. `/app` only when the
        environment cannot say."""
        if self._cwd_override:
            return self._cwd_override
        config = getattr(environment, "task_env_config", None)
        workdir = getattr(config, "workdir", None)
        # On plue the environment read the image's WORKDIR from its registry.
        declared = workdir or getattr(environment, "_plue_workdir", None)
        if declared:
            return declared
        try:
            result = await environment.exec("pwd", timeout_sec=60)
        except Exception:  # noqa: BLE001 - a transport that cannot answer leaves the default
            return "/app"
        answer = (getattr(result, "stdout", "") or "").strip().splitlines()
        if getattr(result, "return_code", 1) == 0 and answer and answer[-1].startswith("/"):
            return answer[-1]
        return "/app"

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        budget = resolve_budget(self._budget_sec, self._agent_timeout_sec, self.logs_dir, environment)
        container = self.container_of(environment)
        cwd = await self.container_cwd(environment)
        helper = helper_binary(self.root, dict(os.environ))
        kept = self.logs_dir / "workspace"
        if kept.exists():
            shutil.rmtree(kept)
        # One attempt per trial. A seat that runs dry is not the model's
        # failure, but the attempt already changed the task container and
        # spent part of the runner's agent timeout, so it is never re-run
        # here: the account leaves rotation and `SeatExhausted` (infra)
        # makes the runner re-run the trial in a fresh environment. A route
        # fault raises so the runner records an exception, never a reward.
        #
        # The CLI runs in a scratch directory outside any checkout: it
        # walks up from its working directory for project state, and a
        # jobs directory inside this repository would put the run under
        # the repository's own `.smithers`. It is moved under the trial's
        # logs when the run is over.
        workspace = Path(tempfile.mkdtemp(prefix="smithers-bench-"))
        flow_dir = workspace / ".smithers" / "flows" / FLOW_NAME
        flow_dir.mkdir(parents=True)
        (flow_dir / "flow.mdx").write_text(
            render_prompt(instruction, seat=self.seat, cwd=cwd, commit=self._commit, effort=self._effort),
            encoding="utf-8",
        )
        worker_dir = workspace / ".smithers" / "flows" / WORKER_NAME
        worker_dir.mkdir(parents=True)
        (worker_dir / "flow.mdx").write_text(render_worker(cwd=cwd), encoding="utf-8")
        (workspace / SEAL_FILE).write_text(json.dumps({"container": container, "unnamedBash": UNNAMED_BASH}))
        shim_home = Path(tempfile.mkdtemp(prefix="smithers-shim-")) if self._plue else None
        shim = shim_directory(shim_home, shim_config(dict(os.environ), getattr(environment, "_plue_workdir", None))) \
            if shim_home else None
        # Off this host's daemon the task is reached the way the runner reaches
        # it: the bridge answers the CLI's `docker exec` with `environment.exec`.
        bridge = harbor_exec.Bridge(environment, container, log=self.logs_dir / "bridge.jsonl") \
            if self._transport == "harbor" else None
        if bridge is not None:
            await bridge.__aenter__()
            shim = bridge.bin
        env = cli_environment(dict(os.environ), auth_mode=self.auth_mode, helper=helper, shim=shim,
                              codex_home=self._account.home if self._account else None,
                              container=container, cwd=cwd)
        record: dict[str, Any] = {
            "framework": FRAMEWORK,
            "seat": self.seat,
            "authMode": self.auth_mode,
            "account": self._account.label if self._account else None,
            "transport": self._transport,
            "openaiApiKeyInCliEnvironment": "OPENAI_API_KEY" in env,
            "asks": env.get(ASKS_VARIABLE),
            "helper": str(helper) if helper else None,
            "container": container,
            "unnamedBash": UNNAMED_BASH,
            "cwd": cwd,
            "commit": self._commit,
            "effort": self._effort,
            **budget,
            "harnessRoot": str(self.root),
            "harnessRevision": self._revision,
            "subject": self._subject,
            "startedAt": _iso(int(time.time() * 1000)),
        }
        (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))

        started = time.monotonic()
        try:
            exit_status = await self._drive(workspace, env, budget["budgetSec"])
        finally:
            if shim_home is not None:
                shutil.rmtree(shim_home, ignore_errors=True)
            if bridge is not None:
                await bridge.__aexit__(None, None, None)
                record["bridge"] = {"calls": bridge.calls, "failures": bridge.failures, "execMs": bridge.exec_ms}
        wall = time.monotonic() - started
        shutil.move(str(workspace), str(kept))
        workspace = kept

        journal = journal_path(workspace / ".flows")
        events = read_journal(journal) if journal is not None else []
        summary = summarize(events)
        try:
            log_text = (self.logs_dir / "smithers-run.log").read_text(errors="replace")
        except OSError:
            log_text = ""
        kind, cause = verdict(log_text, summary, events)
        reached = container_commands(events, container)
        # How far the one `up` process got: a run it started, or only a plan.
        phase = "run" if any(event["type"].startswith("control.run.") for event in events) else "plan"
        record.update({
            "verdict": kind,
            "cause": cause,
            "containerCommands": reached,
            "phase": phase,
            "exitStatus": exit_status,
            "wallSec": round(wall, 3),
            "journal": str(journal) if journal is not None else None,
            "run": summary,
            "finishedAt": _iso(int(time.time() * 1000)),
        })
        (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))

        reset_at = None
        if kind == "seat":
            reset_at = accounts.reset_time_of(cause or "") or accounts.reset_time_of(log_text)
            if self._account is not None and self._pool is not None:
                self._pool.disable(self._account.label, cause or "usage limit", reset_at)

        if self._commit:
            record["commitResult"] = await self._commit_work(environment, cwd)
            (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))
        if events:
            document = trajectory(
                events,
                agent_name=self.name(),
                agent_version=self.version() or "unknown",
                seat=self.seat,
                instruction=instruction,
                session_id=getattr(self, "session_id", None) or environment.session_id,
                extra={"authMode": self.auth_mode, "bindings": summary["bindings"],
                       "harnessRevision": record["harnessRevision"], "account": record["account"]},
            )
            (self.logs_dir / "trajectory.json").write_text(json.dumps(document, indent=2))

        context.n_input_tokens = summary["usage"]["inputTokens"]
        context.n_cache_tokens = summary["usage"]["cachedInputTokens"]
        context.n_output_tokens = summary["usage"]["outputTokens"]
        # The subscription is billed by the month, not the token, so no USD.
        context.cost_usd = None
        context.metadata = {
            "seat": self.seat,
            "auth_mode": self.auth_mode,
            "account": record["account"],
            "transport": record["transport"],
            "verdict": kind,
            "cause": cause,
            "bindings": summary["bindings"],
            # Asked for, then what each model call was really made at.
            "effort": self._effort,
            "efforts": summary["efforts"],
            "harness_revision": record["harnessRevision"],
            "subject": (record["subject"] or {}).get("stamp"),
            "budget_sec": budget["budgetSec"],
            "budget_source": budget["budgetSource"],
            "agent_timeout_sec": budget["agentTimeoutSec"],
            "wall_sec": record["wallSec"],
            "exit_status": exit_status,
            "phase": phase,
            "run_status": summary["status"],
            "frames": summary["frames"],
            "calls": summary["calls"],
            "container_commands": reached,
        }
        self._summary = summary
        held = parked(summary)
        if held is not None:
            raise accounts.RunParked(held)
        if kind == "infra":
            raise accounts.ModelRouteError(cause or "model route failed")
        if kind == "seat":
            raise accounts.SeatExhausted(record["account"] or "?", cause or "usage limit", reset_at)
        if reached["succeeded"] == 0:
            raise accounts.ContainerUnreachable(
                f"no command reached {container} with exit 0 ({reached['attempted']} attempted)")
        lost = await container_lost(environment)
        if lost is not None:
            record["containerLost"] = lost
            (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))
            raise accounts.ContainerUnreachable(f"task container {container} gone after the run: {lost}")

    def _cli(self, *args: str) -> list[str]:
        return ["node", str(self.root / CLI_RELATIVE), "--json", *args]

    async def _drive(self, workspace: Path, env: dict[str, str], budget: float,
                     grace: float = CANCEL_GRACE_SEC) -> int:
        """`up`: plan, approve and run the flow in one CLI process, and its
        exit status. A cancelled trial stops it (`run_child`).

        One process, not `plan`, `approve` and `run` in three: every CLI start
        loads the whole host, and on 2026-11-11 the three starts took 45 s of
        a 900 s task before the first model call. `up` approves at run scope,
        as `approve --scope run` did, and only a flow that declares its
        capabilities, which `prompt.md` does."""
        with (self.logs_dir / "smithers-run.log").open("a", encoding="utf-8") as log:
            try:
                run = await run_child(self._cli("up", FLOW_NAME), cwd=workspace, env=env,
                                      stdout=log, stderr=subprocess.STDOUT, timeout=budget, grace=grace)
            except subprocess.TimeoutExpired:
                log.write(f"\nsmithers_agent: run exceeded its {budget:.0f}s budget and was killed\n")
                return 124
            return run.returncode

    async def _commit_work(self, environment: BaseEnvironment, cwd: str) -> dict[str, Any]:
        """Commit whatever the run left, so a grader that reads HEAD sees it.
        A model that already committed leaves nothing to add and this is a
        no-op; nothing here changes file contents."""
        command = (
            "git add -A && "
            "(git diff --cached --quiet && echo 'smithers_agent: nothing left to commit' || "
            "git -c user.name=smithers -c user.email=smithers@localhost commit -q -m 'smithers: task work' "
            "&& echo 'smithers_agent: committed remaining work')"
        )
        result = await environment.exec(command=command, cwd=cwd, timeout_sec=300)
        return {"returnCode": result.return_code, "stdout": (result.stdout or "")[-2000:],
                "stderr": (result.stderr or "")[-2000:]}

"""The Smithers flows harness as a Harbor (and Pier) external agent.

    harbor run -p <tasks> -a evals.harbor.smithers_agent:SmithersAgent -m openai/gpt-6-sol
    pier run -p <tasks> --agent-import-path evals.harbor.smithers_agent:SmithersAgent -m openai/gpt-6-sol

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
                        fingerprint, wall clock, tokens, exit status
    trajectory.json     ATIF-v1.8 trajectory folded from the harness journal
    smithers-run.log    the CLI's own stdout and stderr
    workspace/          the flow file and `.flows/control.db`, the journal itself

The chatgpt route is proven, not assumed: when the seat authenticates through
the ChatGPT subscription the CLI is started with `OPENAI_API_KEY` removed from
its environment, so an api-key fallback cannot succeed silently, and the
journal's `model-requested` binding is copied into `smithers-run.json`.

Environment:

    SMITHERS_ROOT          the Smithers checkout to run; default: this file's
    SMITHERS_OPENAI_AUTH   `chatgpt` (default for openai seats) or `api-key`
    SMITHERS_BENCH_DOCKER  the docker CLI; default `docker`

Agent kwargs (`--ak key=value`):

    commit=1        commit the container's repository after the run (DeepSWE
                    grades `git diff base..HEAD`; default on under Pier)
    cwd=/app        working directory inside the container; default: the
                    task's `workdir`, else `/app`
    budget_sec=N    wall-clock budget for the run; default: the trial's agent
                    timeout minus a minute, else 3600
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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
CLI_RELATIVE = Path("packages/smithers/bin/smithers.mjs")
BUILT_RELATIVE = Path("packages/smithers/dist/esm/bin.js")
SUBJECT_RELATIVE = Path("evals/swebench/lib/subject.mjs")
FLOW_NAME = "task"

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
    """`openai/gpt-6-sol` (Harbor's spelling) to `openai:gpt-6-sol` (the CLI's)."""
    if not model_name:
        raise ValueError("SmithersAgent needs a model, e.g. -m openai/gpt-6-sol")
    if "/" in model_name:
        provider, model = model_name.split("/", 1)
        return f"{provider}:{model}"
    if ":" in model_name:
        return model_name
    return f"openai:{model_name}"


def render_prompt(instruction: str, *, seat: str, container: str, cwd: str, commit: bool) -> str:
    """The one flow file, with the instruction verbatim."""
    template = PROMPT_PATH.read_text(encoding="utf-8")
    return (
        template.replace("{{seat}}", seat)
        .replace("{{container}}", container)
        .replace("{{cwd}}", cwd)
        .replace("{{commit}}", COMMIT_PARAGRAPH if commit else "")
        .replace("{{instruction}}", instruction.strip() + "\n")
    )


HELPER_VARIABLE = "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"
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


def cli_environment(base: dict[str, str], *, auth_mode: str, helper: Path | None = None) -> dict[str, str]:
    """The environment the CLI runs under.

    The chatgpt mode removes `OPENAI_API_KEY` so the seat can only be served by
    the ChatGPT session: an unset `SMITHERS_OPENAI_AUTH` means api-key
    (`NativeEquipment.ts`), which is exactly the silent fallback this guards
    against. The `test` flow's variables are dropped because no benchmark task
    declares a runner; a stale one from the caller's shell would bind a `test`
    flow against the wrong container. The helper is named explicitly so the
    run does not depend on what `/usr/local/bin` holds.
    """
    env = dict(base)
    for name in ("SMITHERS_TEST_COMMAND", "SMITHERS_TEST_CONTAINER", "SMITHERS_TEST_CWD", "SMITHERS_TEST_TIMEOUT_MS"):
        env.pop(name, None)
    env["SMITHERS_OPENAI_AUTH"] = auth_mode
    if auth_mode == "chatgpt":
        env.pop("OPENAI_API_KEY", None)
    if helper is not None:
        env[HELPER_VARIABLE] = str(helper)
    return env


JOURNAL_FILES = ("control.db", "engine.db")


def journal_path(flows_dir: Path) -> Path | None:
    """The database under `.flows/` that holds the agent's control events.

    rc.1 writes them to `control.db`; the SWE-bench rig's archived journals
    are `engine.db`. Whichever file carries a `control.agent.*` row is the
    journal; a file that exists but carries none is not it.
    """
    for name in JOURNAL_FILES:
        candidate = flows_dir / name
        if not candidate.is_file():
            continue
        try:
            connection = sqlite3.connect(f"file:{candidate}?mode=ro", uri=True)
            try:
                row = connection.execute(
                    "select 1 from flows_journal_events where event_type like 'control.agent.%' limit 1"
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error:
            continue
        if row is not None:
            return candidate
    return None


def read_journal(path: Path) -> list[dict[str, Any]]:
    """Every event of the run's journal, in sequence, payloads decoded."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "select seq, emitted_at_ms, event_type, payload_json from flows_journal_events order by seq"
        ).fetchall()
    finally:
        connection.close()
    events = []
    for seq, emitted_at_ms, event_type, payload_json in rows:
        try:
            payload = json.loads(payload_json)
        except ValueError:
            payload = {}
        events.append({"seq": seq, "at": emitted_at_ms, "type": event_type, "payload": payload if isinstance(payload, dict) else {}})
    return events


def _iso(millis: int | None) -> str | None:
    if millis is None:
        return None
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def summarize(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Tokens, calls, route bindings and the run's own verdict, off the journal."""
    usage = {"inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningTokens": 0}
    seat = None
    frames = model_calls = calls = 0
    bindings: list[Any] = []
    status = None
    output = None
    for event in events:
        kind, payload = event["type"], event["payload"]
        if kind == "control.agent.turn-opened":
            frames += 1
            seat = payload.get("seat", seat)
        elif kind == "control.agent.model-requested":
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
        elif kind == "control.agent.model-settled":
            model_calls += 1
            counters = payload.get("usage") or {}
            for name in usage:
                value = counters.get(name)
                if isinstance(value, (int, float)):
                    usage[name] += int(value)
        elif kind == "control.agent.cell-call-started":
            calls += 1
        elif kind == "control.agent.transition-applied":
            transition = payload.get("transition") or {}
            if transition.get("_tag") == "complete":
                output = transition.get("output")
        elif kind.startswith("control.run."):
            status = kind[len("control.run."):]
    return {
        "seat": seat,
        "frames": frames,
        "modelCalls": model_calls,
        "calls": calls,
        "usage": usage,
        "bindings": bindings,
        "status": status,
        "output": output,
        "spanMillis": (events[-1]["at"] - events[0]["at"]) if events else 0,
    }


def trajectory(events: list[dict[str, Any]], *, agent_name: str, agent_version: str, seat: str, instruction: str,
               session_id: str | None, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Folds the harness journal into one ATIF-v1.8 trajectory.

    One `user` step carries the instruction. Each model turn becomes one `agent`
    step: its message is the reply the model settled with, its tool calls are
    the flow calls the cell made, and the observation holds each call's result
    in call order. Tokens ride on the step's metrics and are summed into
    `final_metrics`, so Harbor's usage columns read them back without a
    per-agent parser.
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
    totals = {"prompt": 0, "completion": 0, "cached": 0}

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
        if turn.get("cell"):
            step["extra"] = {"cell": turn["cell"]}
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
        if kind == "control.agent.turn-opened":
            close_turn()
            turn = {"seq": event["seq"], "timestamp": _iso(event["at"]), "message": "", "cell": None, "metrics": None}
        elif turn is None:
            continue
        elif kind == "control.agent.model-settled":
            counters = payload.get("usage") or {}
            prompt = int(counters.get("inputTokens") or 0)
            completion = int(counters.get("outputTokens") or 0)
            cached = int(counters.get("cachedInputTokens") or 0)
            totals["prompt"] += prompt
            totals["completion"] += completion
            totals["cached"] += cached
            turn["message"] = _text(payload.get("text"))
            turn["metrics"] = {
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "cached_tokens": cached,
                "extra": {
                    "reasoning_tokens": int(counters.get("reasoningTokens") or 0),
                    "duration_millis": payload.get("durationMillis"),
                },
            }
        elif kind == "control.agent.cell-produced":
            cell = payload.get("cell") or {}
            turn["cell"] = cell.get("text") if isinstance(cell, dict) else _text(cell)
        elif kind == "control.agent.cell-call-started":
            started.append(payload)
        elif kind == "control.agent.cell-call-settled":
            settled.append(payload)
    close_turn()

    return {
        "schema_version": "ATIF-v1.8",
        "session_id": session_id,
        "agent": {"name": agent_name, "version": agent_version, "model_name": seat, "extra": extra or {}},
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": totals["prompt"],
            "total_completion_tokens": totals["completion"],
            "total_cached_tokens": totals["cached"],
            "total_steps": len(steps),
        },
    }


def harness_revision(root: Path) -> str | None:
    """The commit the checkout under `root` is at, from jj where it is a jj
    workspace and from git otherwise."""
    for command in (
        ["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"],
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


class SmithersAgent(BaseAgent):
    """The Smithers flows harness, driven from the host against the task container."""

    if AgentCapabilities is not None:
        capabilities = AgentCapabilities(atif=True)
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
        **kwargs: Any,
    ) -> None:
        # Harbor hands the task and trial paths to every agent; this one never
        # opens them, which is how it stays blind to tests/ and solution/.
        kwargs.pop("task_dir", None)
        kwargs.pop("trial_paths", None)
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._agent_timeout_sec = agent_timeout_sec
        self._commit = _truthy(commit) if commit is not None else FRAMEWORK == "pier"
        self._cwd_override = cwd
        self._budget_sec = float(budget_sec) if budget_sec is not None else None
        self.root = Path(os.environ.get("SMITHERS_ROOT") or HERE.parent.parent).resolve()
        self.docker = os.environ.get("SMITHERS_BENCH_DOCKER", "docker")
        self.seat = seat_of(self.model_name)
        provider = self.seat.split(":", 1)[0]
        configured = os.environ.get("SMITHERS_OPENAI_AUTH", "").strip()
        self.auth_mode = configured or ("chatgpt" if provider == "openai" else "api-key")
        self._summary: dict[str, Any] | None = None

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
        built = self.root / BUILT_RELATIVE
        if not built.is_file():
            raise RuntimeError(
                f"{built} is missing: build the CLI first (cd {self.root} && pnpm --filter @smthrs/cli build)"
            )
        if helper_binary(self.root, dict(os.environ)) is None:
            raise RuntimeError(
                f"no atomic filesystem helper: build it with (cd {self.root} && cargo +1.98.0 build --release "
                f"-p smithers-ffi --bin smithers-jj-export) or set {HELPER_VARIABLE}"
            )
        if self.auth_mode == "chatgpt":
            store = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "auth.json"
            if not store.is_file():
                raise RuntimeError(f"SMITHERS_OPENAI_AUTH=chatgpt but {store} does not exist; run `codex login`")

    def container_of(self, environment: BaseEnvironment) -> str:
        """The task container's id, found through the compose project Harbor
        named after the environment's session id."""
        override = os.environ.get("SMITHERS_BENCH_CONTAINER")
        if override:
            return override
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

    def container_cwd(self, environment: BaseEnvironment) -> str:
        if self._cwd_override:
            return self._cwd_override
        config = getattr(environment, "task_env_config", None)
        workdir = getattr(config, "workdir", None)
        return workdir or "/app"

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        container = self.container_of(environment)
        cwd = self.container_cwd(environment)
        workspace = self.logs_dir / "workspace"
        if workspace.exists():
            shutil.rmtree(workspace)
        flow_dir = workspace / "flows" / FLOW_NAME
        flow_dir.mkdir(parents=True)
        (flow_dir / "flow.mdx").write_text(
            render_prompt(instruction, seat=self.seat, container=container, cwd=cwd, commit=self._commit),
            encoding="utf-8",
        )

        budget = self._budget_sec
        if budget is None:
            budget = max(60.0, self._agent_timeout_sec - 60.0) if self._agent_timeout_sec else 3600.0

        helper = helper_binary(self.root, dict(os.environ))
        env = cli_environment(dict(os.environ), auth_mode=self.auth_mode, helper=helper)
        record: dict[str, Any] = {
            "framework": FRAMEWORK,
            "seat": self.seat,
            "authMode": self.auth_mode,
            "openaiApiKeyInCliEnvironment": "OPENAI_API_KEY" in env,
            "helper": str(helper) if helper else None,
            "container": container,
            "cwd": cwd,
            "commit": self._commit,
            "budgetSec": budget,
            "harnessRoot": str(self.root),
            "harnessRevision": harness_revision(self.root),
            "subject": subject_fingerprint(self.root),
            "startedAt": _iso(int(time.time() * 1000)),
        }
        (self.logs_dir / "smithers-run.json").write_text(json.dumps(record, indent=2))

        started = time.monotonic()
        exit_status, phase = await asyncio.to_thread(self._drive, workspace, env, budget)
        wall = time.monotonic() - started

        journal = journal_path(workspace / ".flows")
        events = read_journal(journal) if journal is not None else []
        summary = summarize(events)
        record.update({
            "phase": phase,
            "exitStatus": exit_status,
            "wallSec": round(wall, 3),
            "journal": str(journal) if journal is not None else None,
            "run": summary,
            "finishedAt": _iso(int(time.time() * 1000)),
        })

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
                       "harnessRevision": record["harnessRevision"]},
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
            "bindings": summary["bindings"],
            "harness_revision": record["harnessRevision"],
            "subject": (record["subject"] or {}).get("stamp"),
            "wall_sec": record["wallSec"],
            "exit_status": exit_status,
            "phase": phase,
            "run_status": summary["status"],
            "frames": summary["frames"],
            "calls": summary["calls"],
        }
        self._summary = summary

    def _cli(self, *args: str) -> list[str]:
        return ["node", str(self.root / CLI_RELATIVE), "--json", *args]

    def _drive(self, workspace: Path, env: dict[str, str], budget: float) -> tuple[int, str]:
        """plan, approve, run; the same three verbs the SWE-bench lane uses."""
        log = (self.logs_dir / "smithers-run.log").open("a", encoding="utf-8")
        try:
            plan = subprocess.run(self._cli("plan", FLOW_NAME), cwd=workspace, env=env,
                                  capture_output=True, text=True, timeout=300)
            log.write(plan.stderr)
            if plan.returncode != 0:
                log.write(plan.stdout)
                return plan.returncode, "plan"
            try:
                approval = json.dumps(json.loads(plan.stdout)["approval"])
            except (ValueError, KeyError):
                log.write(plan.stdout)
                return 1, "plan"
            approve = subprocess.run(self._cli("approve", approval, "--scope", "run"), cwd=workspace, env=env,
                                     capture_output=True, text=True, timeout=300)
            log.write(approve.stderr)
            if approve.returncode != 0:
                log.write(approve.stdout)
                return approve.returncode, "approve"
            try:
                run = subprocess.run(self._cli("run", approval), cwd=workspace, env=env,
                                     stdout=log, stderr=subprocess.STDOUT, text=True, timeout=budget)
            except subprocess.TimeoutExpired:
                log.write(f"\nsmithers_agent: run exceeded its {budget:.0f}s budget and was killed\n")
                return 124, "run"
            return run.returncode, "run"
        finally:
            log.close()

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

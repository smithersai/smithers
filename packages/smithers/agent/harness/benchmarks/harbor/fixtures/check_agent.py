"""Offline checks of the Harbor adapter: no docker, no model, no runner needed.

    python3 fixtures/check_agent.py

What is pinned, and why each one matters:

  - The prompt carries the instruction verbatim and nothing task-specific: the
    rendered flow file contains the instruction, the container, the working
    directory and the seat, and never the words `tests/`, `solution/` or
    `solve.sh`. A prompt that could name them is a prompt that could leak them.
  - The chatgpt mode removes OPENAI_API_KEY from the CLI's environment and
    sets SMITHERS_OPENAI_AUTH=chatgpt; the api-key mode keeps the key. This is
    the guard against the silent fallback the SWE-bench lane ran under.
  - The journal fold: a synthetic journal shaped like `make-fixture.mjs`'s,
    with two turns and three calls, sums to the recorded tokens, records the
    route binding, and folds into a trajectory whose step ids are sequential
    and whose observations reference their own step's tool calls, which are
    the two validators ATIF enforces. When Harbor is importable the trajectory
    is validated by its own pydantic model as well, and the check says so.
  - The compose project name is sanitized the way Docker Compose does it.
  - `_drive` runs `up` as a real child: each outcome keeps
    its exit status, phase and output, and a cancelled trial stops the CLI
    (SIGTERM, then SIGKILL after the grace) instead of leaving it running.
  - The stock Codex arm runs as the image's own uid when the task names no
    user and the image's `USER` is not root, so the runner chowns the
    root-owned 0600 `auth.json` to the CLI's user (#3862). Without it the CLI
    falls back to api.openai.com and the trial fails authentication.
  - The stock Codex arm installs only the system packages whose commands the
    image lacks: an image with its own Node.js keeps it (#3863).
  - On Smithers Cloud: the plue `docker` shim translates the harness's
    `docker exec` argv into one `smithers workspace exec` call, the workspace
    id is the container, the shim goes first on PATH, and the account pool
    rotates every login, drops one on a usage limit, and never invents one.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import accounts  # noqa: E402
import plue_docker  # noqa: E402
import smithers_agent as agent  # noqa: E402

DDL = """CREATE TABLE flows_journal_events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL, source_seq INTEGER NOT NULL, emitted_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, meta_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq))"""

INSTRUCTION = "Repair the storage engine under /app so recovery replays the log in order."
ROUTE = {"routeId": "openai-chatgpt", "protocolId": "openai-responses-chatgpt", "modelId": "gpt-6-sol",
         "params": {"reasoningEffort": "max"}}
BINDING = {key: ROUTE[key] for key in ("routeId", "protocolId", "modelId")}


def synthetic_journal(path: Path) -> None:
    events = [
        ("control.agent.turn-opened", {"seat": "openai:gpt-6-sol"}),
        ("control.agent.model-requested", {"seat": "openai:gpt-6-sol", **ROUTE}),
        ("control.agent.model-settled", {"text": "```js\nawait bash({...})\n```",
                                         "usage": {"inputTokens": 1000, "cachedInputTokens": 200, "outputTokens": 50,
                                                   "reasoningTokens": 10}, "durationMillis": 1234}),
        ("control.agent.cell-produced", {"language": "js", "text": "await bash({command: 'ls /app'})", "digest": "d1"}),
        ("control.agent.cell-call-started", {"flowName": "bash", "input": {"mode": "unhermetic", "container": "c1", "command": "ls /app"}}),
        ("control.agent.cell-call-settled", {"flowName": "bash", "outcome": "success", "value": {"stdout": "app.py\n", "exitCode": 0}}),
        ("control.agent.cell-call-started", {"flowName": "bash", "input": {"mode": "unhermetic", "container": "c1", "command": "false"}}),
        ("control.agent.cell-call-settled", {"flowName": "bash", "outcome": "failure", "message": "exit 1", "code": "flow_failed"}),
        ("control.agent.turn-closed", {"outcome": "continue"}),
        ("control.agent.turn-opened", {"seat": "openai:gpt-6-sol"}),
        ("control.agent.model-requested", {"seat": "openai:gpt-6-sol", **ROUTE}),
        ("control.agent.model-settled", {"text": "done", "usage": {"inputTokens": 2000, "cachedInputTokens": 900, "outputTokens": 70}}),
        ("control.agent.cell-call-started", {"flowName": "bash", "input": {"command": "cat /app/app.py"}}),
        ("control.agent.cell-call-settled", {"flowName": "bash", "outcome": "success", "value": "print(1)"}),
        ("control.agent.transition-applied", {"transition": {"_tag": "complete", "output": "fixed recovery order"}}),
        ("control.agent.turn-closed", {"outcome": "resolved"}),
        ("control.run.completed", {}),
    ]
    connection = sqlite3.connect(path)
    connection.execute(DDL)
    for index, (kind, payload) in enumerate(events):
        connection.execute(
            "insert into flows_journal_events values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("run-1", index, f"run-1-{index}", "fixture", index, 1_700_000_000_000 + index * 1000, kind, json.dumps(payload), "{}"),
        )
    connection.commit()
    connection.close()


def check_prompt() -> None:
    text = agent.render_prompt(INSTRUCTION, seat="openai:gpt-6-sol", cwd="/app", commit=False)
    assert text.startswith("---\n"), "the flow file opens with frontmatter"
    assert "model: openai:gpt-6-sol\n" in text, "the seat is the frontmatter model"
    assert "\neffort: xhigh\n" in text, "a task runs at xhigh unless the run names another effort"
    assert "container:" not in text and "unhermetic" not in text, "the seal names the container, the model never types it"
    assert 'ctx.call("bash", { command: "<command>" })' in text and "in `/app` unless" in text, "the bare call and its cwd are taught"
    assert 'flows: ["bash", "apply_patch", "edit", "read", "grep", "jev", "worker"]\n' in text, "the file flows, jev and the worker are bound"
    assert "relative to `/app`" in text, "the file flows' relative paths are taught"
    assert "no file flows" not in text and "has no network" not in text, "the prompt claims nothing false"
    assert text.rstrip().endswith(INSTRUCTION), "the instruction is the last thing in the prompt, verbatim"
    assert "{{" not in text, "every placeholder is filled"
    for forbidden in ("tests/", "solution/", "solve.sh", "FAIL_TO_PASS"):
        assert forbidden not in text, f"the prompt never names {forbidden}"
    assert "git add -A" not in text, "no commit paragraph unless commit mode is on"
    committed = agent.render_prompt(INSTRUCTION, seat="s", cwd="/app", commit=True)
    assert "git add -A && git commit" in committed, "commit mode teaches the commit rule"
    assert committed.count(INSTRUCTION) == 1
    # The worker is the task's agent again: no seat or effort of its own, the
    # same authority, the same container, and nothing of the task's instruction.
    worker = agent.render_worker(cwd="/work dir")
    front = worker.split("---\n")[1]
    assert not any(line.startswith(("model:", "effort:")) for line in front.splitlines()), \
        "the worker runs on the caller's seat and effort"
    task_front = text.split("---\n")[1]
    capabilities = [line for line in task_front.splitlines() if line.startswith("capabilities:")]
    assert capabilities and capabilities[0] in front, "the worker holds exactly the task flow's authority"
    assert "in `/work dir` unless" in worker and "{{" not in worker, "the worker is taught the same cwd"
    assert INSTRUCTION not in worker and worker.rstrip().endswith("## Sub-task"), "its sub-task is the caller's args"


def check_environment() -> None:
    base = {"OPENAI_API_KEY": "sk-x", "SMITHERS_TEST_COMMAND": "pytest", "PATH": "/bin", "SMITHERS_OPENAI_AUTH": "api-key"}
    chatgpt = agent.cli_environment(base, auth_mode="chatgpt")
    assert chatgpt["SMITHERS_OPENAI_AUTH"] == "chatgpt"
    assert "OPENAI_API_KEY" not in chatgpt, "the chatgpt mode cannot fall back to the API key"
    assert "SMITHERS_TEST_COMMAND" not in chatgpt, "no stale test runner reaches the run"
    assert chatgpt["PATH"] == "/bin"
    assert chatgpt["SMITHERS_ASKS"] == "refuse", "nobody answers a benchmark run, so an ask is refused, never parked"
    assert agent.parked({"status": "waiting-approval", "frames": 47}) is not None
    assert agent.parked({"status": "completed"}) is None and agent.parked({"status": None}) is None
    assert agent.HELPER_VARIABLE not in chatgpt, "no helper is named when none is given"
    named = agent.cli_environment(base, auth_mode="chatgpt", helper=Path("/opt/smithers-jj-export"))
    assert named[agent.HELPER_VARIABLE] == "/opt/smithers-jj-export"
    api = agent.cli_environment(base, auth_mode="api-key")
    assert api["SMITHERS_OPENAI_AUTH"] == "api-key" and api["OPENAI_API_KEY"] == "sk-x"
    assert base["SMITHERS_OPENAI_AUTH"] == "api-key", "the caller's dict is not mutated"
    sealed = agent.cli_environment(base, auth_mode="chatgpt", container="task-1", cwd="/app")
    assert sealed["SMITHERS_BASH_CONTAINER"] == "task-1", "bash is sealed to the task container"
    assert sealed["SMITHERS_TEST_CWD"] == "/app", "the file flows resolve relative paths where bash runs"
    assert "SMITHERS_TEST_COMMAND" not in sealed, "the repository's place binds no test runner"
    assert "SMITHERS_TEST_CWD" not in agent.cli_environment(
        {"PATH": "/bin", "SMITHERS_TEST_CWD": "/stale"}, auth_mode="chatgpt", cwd="/app"
    ), "an unsealed run names no place in a container"
    assert "SMITHERS_BASH_CONTAINER" not in agent.cli_environment(
        {"PATH": "/bin", "SMITHERS_BASH_CONTAINER": "stale"}, auth_mode="chatgpt"
    ), "no stale seal reaches an unsealed run"


def check_journal() -> str:
    with tempfile.TemporaryDirectory() as directory:
        flows = Path(directory)
        # rc.1 keeps the control events in control.db beside an engine.db
        # that carries none; the journal is the one with the events.
        engine = flows / "engine.db"
        sqlite3.connect(engine).execute(DDL)
        assert agent.journal_path(flows) is None, "an empty engine.db is not the journal"
        journal = flows / "control.db"
        synthetic_journal(journal)
        assert agent.journal_path(flows) == journal, "control.db with agent events is the journal"
        events = agent.read_journal(journal)
    assert len(events) == 17
    summary = agent.summarize(events)
    assert summary["usage"] == {"inputTokens": 3000, "cachedInputTokens": 1100, "outputTokens": 120, "reasoningTokens": None}, summary
    assert summary["seat"] == "openai:gpt-6-sol"
    assert summary["frames"] == 2 and summary["modelCalls"] == 2 and summary["calls"] == 3
    assert summary["bindings"] == [BINDING], f"one distinct route is recorded: {summary['bindings']}"
    assert summary["efforts"] == ["max"], "the effort each call was made at is read off the journal"
    assert summary["status"] == "completed" and summary["output"] == "fixed recovery order"
    assert summary["spanMillis"] == 16_000

    document = agent.trajectory(events, agent_name="smithers", agent_version="1.0.0-rc.0", seat="openai:gpt-6-sol",
                                instruction=INSTRUCTION, session_id="trial-1", extra={"authMode": "chatgpt"})
    steps = document["steps"]
    assert [step["step_id"] for step in steps] == [1, 2, 3], "step ids are sequential from 1"
    assert steps[0]["source"] == "user" and steps[0]["message"] == INSTRUCTION
    assert steps[1]["source"] == "agent" and len(steps[1]["tool_calls"]) == 2
    assert steps[1]["metrics"] == {"prompt_tokens": 1000, "completion_tokens": 50, "cached_tokens": 200,
                                   "extra": {"reasoning_tokens": 10, "duration_millis": 1234, "purpose": "frame",
                                             "frame": None, "attempt": None}}
    assert steps[1]["extra"]["cell"] == "await bash({command: 'ls /app'})"
    ids = {call["tool_call_id"] for call in steps[1]["tool_calls"]}
    results = steps[1]["observation"]["results"]
    assert [result["source_call_id"] for result in results] == sorted(ids), "each result names its own step's call"
    assert results[1]["content"] == "exit 1" and results[1]["extra"]["outcome"] == "failure"
    assert steps[2]["tool_calls"][0]["function_name"] == "bash"
    assert steps[2]["observation"]["results"][0]["content"] == "print(1)"
    final = document["final_metrics"]
    assert {key: value for key, value in final.items() if key != "extra"} == {
        "total_prompt_tokens": 3000, "total_completion_tokens": 120, "total_cached_tokens": 1100, "total_steps": 3}
    assert final["extra"]["cached_share"] == 1100 / 3000
    # This journal names no purpose and no judge, so every call is the agent's
    # own and the totals by purpose are the totals (`check_calls.py`).
    assert [row["purpose"] for row in document["extra"]["calls"]] == ["frame", "frame"]
    assert final["extra"]["allPurposes"]["totalTokens"] == 3120 == final["extra"]["byPurpose"]["frame"]["totalTokens"]
    assert final["extra"]["ledgerTokens"] is None and summary["byPurpose"] == final["extra"]["byPurpose"]
    def trial(usage: dict) -> dict:
        rows = [{"seq": 1, "at": 0, "type": "control.agent.turn-opened", "payload": {}},
                {"seq": 2, "at": 1, "type": "control.agent.model-settled", "payload": {"usage": usage}}]
        return agent.trajectory(rows, agent_name="smithers", agent_version="test", seat="test",
                                instruction="test", session_id="trial")["final_metrics"]

    assert trial({"inputTokens": 10, "cachedInputTokens": 0})["extra"]["cached_share"] == 0
    assert trial({"inputTokens": 0, "cachedInputTokens": 0})["extra"]["cached_share"] is None
    missing = trial({"inputTokens": 10})
    assert missing["total_cached_tokens"] is None and missing["extra"]["cached_share"] is None
    assert trial({})["total_prompt_tokens"] is None
    mixed = [{"seq": 1, "at": 0, "type": "control.agent.turn-opened", "payload": {}},
             {"seq": 2, "at": 1, "type": "control.agent.model-settled",
              "payload": {"usage": {"inputTokens": 10, "cachedInputTokens": 2}}},
             {"seq": 3, "at": 2, "type": "control.agent.model-settled",
              "payload": {"usage": {"inputTokens": 10}}}]
    assert agent.summarize(mixed)["usage"]["cachedInputTokens"] is None
    assert agent.trajectory(mixed, agent_name="smithers", agent_version="test", seat="test",
                            instruction="test", session_id="trial")["final_metrics"]["extra"]["cached_share"] is None
    assert document["schema_version"] == "ATIF-v1.8" and document["agent"]["model_name"] == "openai:gpt-6-sol"

    try:
        from harbor.models.trajectories import Trajectory  # type: ignore[import-not-found]
    except ImportError:
        if os.environ.get("HARBOR_PYTHON"):
            raise
        return "structural only (harbor not importable)"
    validated = Trajectory.model_validate(document)
    assert validated.final_metrics.extra["cached_share"] == 1100 / 3000
    return "validated by harbor.models.trajectories.Trajectory"


def check_helper() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        assert agent.helper_binary(root, {}) in (None, agent.HELPER_DEFAULT), "nothing built, nothing configured"
        built = root / agent.HELPER_BUILT_RELATIVE
        built.parent.mkdir(parents=True)
        built.write_text("#!/bin/sh\n")
        built.chmod(0o755)
        if not agent.HELPER_DEFAULT.is_file():
            assert agent.helper_binary(root, {}) == built, "the checkout's release build is found"
        configured = root / "elsewhere"
        configured.write_text("#!/bin/sh\n")
        configured.chmod(0o755)
        assert agent.helper_binary(root, {agent.HELPER_VARIABLE: str(configured)}) == configured, "configuration wins"
        assert agent.helper_binary(root, {agent.HELPER_VARIABLE: str(root / "missing")}) in (built, agent.HELPER_DEFAULT)


def check_plue_shim() -> None:
    environ = {"TOKEN": "t0", "PATH": "/bin", "SMITHERS_TOKEN": "operator-token"}
    config = {"repo": "acme/bench", "cli": "/bin/sh"}
    args, stdin = plue_docker.translate(
        ["exec", "-i", "-w", "/app", "-e", "TOKEN", "-e", "MISSING", "--", "ws-1", "bash", "-lc", 'exec "$@"', "bash", "python3", "-"],
        environ, config,
    )
    assert stdin is True
    assert args[:4] == ["/bin/sh", "workspace", "exec", "ws-1"]
    assert args[4:10] == ["--repo", "acme/bench", "--user", "root", "--timeout", "0"]
    assert ["--cwd", "/app"] == args[args.index("--cwd"):args.index("--cwd") + 2]
    assert args[args.index("--env") + 1] == "TOKEN=t0" and args.count("--env") == 1, "unset names are not forwarded"
    assert args[-2] == "--command", args
    assert args[-1] == plue_docker.EGRESS_PREFIX + "exec bash -lc 'exec \"$@\"' bash python3 -", args[-1]
    assert args[-1].startswith("if [ -r /etc/smithers/egress.env ]"), "the sandbox egress proxy reaches the command"
    import plue_env
    assert plue_env.with_egress("ls") == plue_env.EGRESS_PREFIX + "ls" and plue_env.EGRESS_PREFIX == plue_docker.EGRESS_PREFIX
    plain, stdin = plue_docker.translate(["exec", "--", "ws-1", "bash", "-lc", "ls"], environ, config)
    assert stdin is False and "--cwd" not in plain and "--env" not in plain
    for bad in (["ps"], ["exec", "--", "ws-1"], ["exec", "-t", "--", "ws-1", "true"],
                # the plue CLI's credential never reaches the task container
                ["exec", "-e", "SMITHERS_TOKEN", "--", "ws-1", "env"]):
        try:
            plue_docker.translate(bad, environ, config)
        except ValueError:
            pass
        else:
            raise AssertionError(f"refused: {bad}")
    ambient = {"SMITHERS_CLI": "/bin/sh", "PLUE_REPO": "acme/bench"}
    for partial in ({}, {"repo": "acme/bench"}, {"repo": "acme/bench", "cli": "sh"}, {"cli": "/bin/sh"}):
        try:
            plue_docker.translate(["exec", "--", "ws-1", "true"], ambient, partial)
        except ValueError:
            pass
        else:
            raise AssertionError(f"repo and an absolute cli come from the shim config, never ambient: {partial}")
    assert plue_docker.envelope('note\n{"data": {"exit_code": 3}}') == {"data": {"exit_code": 3}}

    class Plue:
        _workspace_id = "ws-9"

        @staticmethod
        def type() -> str:
            return "plue"

    class Docker:
        @staticmethod
        def type() -> str:
            return "docker"

    assert agent.plue_workspace_of(Plue()) == "ws-9"
    assert agent.plue_workspace_of(Docker()) is None
    assert agent.plue_workspace_of(object()) is None
    with tempfile.TemporaryDirectory() as directory:
        check_shim_reaches_cli(Path(directory))
    with tempfile.TemporaryDirectory() as directory:
        shim = agent.shim_directory(Path(directory), {"repo": "acme/bench", "cli": "/bin/sh", "env": {}})
        assert (shim / "docker").resolve() == agent.PLUE_SHIM.resolve() and os.access(shim / "docker", os.X_OK)
        env = agent.cli_environment({"PATH": "/bin"}, auth_mode="chatgpt", shim=shim, codex_home=Path("/h/codex-2"))
        assert env["PATH"].startswith(str(shim) + os.pathsep) and env["CODEX_HOME"] == "/h/codex-2"
        assert "CODEX_HOME" not in agent.cli_environment({"PATH": "/bin"}, auth_mode="chatgpt")
    for name in ("SeatExhausted", "ModelRouteError", "NoSeatLeft", "ContainerUnreachable", "PoolStateUnreadable"):
        assert issubclass(getattr(accounts, name), Exception), name


def check_shim_reaches_cli(root: Path) -> None:
    """The regression of preflight-A 2026-09-22: the harness spawns `docker`
    with only PATH/HOME/USER/LANG/TERM/TMPDIR/SHELL, so a shim that reads
    PLUE_REPO, SMITHERS_CLI or SMITHERS_TOKEN from its environment exits 125
    or runs the flows CLI. Run the real shim under exactly that environment
    against a fake plue CLI and require the repo, CLI and token to arrive."""
    import subprocess
    fake = root / "plue"
    record = root / "argv.json"
    fake.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                    f"open({str(record)!r}, 'w').write(json.dumps({{'argv': sys.argv[1:], "
                    "'token': os.environ.get('SMITHERS_TOKEN'), 'xdg': os.environ.get('XDG_CONFIG_HOME')}))\n"
                    "print(json.dumps({'data': {'exit_code': 0, 'stdout': 'reached\\n', 'stderr': ''}}))\n")
    fake.chmod(0o755)
    host = {"PLUE_REPO": "acme/bench", "SMITHERS_CLI": str(fake), "SMITHERS_TOKEN": "pat-1",
            "XDG_CONFIG_HOME": str(root / "xdg"), "PATH": os.environ["PATH"], "HOME": str(root)}
    config = agent.shim_config(host)
    assert config["repo"] == "acme/bench" and config["cli"] == str(fake), config
    shim = agent.shim_directory(root / "trial", config)
    assert (os.stat(shim / plue_docker.CONFIG_NAME).st_mode & 0o077) == 0, "the token file is owner-only"
    scrubbed = {"PATH": f"{shim}{os.pathsep}{os.environ['PATH']}", "HOME": str(root)}
    result = subprocess.run(["docker", "exec", "-w", "/app", "--", "ws-7", "bash", "-lc", "true"],
                            env=scrubbed, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0 and result.stdout == "reached\n", (result.returncode, result.stderr)
    seen = json.loads(record.read_text())
    assert seen["argv"][:6] == ["workspace", "exec", "ws-7", "--repo", "acme/bench", "--user"], seen
    assert seen["token"] == "pat-1" and seen["xdg"] == str(root / "xdg"), seen
    (shim / plue_docker.CONFIG_NAME).unlink()
    bare = subprocess.run(["docker", "exec", "--", "ws-7", "true"], env={**scrubbed, "PLUE_REPO": "acme/bench"},
                          capture_output=True, text=True, timeout=30)
    assert bare.returncode == 125 and plue_docker.CONFIG_NAME in bare.stderr, (bare.returncode, bare.stderr)
    for broken in ({**host, "PLUE_REPO": ""}, {**host, "SMITHERS_CLI": str(root / "missing")}):
        try:
            agent.shim_config(broken)
        except RuntimeError:
            pass
        else:
            raise AssertionError("a shim without a repo or a CLI is refused before the run")


def check_container_gate() -> None:
    """A trial is healthy only if a command reached the task container with
    exit 0: preflight-A's 20 calls all failed (125) or ran on the host."""
    def call(n: int, container: str | None, exit_code: int, flow: str = "bash", outcome: str = "success") -> list[dict]:
        given = {"command": "ls", **({"container": container} if container else {})}
        return [{"type": "control.agent.cell-call-started",
                 "payload": {"callId": f"c{n}", "flowName": flow, "input": given}},
                {"type": "control.agent.cell-call-settled",
                 "payload": {"callId": f"c{n}", "outcome": outcome, "value": {"exitCode": exit_code}}}]
    # A transport failure (125), a call the seal refused for naming another
    # container, and another flow's call: none of them reached the task.
    unreachable = call(1, "ws-1", 125) + call(2, "ws-other", 0, outcome="failure") + call(3, None, 0, flow="jev")
    assert agent.container_commands(unreachable, "ws-1") == {"attempted": 1, "succeeded": 0}
    assert agent.container_commands(unreachable + call(4, "ws-1", 0), "ws-1") == {"attempted": 2, "succeeded": 1}
    # The sealed CLI runs a call that names no container in the task's.
    assert agent.container_commands(unreachable + call(5, None, 0), "ws-1") == {"attempted": 2, "succeeded": 1}
    sys.path.insert(0, str(HERE.parents[6]))
    try:
        from packages.smithers.agent.harness.benchmarks.harbor import codex_pool
    except ImportError:
        print("check_agent.py: harbor not importable; codex gate not checked")
        return
    lines = "\n".join([
        '{"type":"item.completed","item":{"type":"command_execution","exit_code":127}}',
        '{"type":"item.started","item":{"type":"command_execution"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
        '{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}',
    ])
    assert codex_pool.container_commands(lines) == {"attempted": 2, "succeeded": 1}
    assert codex_pool.container_commands(lines.splitlines()[0]) == {"attempted": 1, "succeeded": 0}


CODEX_SESSION = [
    {"timestamp": "2026-09-26T09:45:31.044Z", "type": "session_meta",
     "payload": {"id": "s1", "timestamp": "2026-09-26T09:45:31.018Z", "cwd": "/app", "originator": "codex_exec",
                 "cli_version": "0.155.1"}},
    {"timestamp": "2026-09-26T09:45:35.000Z", "type": "response_item",
     "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "done"}]}},
    {"timestamp": "2026-09-26T09:45:39.040Z", "type": "event_msg",
     "payload": {"type": "token_count", "info": {
         "total_token_usage": {"input_tokens": 1200, "cached_input_tokens": 1000, "output_tokens": 30,
                               "reasoning_output_tokens": 10, "total_tokens": 1230},
         "last_token_usage": {"input_tokens": 1200, "cached_input_tokens": 1000, "output_tokens": 30,
                              "reasoning_output_tokens": 10, "total_tokens": 1230}}}},
]


def check_codex_usage() -> None:
    """The stock Codex arm reports its tokens. Harbor fills usage from the
    Codex session only into an empty AgentContext
    (`Trial._populate_agent_context`); luna-B-smoke recorded no tokens for any
    trial because the pool's metadata filled the context first."""
    sys.path.insert(0, str(HERE.parents[6]))
    try:
        from packages.smithers.agent.harness.benchmarks.harbor import codex_pool
        from harbor.agents.installed.codex import Codex
        from harbor.models.agent.context import AgentContext
        from harbor.trial.trial import Trial
    except ImportError:
        print("check_agent.py: harbor not importable; codex usage not checked")
        return
    import asyncio
    import types

    with tempfile.TemporaryDirectory() as directory:
        logs = Path(directory) / "agent"
        sessions = logs / "sessions" / "2026" / "09" / "26"
        sessions.mkdir(parents=True)
        (sessions / "rollout-2026-09-26T09-45-31-s1.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in CODEX_SESSION))
        (logs / "codex.txt").write_text(
            '{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}\n')
        home = Path(directory) / "seat"
        home.mkdir()
        (home / "auth.json").write_text("{}")
        seat = accounts.Account("codex-2", home)

        pooled = codex_pool.PooledCodex(logs_dir=logs, model_name="openai/gpt-6-sol")
        pooled._pool = types.SimpleNamespace(lease=lambda trial="": seat)
        pooled._account = seat  # what setup() leases before the CLI is installed

        async def ran(self, instruction, environment, context):  # the CLI already ran in the container
            return None

        original = Codex.run
        Codex.run = ran
        try:
            context = AgentContext()
            environment = types.SimpleNamespace(capabilities=types.SimpleNamespace(mounted=True))
            asyncio.run(pooled.run("fix it", environment, context))
        finally:
            Codex.run = original
        # Harbor's own sync step, as `SingleStepTrial._run_agent` runs it.
        Trial._populate_agent_context(types.SimpleNamespace(agent=pooled, user_agent=None), context)
        assert (context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens) == (1200, 1000, 30), \
            (context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens)
        assert context.metadata["account"] == "codex-2", context.metadata
        assert context.metadata["container_commands"] == {"attempted": 1, "succeeded": 1}, context.metadata
        assert (logs / "trajectory.json").is_file(), "Harbor writes the stock arm's trajectory"


class Container:
    """A task container that records every command and upload. With no
    `-u`, a command runs as the image's `USER` (`image_uid`), as `docker exec`
    does; `root` is uid 0."""

    def __init__(self, image_uid: int, default_user: str | int | None = None, id_fails: bool = False):
        import types
        self.image_uid = image_uid
        self.default_user = default_user
        self.id_fails = id_fails
        self.capabilities = types.SimpleNamespace(mounted=True)
        self.calls: list[tuple[str, str, str | int | None]] = []

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        import types
        user = user if user is not None else self.default_user
        self.calls.append(("exec", command, user))
        if command.strip() == "id -u":
            if self.id_fails:
                raise RuntimeError("container went away")
            uid = self.image_uid if user is None else 0 if user == "root" else int(user)
            return types.SimpleNamespace(return_code=0, stdout=f"{uid}\n", stderr="")
        return types.SimpleNamespace(return_code=0, stdout="", stderr="")

    async def upload_file(self, source, target):
        self.calls.append(("upload", str(target), "root"))


def check_codex_runs_as_image_user() -> str:
    """The stock arm's CLI can read its `auth.json` in an image whose `USER`
    is not root. rs-archive-clone (`USER agent`) and risk-scorer-replay
    (`USER nobody`) name no `[agent] user`, so `default_user` is None; Harbor
    uploads `auth.json` as root, mode 0600, and chowns it only when
    `default_user` is set. The CLI then fell back to api.openai.com and the
    trial ended in `AgentAuthenticationError` within 90 s (#3862)."""
    sys.path.insert(0, str(HERE.parents[6]))
    try:
        from packages.smithers.agent.harness.benchmarks.harbor import codex_pool
    except ImportError:
        return "harbor not importable; image user not checked"
    import asyncio
    import types

    def trial(container: Container) -> list[tuple[str, str, str | int | None]]:
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "agent"
            logs.mkdir()
            (logs / "codex.txt").write_text(
                '{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}\n')
            home = Path(directory) / "seat"
            home.mkdir()
            (home / "auth.json").write_text("{}")
            seat = accounts.Account("codex-2", home)
            pooled = codex_pool.PooledCodex(logs_dir=logs, model_name="openai/gpt-6-sol")
            pooled._pool = types.SimpleNamespace(lease=lambda trial="": seat)
            pooled._account = seat  # what setup() leases before the CLI is installed
            asyncio.run(pooled.run("fix it", container, codex_pool.AgentContext()))
        return container.calls

    def auth_owner(calls) -> list[str]:
        """Who each root `chown <owner> …/auth.json` hands the file to."""
        owners = []
        for kind, command, user in calls:
            words = command.replace(";", " ").split()
            if kind == "exec" and user == "root" and "chown" in words and words[-1].endswith("/auth.json"):
                owners.append(words[words.index("chown") + 1])
        return owners

    def cli_user(calls):
        users = [user for kind, command, user in calls if kind == "exec" and "codex exec" in command]
        assert len(users) == 1, calls
        return users[0]

    for name, uid in (("agent", 1000), ("nobody", 65534)):
        container = Container(uid)
        calls = trial(container)
        uploaded = [target for kind, target, _ in calls if kind == "upload" and target.endswith("/auth.json")]
        assert len(uploaded) == 1, calls
        assert auth_owner(calls) == [str(uid)], f"USER {name}: auth.json stays root's 0600: {calls}"
        assert cli_user(calls) == uid, f"USER {name}: the CLI runs as the image's own uid: {calls}"
        assert container.default_user is None, "the trial's default user is restored after the run"

    # A root image: nothing to chown, and the CLI runs as before.
    container = Container(0)
    calls = trial(container)
    assert auth_owner(calls) == [] and cli_user(calls) is None, calls
    # A task that names its user: Harbor's own chown, and no uid probe.
    container = Container(1000, default_user="agent")
    calls = trial(container)
    assert auth_owner(calls) == ["agent"] and cli_user(calls) == "agent", calls
    assert not [c for c in calls if c[1].strip() == "id -u"], calls
    # A probe that fails leaves the run as it was; the CLI's own exit decides.
    container = Container(1000, id_fails=True)
    calls = trial(container)
    assert auth_owner(calls) == [] and cli_user(calls) is None, calls
    return f"checked under {codex_pool.Codex.__module__.split('.')[0]}"


class Image:
    """A task image that answers `command -v` for the commands it ships,
    names apt-get as its package manager, and records each install."""

    def __init__(self, commands: set[str]):
        self.default_user = None
        self.commands = commands
        self.installs: list[str] = []

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        import re
        import types
        code, stdout = 0, ""
        if "for manager in" in command:
            stdout = "apt-get"
        elif "apt-get install" in command:
            self.installs.append(command.split("apt-get install -y ", 1)[1])
        else:
            asked = re.findall(r"command -v (\S+)", command)
            code = 0 if asked and all(name in self.commands for name in asked) else 1
        return types.SimpleNamespace(return_code=code, stdout=stdout, stderr="")


def check_codex_installs_only_what_is_missing() -> str:
    """The stock arm asks the package manager only for the commands the image
    lacks. Harbor installs all of `curl bash nodejs npm ripgrep` when any one is
    missing; SWE-bench Pro V2 openlibrary ships NodeSource's nodejs, Debian's
    npm cannot install beside it, apt-get exits 100 and the trial died in
    setup (nyc-01, 2026-10-14; #3863)."""
    sys.path.insert(0, str(HERE.parents[6]))
    try:
        from packages.smithers.agent.harness.benchmarks.harbor import codex_pool
    except ImportError:
        return "harbor not importable; install not checked"
    if not hasattr(codex_pool.Codex, "ensure_system_dependencies"):
        return "not checked (Pier installs the CLI at image build)"
    import asyncio

    stock = ("curl", "bash", "nodejs", "npm", "ripgrep")

    def installs(commands: set[str], dependencies: tuple[str, ...] = stock) -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            pooled = codex_pool.PooledCodex(logs_dir=Path(directory), model_name="openai/gpt-6-sol")
            image = Image(commands)
            asyncio.run(pooled.ensure_system_dependencies(image, dependencies))
        return image.installs

    openlibrary = {"curl", "bash", "node", "npm"}
    assert installs(openlibrary) == ["ripgrep"], "the image's own nodejs and npm are left alone"
    assert installs(openlibrary | {"rg"}) == [], "nothing missing, nothing installed"
    assert installs(set()) == ["curl bash nodejs npm ripgrep"], "a bare image gets every package, in one call"
    assert installs({"curl", "bash", "rg"}) == ["nodejs npm"], installs({"curl", "bash", "rg"})
    # Harbor's own rules stand: a package installed every time, an unknown name refused.
    assert installs(openlibrary | {"rg"}, stock + ("ca_certificates",)) == ["ca-certificates"]
    try:
        installs(openlibrary, ("curl", "no-such-dependency"))
    except ValueError as error:
        assert "no-such-dependency" in str(error), error
    else:
        raise AssertionError("an unknown dependency is refused")
    return "checked"


def check_container_survival() -> None:
    """A task container that died during the run cannot be graded: tb4-confirm-A2
    mp-checkpoint 7FU4pw3's VM was gone ("workspace VM no longer exists"), the
    artifact copy failed best-effort and the verifier scored the missing file 0."""
    import asyncio

    class Alive:
        async def exec(self, command, cwd=None, env=None, timeout_sec=None, **_):
            assert command == "true" and timeout_sec, (command, timeout_sec)
            return type("R", (), {"return_code": 0, "stdout": "", "stderr": ""})()

    class Gone:
        async def exec(self, command, cwd=None, env=None, timeout_sec=None, **_):
            raise RuntimeError("409: workspace VM no longer exists")

    class Refuses:
        async def exec(self, command, cwd=None, env=None, timeout_sec=None, **_):
            return type("R", (), {"return_code": 125, "stdout": "", "stderr": "no such container"})()

    assert asyncio.run(agent.container_lost(Alive())) is None
    assert "no longer exists" in asyncio.run(agent.container_lost(Gone()))
    assert "125" in asyncio.run(agent.container_lost(Refuses()))


# A real CLI child for `_drive`: `STUB_MODE` picks the outcome, and a run
# that hangs writes its pid to `STUB_PID` once it is ready to be cancelled.
STUB_CLI = r"""
import os, signal, sys, time
verb, mode = sys.argv[1], os.environ["STUB_MODE"]
if verb != "up":
    print("unknown verb " + verb)
    sys.exit(64)
if mode == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
print("ran " + sys.argv[2], flush=True)
print("warned", file=sys.stderr, flush=True)
if mode in ("hang", "stubborn"):
    pid = os.environ["STUB_PID"]
    open(pid + ".tmp", "w").write(str(os.getpid()))
    os.replace(pid + ".tmp", pid)
    time.sleep(600)
sys.exit(3)
"""


class Stubbed(agent.SmithersAgent):
    """The real `_drive` with the CLI replaced by `STUB_CLI`."""

    def _cli(self, *args: str) -> list[str]:
        return [sys.executable, str(self.logs_dir.parent / "stub.py"), *args]


def stubbed(root: Path, mode: str) -> tuple[Stubbed, dict[str, str]]:
    (root / "stub.py").write_text(STUB_CLI)
    (root / "agent").mkdir()
    return (Stubbed(logs_dir=root / "agent", model_name="openai/gpt-6-sol"),
            {**os.environ, "STUB_MODE": mode, "STUB_PID": str(root / "pid")})


def gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def check_judge_preflight() -> None:
    """A trial without `AI_GATEWAY_API_KEY` is refused in `setup()`, before
    any model call: g1b-smithers-abs (2026-10-11) ran 1,718 s unjudged and
    was scored."""
    import asyncio

    saved = os.environ.pop("AI_GATEWAY_API_KEY", None)
    try:
        with tempfile.TemporaryDirectory() as directory:
            smithers = agent.SmithersAgent(logs_dir=Path(directory), model_name="openai/gpt-6-sol")
            try:
                asyncio.run(smithers.setup(None))
            except RuntimeError as error:
                assert "AI_GATEWAY_API_KEY" in str(error), error
            else:
                raise AssertionError("a trial without a judge key is refused")
            os.environ["AI_GATEWAY_API_KEY"] = "key"
            try:
                asyncio.run(smithers.setup(None))
            except RuntimeError as error:
                assert "AI_GATEWAY_API_KEY" not in str(error), error
    finally:
        os.environ.pop("AI_GATEWAY_API_KEY", None)
        if saved is not None:
            os.environ["AI_GATEWAY_API_KEY"] = saved


def check_drive() -> None:
    """`up` against a real child, in one process: its exit status and what
    `smithers-run.log` keeps of its output."""
    import asyncio

    cases = [
        ("exit", 600, 3, ["ran task", "warned"]),
        ("hang", 2, 124, ["ran task", "run exceeded its 2s budget and was killed"]),
    ]
    for mode, budget, expected, logged in cases:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stub, env = stubbed(root, mode)
            outcome = asyncio.run(stub._drive(root, env, budget))
            assert outcome == expected, (mode, outcome)
            log = (stub.logs_dir / "smithers-run.log").read_text()
            for line in logged:
                assert line in log, (mode, line, log)
            if mode == "hang":
                assert gone(int((root / "pid").read_text())), "a run over its budget is killed"


def check_drive_cancelled() -> None:
    """A cancelled trial stops its CLI. Harbor cancels `run()` at the agent
    timeout or a job stop; on nyc-02 (2026-10-14) a runner hung until its CLI
    was killed by hand, because the thread blocked in `subprocess.run`
    outlived the cancellation. The CLI gets SIGTERM, SIGKILL after the grace,
    and the cancellation is re-raised."""
    import asyncio
    import time

    async def cancel(stub: Stubbed, env: dict[str, str], root: Path, **grace: float) -> tuple[int, float]:
        task = asyncio.create_task(stub._drive(root, env, 600, **grace))
        deadline = time.monotonic() + 30
        while not (root / "pid").exists():
            assert time.monotonic() < deadline and not task.done(), "the stub started its run"
            await asyncio.sleep(0.02)
        pid = int((root / "pid").read_text())
        started = time.monotonic()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("the cancellation is re-raised")
        return pid, time.monotonic() - started

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        stub, env = stubbed(root, "hang")
        pid, waited = asyncio.run(cancel(stub, env, root))
        assert gone(pid), "SIGTERM stops the CLI"
        assert waited < 10, f"stopped by SIGTERM, not by the {agent.CANCEL_GRACE_SEC:.0f}s fallback: {waited:.1f}s"
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        stub, env = stubbed(root, "stubborn")
        pid, waited = asyncio.run(cancel(stub, env, root, grace=0.5))
        assert gone(pid), "SIGKILL stops a CLI that ignores SIGTERM"
        assert 0.5 <= waited < 10, f"killed after the 0.5s grace: {waited:.1f}s"


def check_accounts() -> None:
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        assert accounts.discover(home) == [], "no logins, no accounts"
        (home / ".codex").mkdir()
        (home / ".codex" / "auth.json").write_text("{}")
        store = home / ".smithers" / "accounts"
        for name in ("codex-2", "codex-3", "claude-1", "codex-empty"):
            (store / name).mkdir(parents=True)
            if name != "codex-empty":
                (store / name / "auth.json").write_text("{}")
        found = accounts.discover(home)
        assert [a.label for a in found] == ["default", "codex-2", "codex-3"], found
        assert found[1].auth == store / "codex-2" / "auth.json"

        now = [1_000_000.0]
        slept: list[float] = []

        def sleep(seconds: float) -> None:
            slept.append(seconds)
            now[0] += seconds

        pool = accounts.Pool(found, home / "pool.json", wait_sec=300, clock=lambda: now[0], sleep=sleep)
        assert [pool.lease("t1").label, pool.lease("t2").label, pool.lease("t3").label, pool.lease("t4").label] == \
            ["default", "codex-2", "codex-3", "default"], "round robin"
        pool.disable("codex-2", "You've hit your usage limit", reset_at="2026-09-27T16:27+00:00")
        assert [pool.lease().label, pool.lease().label] == ["default", "codex-3"], "a disabled account is skipped"
        assert accounts.Pool(found, home / "pool.json").disabled()["codex-2"]["resetAt"] == "2026-09-27T16:27+00:00"
        pool.disable("default", "x")
        pool.disable("codex-3", "x")
        try:
            pool.lease("t9")
        except accounts.NoSeatLeft:
            pass
        else:
            raise AssertionError("an empty rotation is refused, never faked")
        assert slept and sum(slept) >= 300, "the pool paused and waited before giving up"
        assert pool.paused() is not None and "default" in pool.paused()["disabled"], "the pause is on record"
        # A reset that passes re-admits the account and the wait ends.
        slept.clear()
        pool.disable("codex-2", "limit", reset_at="1970-01-12T13:46+00:00")
        assert pool.lease("t10").label == "codex-2" and not slept, "a passed reset re-enables without waiting"
        assert pool.paused() is None
        pool.disable("codex-2", "limit", reset_at=None)
        pool.enable("codex-2")
        assert "codex-2" not in pool.disabled()
        # A limit with no readable reset time is a cool-off, never a removal
        # for good (the Codex CLI's "Try again at 9:27 AM." once read as none).
        later = [now[0]]
        solo = accounts.Pool(found[1:2], home / "solo.json", wait_sec=0, clock=lambda: later[0])
        solo.disable("codex-2", "You've hit your usage limit.", reset_at=None)
        later[0] += accounts.NO_RESET_COOLOFF_SEC - 1
        try:
            solo.lease("t-cool")
        except accounts.NoSeatLeft:
            pass
        else:
            raise AssertionError("the cool-off holds until it ends")
        later[0] += 1
        assert solo.lease("t-back").label == "codex-2", "the cool-off ends and the account is back"
        solo.disable("codex-2", "limit", reset_at="not a time")
        later[0] += accounts.NO_RESET_COOLOFF_SEC
        assert solo.lease("t-bad").label == "codex-2", "an unreadable reset time is a cool-off too"

        # A new login appearing during the pause is picked up.
        pool.disable("codex-2", "x")
        seen = {"n": 0}

        def rediscover() -> list[accounts.Account]:
            seen["n"] += 1
            if seen["n"] >= 3:
                (store / "codex-4").mkdir(exist_ok=True)
                (store / "codex-4" / "auth.json").write_text("{}")
            return accounts.discover(home)

        pool = accounts.Pool(found, home / "pool.json", wait_sec=3600, clock=lambda: now[0], sleep=sleep, rediscover=rediscover)
        assert pool.lease("t11").label == "codex-4", "a login added during the pause serves the next lease"

        # An update replaces the state file whole: a reader holding the old
        # file still reads the old state, and no temporary is left beside it.
        state = home / "pool.json"
        with state.open() as before:
            held = json.loads(state.read_text())
            pool.disable("codex-3", "limit")
            assert json.load(before) == held, "the state is replaced, not rewritten in place"
        assert "codex-3" in pool.disabled() and sorted(p.name for p in home.glob("pool.json*")) == ["pool.json"]
        # A torn state file is refused, never read as an empty rotation that
        # would lease the disabled codex-2 again.
        state.write_text('{"disabled": {"codex-2": {"reason"')
        for read in (lambda: pool.lease("t12"), pool.disabled, pool.paused):
            try:
                read()
            except accounts.PoolStateUnreadable as error:
                assert str(state) in str(error), error
            else:
                raise AssertionError("a torn pool.json is refused")
        state.write_text("[]")
        try:
            pool.disabled()
        except accounts.PoolStateUnreadable:
            pass
        else:
            raise AssertionError("a pool.json that is not an object is refused")

    assert accounts.mentions_usage_limit("ERROR: You've hit your usage limit. Try again at 4pm")
    assert accounts.mentions_usage_limit('{"type":"usage_limit_reached"}')
    assert not accounts.mentions_usage_limit("rate limit exceeded, retrying"), "a transient 429 is not a usage limit"
    reset = accounts.reset_time_of("ERROR: You’ve hit your usage limit. Visit https://x or try again at Sep 27th, 2026 9:27 AM.")
    assert reset is not None and reset.startswith("2026-09-27T"), reset
    assert accounts.reset_time_of('{"resets_at":"2026-09-27T16:27:00Z"}') == "2026-09-27T16:27+00:00"
    assert accounts.reset_time_of("The usage limit has been reached") is None
    # The CLI's same-day form names a local time with no date: the next 9:27 AM
    # on this host's clock, tomorrow once today's has passed.
    for at in (datetime(2026, 9, 27, 8, 0).timestamp(), datetime(2026, 9, 27, 10, 0).timestamp()):
        same_day = accounts.reset_time_of("You've hit your usage limit. Try again at 9:27 AM.", now=at)
        assert same_day is not None, "the same-day form names a reset"
        moment = datetime.fromisoformat(same_day).timestamp()
        assert at < moment <= at + 86400 and datetime.fromtimestamp(moment).strftime("%H:%M") == "09:27", same_day
    assert accounts.reset_time_of("try again at 9:27pm", now=datetime(2026, 9, 27, 8, 0).timestamp()) is not None
    assert accounts.reset_time_of("try again at 13:27 PM", now=0) is None
    assert accounts.reset_time_of("Usage limit hit. Try again in 3 hours 12 minutes.", now=1_000_020) == \
        datetime.fromtimestamp(1_000_020 + 3 * 3600 + 12 * 60, timezone.utc).isoformat(timespec="minutes")
    assert accounts.reset_time_of("usage limit, resets in 2d 30m", now=0) == "1970-01-03T00:30+00:00"

    assert accounts.classify_cause("rate_limited: The usage limit has been reached\n/harness/HarnessError: x") == "seat"
    assert accounts.classify_cause("quota_exceeded: insufficient_quota") == "seat"
    assert accounts.classify_cause("rate_limited: 429 after 6 attempts") == "infra"
    for code in ("authentication", "no_route", "provider_internal", "transport", "completion_unjudged", "unconfigured"):
        assert accounts.classify_cause(f"{code}: gateway 503") == "infra", code
    # The harness's own per-call budget (modelCallMs, 300 s by default) firing
    # is the arm's outcome, scored (coordinator ruling 2026-09-23 21:16 PDT).
    assert accounts.classify_cause("call_timeout: The model call ran past its 300-second budget") is None
    assert accounts.classify_cause("claim_unproven: work this run never recorded") is None, "the model's own failure is scored"
    assert accounts.classify_cause("read_only_cap: no writes") is None
    assert accounts.classify_cause(None) is None and accounts.classify_cause("") is None

    failed = {"cause": "rate_limited: The usage limit has been reached"}
    assert agent.verdict("", failed, []) == ("seat", failed["cause"])
    assert agent.verdict("", {"cause": "provider_internal: 503"}, []) == ("infra", "provider_internal: 503")
    assert agent.verdict("", {"cause": "claim_unproven: x"}, []) == (None, "claim_unproven: x")
    assert agent.verdict("", {"cause": None}, [{"type": "control.agent.model-retried", "payload": {"code": "quota_exceeded", "attempt": 2}}]) \
        == ("seat", "quota_exceeded: model-retried (attempt 2)")
    assert agent.verdict("ok\nerror: usage_limit_reached\n", {"cause": None}, []) == ("seat", "error: usage_limit_reached")
    log = 'note\n{"_tag":"Accepted","cause":"transport: socket hang up\\nstack","status":"failed"}\n'
    assert agent.failure_cause(log, {"cause": None}) == "transport: socket hang up"
    assert agent.verdict("fine", {"cause": None}, [{"type": "control.agent.model-retried", "payload": {"code": "rate_limited"}}]) == (None, None)
    assert agent.summarize([{"seq": 1, "at": 0, "type": "control.run.failed", "payload": {"cause": "transport: x\nstack"}}])["cause"] == "transport: x"

    sys.path.insert(0, str(HERE.parents[6]))
    try:
        from packages.smithers.agent.harness.benchmarks.harbor import codex_pool  # needs harbor; a bare `import codex_pool` always failed (relative imports)
    except ImportError:
        pass
    else:
        assert codex_pool.usage_limit_in("thinking\nERROR: You've hit your usage limit. Visit …\n") == "ERROR: You've hit your usage limit. Visit …"
        assert codex_pool.usage_limit_in("all done, 3 files changed") is None
        # A command's own output is the task's text, not the CLI's: xz --long-help prints "memory usage limit"
        # (ProgramBench, nyc-02 2026-10-15 07:32Z), and reading it as a dry seat disabled codex-4 for 9.5 h.
        item = json.dumps({"type": "item.completed", "item": {"id": "item_4", "type": "command_execution",
                           "aggregated_output": "  -M, --memlimit=LIMIT\n      set memory usage limit for compression"}})
        assert codex_pool.usage_limit_in(item + "\n") is None
        assert codex_pool.usage_limit_in(json.dumps({"type": "item.completed", "item": {"type": "agent_message",
                                                      "text": "The usage limit flag is -M."}})) is None
        # The CLI's own failure events still count, in either shape it prints them.
        error = json.dumps({"type": "error", "message": "You've hit your usage limit. Try again at 9:27 AM."})
        assert codex_pool.usage_limit_in(item + "\n" + error + "\n") == error
        failed = json.dumps({"type": "turn.failed", "error": {"message": "usage_limit_reached"}})
        assert codex_pool.usage_limit_in(failed) == failed


def check_plue_env() -> None:
    """The capacity wait runs outside Harbor's start timer, the host ledger is
    FIFO across processes, an oversized guest fails at once, and a lost SSH
    session is a PlueError, not the command's exit status."""
    import asyncio
    import logging
    import types
    import plue_env

    assert [plue_env.slots_for(c) for c in (None, 1, 2, 3, 4, 8)] == [1, 1, 1, 2, 2, 4]

    # The timer control: without the pre-step, a slow reserve inside start()
    # is killed by the timer; with it, the same reserve completes untimed.
    class Env:
        def __init__(self):
            self.order = []

        async def reserve(self):
            await asyncio.sleep(0.2)
            self.order.append("reserve")

        async def start(self, force_build=False):
            self.order.append("start")

    def trial_class():
        class Trial:
            def __init__(self, env):
                self.agent_environment = env

            async def _start_agent_environment(self):
                await asyncio.wait_for(self.agent_environment.start(), timeout=0.05)
        return Trial

    class InsideTimer(Env):
        async def start(self, force_build=False):
            await self.reserve()
            self.order.append("start")

    slow = trial_class()(InsideTimer())
    try:
        asyncio.run(slow._start_agent_environment())
    except (asyncio.TimeoutError, TimeoutError):
        pass
    else:
        raise AssertionError("the control: a wait inside start() must hit the timer")
    Patched = trial_class()
    plue_env.install_untimed_reserve(Patched)
    plue_env.install_untimed_reserve(Patched)  # idempotent
    env = Env()
    asyncio.run(Patched(env)._start_agent_environment())
    assert env.order == ["reserve", "start"], env.order

    with tempfile.TemporaryDirectory() as directory:
        ledger = plue_env.SlotLedger(Path(directory) / "slots.json", capacity=3)
        ledger.enqueue("a", 2)
        ledger.enqueue("b", 2)
        ledger.enqueue("c", 1)
        assert ledger.try_grant("c") is False, "only the head waiter is granted"
        assert ledger.try_grant("a") is True
        assert ledger.try_grant("b") is False, "2 + 2 exceeds 3 slots"
        assert ledger.try_grant("c") is False, "c waits behind b: first come, first served"
        ledger.release("a")
        assert ledger.try_grant("b") is True and ledger.try_grant("c") is True
        state = json.loads((Path(directory) / "slots.json").read_text())
        assert state["used"] == 3 and not state["waiters"], state
        dead = 2 ** 22 + 7
        while plue_env._pid_alive(dead):
            dead += 1
        ledger.release("b")
        ledger.release("c")
        ledger.enqueue("ghost", 3, pid=dead)
        ledger.enqueue("d", 3)
        assert ledger.try_grant("d") is True, "a dead process's entry is dropped"
        ledger.release("d")
        ledger.enqueue("huge", 4)
        assert ledger.try_grant("huge") is True, "an oversized request runs alone rather than never"

        # A fake CLI: `exec` prints the gateway's transport error, or a
        # plain failing command, as the CLI's JSON envelope.
        cli = Path(directory) / "smithers"
        cli.write_text("#!/bin/sh\n"
                       "case \"$*\" in\n"
                       "  *lost*) printf '%s' '{\"data\":{\"stdout\":\"partial\",\"stderr\":\"ERROR: workspace SSH session failed\\n\",\"exit_code\":1}}'; exit 1;;\n"
                       "  *) printf '%s' '{\"data\":{\"stdout\":\"\",\"stderr\":\"grep: no match\\n\",\"exit_code\":1}}'; exit 1;;\n"
                       "esac\n")
        cli.chmod(0o755)
        os.environ["SMITHERS_CLI"] = str(cli)
        os.environ["PLUE_REPO"] = "acme/bench"
        plue_env._EXEC_REATTACH_BACKOFF_SEC = (0,)  # a lost session reattaches once, then fails
        ops = plue_env._PlueOps()
        ops._workspace_id = "ws-1"
        ops.logger = logging.getLogger("check")
        ops.task_env_config = types.SimpleNamespace(workdir=None, cpus=8)
        ops.session_id = "t1"
        try:
            asyncio.run(ops._plue_exec("codex exec lost"))
        except plue_env.PlueError as error:
            assert error.code == "ssh_session_failed", error.code
        else:
            raise AssertionError("a lost SSH session is a PlueError")
        assert asyncio.run(ops._plue_exec("grep x")) == ("", "grep: no match\n", 1), "a command's own failure is its exit"
        assert plue_env.transport_failure("warning\nERROR: workspace SSH session failed\n")
        assert plue_env.transport_failure("ERROR: workspace SSH session failed\nthen the command went on") is None

        os.environ["PLUE_MAX_CPUS"] = "7"
        try:
            asyncio.run(ops._plue_reserve())
        except plue_env.PlueUnplaceable as error:
            assert error.code == "unplaceable" and not ops._plue_ledger_key
        else:
            raise AssertionError("an 8-vCPU guest on 7-vCPU workers fails at once")
        finally:
            for name in ("SMITHERS_CLI", "PLUE_REPO", "PLUE_MAX_CPUS"):
                os.environ.pop(name, None)
    assert plue_env.is_capacity_error(plue_env.PlueError("no healthy Microsandbox worker has sufficient capacity", "WORKSPACE_NO_CAPACITY"))


def check_harness_revision() -> str:
    """A jj workspace whose working-copy operation another workspace's
    `jj op abandon` orphaned still reports its revision. Every jj command that
    snapshots refuses such a workspace, which is how the TB4 arm-A runs of
    2026-09-23 recorded `harnessRevision: null`."""
    import shutil
    import subprocess

    if shutil.which("jj") is None:
        return "skipped (no jj)"

    def jj(cwd: Path, *args: str) -> str:
        return subprocess.run(["jj", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout

    with tempfile.TemporaryDirectory() as directory:
        main, bench = Path(directory) / "main", Path(directory) / "bench"
        jj(Path(directory), "git", "init", "main")
        (main / "f").write_text("a\n")
        jj(main, "commit", "-m", "one")
        jj(main, "workspace", "add", str(bench))
        (bench / "g").write_text("b\n")
        jj(bench, "status")
        (main / "h").write_text("c\n")
        jj(main, "status")
        oldest_kept = jj(main, "op", "log", "--no-graph", "-T", 'id.short() ++ "\\n"').split()[2]
        jj(main, "op", "abandon", f"..{oldest_kept}")
        refused = subprocess.run(["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"], cwd=bench, capture_output=True, text=True)
        assert refused.returncode != 0, "the fixture reproduces an orphaned working-copy operation"
        parent = jj(main, "log", "-r", "bench@-", "--no-graph", "-T", "commit_id").strip()
        assert agent.harness_revision(bench) == parent, "the revision is read without snapshotting the working copy"
    return "held"


def check_names() -> None:
    assert agent.compose_project_name("wal-recovery-ordering__gRvUHdP") == "wal-recovery-ordering__grvuhdp"
    assert agent.compose_project_name("_x.y") == "0_x-y"
    assert agent.seat_of("openai/gpt-6-sol") == "openai:gpt-6-sol"
    assert agent.seat_of("openai:gpt-6-sol") == "openai:gpt-6-sol"
    assert agent.seat_of("gpt-6-sol") == "openai:gpt-6-sol"
    try:
        agent.seat_of(None)
    except ValueError:
        pass
    else:
        raise AssertionError("a missing model is refused")


if __name__ == "__main__":
    check_prompt()
    check_environment()
    validation = check_journal()
    check_helper()
    check_names()
    check_plue_shim()
    check_plue_env()
    check_container_gate()
    check_codex_usage()
    image_user = check_codex_runs_as_image_user()
    install = check_codex_installs_only_what_is_missing()
    check_container_survival()
    check_judge_preflight()
    check_drive()
    check_drive_cancelled()
    check_accounts()
    revision = check_harness_revision()
    print(f"check_agent.py: prompt, environment, journal fold, helper lookup, names, plue shim, plue environment, "
          f"the judge preflight, the CLI's one `up` process and its cancellation, and account pool hold; "
          f"stock arm's image user {image_user}; its install {install}; harness revision {revision}; trajectory {validation}.")

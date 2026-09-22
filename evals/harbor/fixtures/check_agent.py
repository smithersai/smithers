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
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import smithers_agent as agent  # noqa: E402

DDL = """CREATE TABLE flows_journal_events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL, source_seq INTEGER NOT NULL, emitted_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, meta_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq))"""

INSTRUCTION = "Repair the storage engine under /app so recovery replays the log in order."
ROUTE = {"routeId": "openai-chatgpt", "protocolId": "openai-responses-chatgpt", "modelId": "gpt-6-sol"}
BINDING = dict(ROUTE)


def synthetic_journal(path: Path) -> None:
    events = [
        ("control.agent.turn-opened", {"seat": "openai:gpt-6-sol"}),
        ("control.agent.model-requested", {"seat": "openai:gpt-6-sol", **ROUTE}),
        ("control.agent.model-settled", {"text": "```js\nawait bash({...})\n```",
                                         "usage": {"inputTokens": 1000, "cachedInputTokens": 200, "outputTokens": 50,
                                                   "reasoningTokens": 10}, "durationMillis": 1234}),
        ("control.agent.cell-produced", {"cell": {"language": "js", "text": "await bash({command: 'ls /app'})", "digest": "d1"}}),
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
    text = agent.render_prompt(INSTRUCTION, seat="openai:gpt-6-sol", container="abc123", cwd="/app", commit=False)
    assert text.startswith("---\n"), "the flow file opens with frontmatter"
    assert "model: openai:gpt-6-sol\n" in text, "the seat is the frontmatter model"
    assert 'container: "abc123"' in text and 'cwd: "/app"' in text, "the container and cwd are taught"
    assert text.rstrip().endswith(INSTRUCTION), "the instruction is the last thing in the prompt, verbatim"
    assert "{{" not in text, "every placeholder is filled"
    for forbidden in ("tests/", "solution/", "solve.sh", "FAIL_TO_PASS"):
        assert forbidden not in text, f"the prompt never names {forbidden}"
    assert "git add -A" not in text, "no commit paragraph unless commit mode is on"
    committed = agent.render_prompt(INSTRUCTION, seat="s", container="c", cwd="/app", commit=True)
    assert "git add -A && git commit" in committed, "commit mode teaches the commit rule"
    assert committed.count(INSTRUCTION) == 1


def check_environment() -> None:
    base = {"OPENAI_API_KEY": "sk-x", "SMITHERS_TEST_COMMAND": "pytest", "PATH": "/bin", "SMITHERS_OPENAI_AUTH": "api-key"}
    chatgpt = agent.cli_environment(base, auth_mode="chatgpt")
    assert chatgpt["SMITHERS_OPENAI_AUTH"] == "chatgpt"
    assert "OPENAI_API_KEY" not in chatgpt, "the chatgpt mode cannot fall back to the API key"
    assert "SMITHERS_TEST_COMMAND" not in chatgpt, "no stale test runner reaches the run"
    assert chatgpt["PATH"] == "/bin"
    assert agent.HELPER_VARIABLE not in chatgpt, "no helper is named when none is given"
    named = agent.cli_environment(base, auth_mode="chatgpt", helper=Path("/opt/smithers-jj-export"))
    assert named[agent.HELPER_VARIABLE] == "/opt/smithers-jj-export"
    api = agent.cli_environment(base, auth_mode="api-key")
    assert api["SMITHERS_OPENAI_AUTH"] == "api-key" and api["OPENAI_API_KEY"] == "sk-x"
    assert base["SMITHERS_OPENAI_AUTH"] == "api-key", "the caller's dict is not mutated"


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
    assert summary["usage"] == {"inputTokens": 3000, "cachedInputTokens": 1100, "outputTokens": 120, "reasoningTokens": 10}, summary
    assert summary["seat"] == "openai:gpt-6-sol"
    assert summary["frames"] == 2 and summary["modelCalls"] == 2 and summary["calls"] == 3
    assert summary["bindings"] == [BINDING], f"one distinct route is recorded: {summary['bindings']}"
    assert summary["status"] == "completed" and summary["output"] == "fixed recovery order"
    assert summary["spanMillis"] == 16_000

    document = agent.trajectory(events, agent_name="smithers", agent_version="1.0.0-rc.0", seat="openai:gpt-6-sol",
                                instruction=INSTRUCTION, session_id="trial-1", extra={"authMode": "chatgpt"})
    steps = document["steps"]
    assert [step["step_id"] for step in steps] == [1, 2, 3], "step ids are sequential from 1"
    assert steps[0]["source"] == "user" and steps[0]["message"] == INSTRUCTION
    assert steps[1]["source"] == "agent" and len(steps[1]["tool_calls"]) == 2
    assert steps[1]["metrics"] == {"prompt_tokens": 1000, "completion_tokens": 50, "cached_tokens": 200,
                                   "extra": {"reasoning_tokens": 10, "duration_millis": 1234}}
    assert steps[1]["extra"]["cell"] == "await bash({command: 'ls /app'})"
    ids = {call["tool_call_id"] for call in steps[1]["tool_calls"]}
    results = steps[1]["observation"]["results"]
    assert [result["source_call_id"] for result in results] == sorted(ids), "each result names its own step's call"
    assert results[1]["content"] == "exit 1" and results[1]["extra"]["outcome"] == "failure"
    assert steps[2]["tool_calls"][0]["function_name"] == "bash"
    assert steps[2]["observation"]["results"][0]["content"] == "print(1)"
    assert document["final_metrics"] == {"total_prompt_tokens": 3000, "total_completion_tokens": 120,
                                         "total_cached_tokens": 1100, "total_steps": 3}
    assert document["schema_version"] == "ATIF-v1.8" and document["agent"]["model_name"] == "openai:gpt-6-sol"

    try:
        from harbor.models.trajectories import Trajectory  # type: ignore[import-not-found]
    except ImportError:
        return "structural only (harbor not importable)"
    Trajectory.model_validate(document)
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
    print(f"check_agent.py: prompt, environment, journal fold, helper lookup and names hold; trajectory {validation}.")

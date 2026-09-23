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
    assert "\neffort: max\n" in text, "every task runs at the top reasoning effort"
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


def check_plue_shim() -> None:
    environ = {"SMITHERS_CLI": "/opt/plue", "PLUE_REPO": "acme/bench", "TOKEN": "t0", "PATH": "/bin"}
    args, stdin = plue_docker.translate(
        ["exec", "-i", "-w", "/app", "-e", "TOKEN", "-e", "MISSING", "--", "ws-1", "bash", "-lc", 'exec "$@"', "bash", "python3", "-"],
        environ,
    )
    assert stdin is True
    assert args[:4] == ["/opt/plue", "workspace", "exec", "ws-1"]
    assert args[4:10] == ["--repo", "acme/bench", "--user", "root", "--timeout", "0"]
    assert ["--cwd", "/app"] == args[args.index("--cwd"):args.index("--cwd") + 2]
    assert args[args.index("--env") + 1] == "TOKEN=t0" and args.count("--env") == 1, "unset names are not forwarded"
    assert args[-2] == "--command", args
    assert args[-1] == plue_docker.EGRESS_PREFIX + "exec bash -lc 'exec \"$@\"' bash python3 -", args[-1]
    assert args[-1].startswith("if [ -r /etc/smithers/egress.env ]"), "the sandbox egress proxy reaches the command"
    import plue_env
    assert plue_env.with_egress("ls") == plue_env.EGRESS_PREFIX + "ls" and plue_env.EGRESS_PREFIX == plue_docker.EGRESS_PREFIX
    plain, stdin = plue_docker.translate(["exec", "--", "ws-1", "bash", "-lc", "ls"], environ)
    assert stdin is False and "--cwd" not in plain and "--env" not in plain
    for bad in (["ps"], ["exec", "--", "ws-1"], ["exec", "-t", "--", "ws-1", "true"]):
        try:
            plue_docker.translate(bad, environ)
        except ValueError:
            pass
        else:
            raise AssertionError(f"refused: {bad}")
    try:
        plue_docker.translate(["exec", "--", "ws-1", "true"], {"SMITHERS_CLI": "x"})
    except ValueError:
        pass
    else:
        raise AssertionError("PLUE_REPO is required")
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
        shim = agent.shim_directory(Path(directory))
        assert (shim / "docker").resolve() == agent.PLUE_SHIM.resolve() and os.access(shim / "docker", os.X_OK)
        env = agent.cli_environment({"PATH": "/bin"}, auth_mode="chatgpt", shim=shim, codex_home=Path("/h/codex-2"))
        assert env["PATH"].startswith(str(shim) + os.pathsep) and env["CODEX_HOME"] == "/h/codex-2"
        assert "CODEX_HOME" not in agent.cli_environment({"PATH": "/bin"}, auth_mode="chatgpt")
    for name in ("SeatExhausted", "ModelRouteError", "NoSeatLeft"):
        assert issubclass(getattr(accounts, name), Exception), name


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

    assert accounts.mentions_usage_limit("ERROR: You've hit your usage limit. Try again at 4pm")
    assert accounts.mentions_usage_limit('{"type":"usage_limit_reached"}')
    assert not accounts.mentions_usage_limit("rate limit exceeded, retrying"), "a transient 429 is not a usage limit"
    reset = accounts.reset_time_of("ERROR: You’ve hit your usage limit. Visit https://x or try again at Sep 27th, 2026 9:27 AM.")
    assert reset is not None and reset.startswith("2026-09-27T"), reset
    assert accounts.reset_time_of('{"resets_at":"2026-09-27T16:27:00Z"}') == "2026-09-27T16:27+00:00"
    assert accounts.reset_time_of("The usage limit has been reached") is None

    assert accounts.classify_cause("rate_limited: The usage limit has been reached\n/harness/HarnessError: x") == "seat"
    assert accounts.classify_cause("quota_exceeded: insufficient_quota") == "seat"
    assert accounts.classify_cause("rate_limited: 429 after 6 attempts") == "infra"
    for code in ("authentication", "no_route", "provider_internal", "transport", "call_timeout", "completion_unjudged"):
        assert accounts.classify_cause(f"{code}: gateway 503") == "infra", code
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

    try:
        import codex_pool  # needs harbor
    except ImportError:
        pass
    else:
        assert codex_pool.usage_limit_in("thinking\nERROR: You've hit your usage limit. Visit …\n") == "ERROR: You've hit your usage limit. Visit …"
        assert codex_pool.usage_limit_in("all done, 3 files changed") is None


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
    check_accounts()
    print(f"check_agent.py: prompt, environment, journal fold, helper lookup, names, plue shim and account pool hold; "
          f"trajectory {validation}.")

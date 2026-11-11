"""Offline behavioral checks through the report.py CLI and its report files.

    python3 -B fixtures/check_report.py

Two synthetic Harbor jobs, one per arm, shaped like the retained
`luna-tb4-full` and `luna-B-smoke` trials. No Harbor install, network or
model seat is needed.
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import check_calls  # noqa: E402
import smithers_agent  # noqa: E402

REPORT = HERE.parent / "report.py"
AUDIT = HERE.parent / "audit_host_calls.py"
SMITHERS = "packages.smithers.agent.harness.benchmarks.harbor.smithers_agent:SmithersAgent"
BASELINE = "packages.smithers.agent.harness.benchmarks.harbor.codex_pool:PooledCodex"
MODEL = "openai/gpt-6-sol"
ENVIRONMENT = "packages.smithers.agent.harness.benchmarks.harbor.plue_env:PlueEnvironment"
# The agent phase's network as each suite's task.toml declares it.
TB4 = "[agent]\ntimeout_sec = 900.0\n"  # nothing declared: public
DEEPSWE = '[agent]\nnetwork_mode = "no-network"\n'
SWEPRO = '[agent]\nnetwork_mode = "no-network"\n\n[environment]\nnetwork_mode = "public"\n'
LEGACY = "[environment]\nallow_internet = false\n"
ALLOWLIST = '[agent]\nnetwork_mode = "allowlist"\nallowed_hosts = ["pypi.org"]\n'
MODEL_ROUTE = ["chatgpt.com", "auth.openai.com"]
OPENED = "denied https://github.com/ connected (http 200)"


def attempts(*denied: tuple[int, int]) -> list[dict]:
    """The five probe attempts a trial saves: the model route reached, then
    github.com through the agent's route, github.com and 1.1.1.1 around it,
    each as (curl exit, http status)."""
    reached = [{"kind": "allowed", "url": url, "curl": 0, "http": 403, "proxy": 0}
               for url in ("https://chatgpt.com/", "https://auth.openai.com/")]
    tried = (("denied", "https://github.com/"), ("denied-direct", "https://github.com/"),
             ("denied-direct", "https://1.1.1.1/"))
    return reached + [{"kind": kind, "url": url, "curl": curl, "http": http, "proxy": 0}
                      for (kind, url), (curl, http) in zip(tried, denied)]


REFUSED = attempts((56, 0), (6, 0), (7, 0))  # Pier's proxy and network none
CUT = attempts((35, 0), (35, 0), (35, 0))  # Harbor's egress control, nyc-01
OPEN = attempts((0, 200), (6, 0), (7, 0))
DDL = """CREATE TABLE flows_journal_events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL, source_seq INTEGER NOT NULL, emitted_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, meta_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq))"""


class ReportCLI(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="report-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.jobs = {"smithers": self.root / "smithers-job", "baseline": self.root / "baseline-job"}
        self.job("smithers", SMITHERS)
        self.job("baseline", BASELINE)
        self.serial = 0

    def job(self, arm: str, agent: str, *, environment: dict | None = None, **extra: object) -> None:
        """`environment` None writes the plue environment; {} names none, as
        Harbor 0.23.0 writes a job run without `-e`."""
        self.jobs[arm].mkdir(exist_ok=True)
        named = {"import_path": ENVIRONMENT} if environment is None else environment
        (self.jobs[arm] / "config.json").write_text(json.dumps({
            "job_name": self.jobs[arm].name,
            **({"environment": named} if named else {}),
            "agents": [{"name": agent, "model_name": MODEL, "kwargs": {"arm": arm}}],
            "datasets": [{"name": "terminal-bench/terminal-bench", "ref": "sha256:d1"}],
            **extra,
        }))

    def trial(self, arm: str, task: str, *, reward: float | None = 1.0, exception: str | None = None,
              tokens: tuple = (1000, 800, 50), checksum: str | None = None, host_command: str | None = None,
              config: dict | None = None, succeeded: int = 3, refused_input: dict | None = None,
              task_toml: str | None = None, sealed: bool | None = True, seal: dict | None = None,
              file_calls: tuple = (), sealed_to: str | None = None) -> Path:
        """`task_toml` writes the task's own `task.toml` where the trial's config
        says the task lives; without it the task is a registry name the report
        cannot open. `sealed` saves the stock arm's probe: every denied attempt
        refused, or github.com reached; None saves no seal record. `seal` saves
        that record as given, its `sealed` the stored verdict."""
        self.serial += 1
        directory = self.jobs[arm] / f"{task}__{arm[:1]}{self.serial:04d}"
        summary = self.jobs[arm] / "result.json"
        planned = json.loads(summary.read_text())["n_total_trials"] if summary.is_file() else 0
        summary.write_text(json.dumps({"n_total_trials": planned + 1}))
        (directory / "agent").mkdir(parents=True)
        trial_config = {
            "task": {"name": f"terminal-bench/{task}"},
            "timeout_multiplier": 1.0,
            "agent": {"name": SMITHERS if arm == "smithers" else BASELINE, "import_path": None, "model_name": MODEL,
                      "kwargs": {"arm": arm}, "extra_allowed_hosts": [], "override_timeout_sec": None},
            "environment": {"import_path": ENVIRONMENT, "mounts": None, "extra_allowed_hosts": [],
                            "override_cpus": None},
            "verifier": {"override_timeout_sec": None},
        }
        if task_toml is not None:
            task_dir = self.root / "tasks" / task
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "task.toml").write_text(task_toml)
            trial_config["task"] = {"path": str(task_dir), "source": "fixture"}
        for section, values in (config or {}).items():
            if isinstance(values, dict):
                trial_config[section].update(values)
            else:
                trial_config[section] = values
        (directory / "config.json").write_text(json.dumps({"trial_name": directory.name}))
        reached = {"attempted": succeeded + 1, "succeeded": succeeded}
        if seal is None and sealed is not None:
            seal = {"sealed": sealed, "attempts": REFUSED if sealed else OPEN, "webSearches": 0,
                    **({} if sealed else {"reason": OPENED})}
        proof = {} if arm == "smithers" or seal is None else {"sealed": seal.get("sealed"), "seal": seal}
        result = {
            "task_name": f"terminal-bench/{task}",
            "trial_name": directory.name,
            "task_checksum": checksum or f"sum-{task}",
            "config": trial_config,
            "agent_result": {
                "n_input_tokens": tokens[0], "n_cache_tokens": tokens[1], "n_output_tokens": tokens[2],
                "metadata": {"container_commands": reached, **proof,
                             **({"harness_revision": "abc123"} if arm == "smithers" else {})},
            },
            "verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
            "exception_info": {"exception_type": exception, "exception_message": "x"} if exception else None,
            "started_at": f"2026-10-01T00:{self.serial % 60:02d}:00Z",
            "finished_at": f"2026-10-01T01:{self.serial % 60:02d}:00Z",
        }
        (directory / "result.json").write_text(json.dumps(result))
        (directory / "agent" / "trajectory.json").write_text("{}")
        if arm == "smithers":
            self.journal(directory, host_command, refused_input, file_calls)
            if sealed_to is not None:
                (directory / "agent" / "smithers-run.json").write_text(json.dumps({"container": sealed_to}))
        else:
            (directory / "agent" / "codex-account.json").write_text(json.dumps({"containerCommands": reached, **proof}))
        return directory

    def journal(self, trial: Path, host_command: str | None, refused_input: dict | None = None,
                file_calls: tuple = ()) -> None:
        """`refused_input` is the journalled input of one more `bash` call, which
        the harness refused before it ran. `file_calls` are `(flow, input)`
        calls to the file flows."""
        flows = trial / "agent" / "workspace" / ".flows"
        flows.mkdir(parents=True)
        ran = {"outcome": "success", "value": {"exitCode": 0}}
        calls = [("bash", {"command": "ls /app", "container": "ws-1", "mode": "unhermetic"}, ran)]
        if host_command:
            calls.append(("bash", {"command": host_command, "mode": "unhermetic"}, ran))
        if refused_input:
            calls.append(("bash", refused_input, {"outcome": "failure", "code": "invalid_input", "reason": "too_large",
                                                  "message": "x"}))
        calls.extend((flow, given, {"outcome": "success", "value": {}}) for flow, given in file_calls)
        connection = sqlite3.connect(flows / "control.db")
        connection.execute(DDL)
        seq = 0
        for index, (flow, given, settled) in enumerate(calls):
            for kind, payload in (
                ("control.agent.cell-call-started", {"callId": f"c{index}", "flowName": flow, "input": given}),
                ("control.agent.cell-call-settled", {"callId": f"c{index}", **settled}),
            ):
                connection.execute("insert into flows_journal_events values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                   ("r", seq, f"e{seq}", "f", seq, seq, kind, json.dumps(payload), "{}"))
                seq += 1
        connection.commit()
        connection.close()

    def recorded(self, arm: str, task: str, *, minutes: float, journal: list | None = None) -> Path:
        """A trial with the records a real one keeps: the Smithers arm's
        trajectory as the adapter folds `journal`, the baseline's Codex
        session log, and the runner's timing of the agent."""
        if arm == "smithers":
            events = check_calls.journal() if journal is None else journal
            used = smithers_agent.summarize(events)["usage"]
            directory = self.trial(arm, task, tokens=(used["inputTokens"], used["cachedInputTokens"], used["outputTokens"]))
            document = smithers_agent.trajectory(events, agent_name="smithers", agent_version="test",
                                                 seat="openai:seat-model", instruction="i", session_id="s")
            (directory / "agent" / "trajectory.json").write_text(json.dumps(document))
        else:
            directory = self.trial(arm, task, tokens=(39_000, 34_000, 900))
            sessions = directory / "agent" / "sessions" / "2026" / "01" / "01"
            sessions.mkdir(parents=True)
            (sessions / "rollout-2026-01-01T00-00-00-fixture.jsonl").write_text("\n".join(check_calls.session()) + "\n")
        result = json.loads((directory / "result.json").read_text())
        result["agent_execution"] = {"started_at": "2026-10-01T00:00:00Z",
                                     "finished_at": f"2026-10-01T00:{int(minutes):02d}:{round(minutes % 1 * 60):02d}Z"}
        (directory / "result.json").write_text(json.dumps(result))
        return directory

    def paired(self, tasks: int, *, solved: dict[str, int] | None = None) -> None:
        solved = solved or {"smithers": tasks, "baseline": tasks}
        for index in range(tasks):
            for arm in ("smithers", "baseline"):
                self.trial(arm, f"task-{index:03d}", reward=1.0 if index < solved[arm] else 0.0)

    def run_report(self, expected_exit: int, *extra: str) -> tuple[str, dict]:
        out = self.root / "out" / "nested"
        process = subprocess.run(
            [sys.executable, "-B", str(REPORT), str(self.jobs["smithers"]), str(self.jobs["baseline"]), str(out), *extra],
            text=True, capture_output=True, timeout=60,
        )
        self.assertEqual(process.returncode, expected_exit, process.stdout + process.stderr)
        self.assertEqual(process.stderr, "")
        text = (out / "report.md").read_text()
        self.assertEqual(text, process.stdout, "stdout and the persisted report must agree")
        return text, json.loads((out / "report.json").read_text())

    def assert_refused(self, *reasons: str) -> dict:
        text, report = self.run_report(3)
        self.assertFalse(report["publishable"])
        self.assertIsNone(report["results"], "a refused report carries no pass rates")
        self.assertIn("**Not publishable.**", text)
        self.assertNotIn("Pass rate", text)
        for reason in reasons:
            self.assertIn(reason, report["refusals"])
            self.assertIn(f"- {reason}\n", text)
        return report

    def test_fifty_sealed_paired_tasks_publish_rates_and_tokens(self) -> None:
        self.paired(50, solved={"smithers": 30, "baseline": 25})
        text, report = self.run_report(0)
        self.assertTrue(report["publishable"], report["refusals"])
        self.assertEqual(report["refusals"], [])
        self.assertEqual(report["pairedTasks"], 50)
        self.assertEqual(report["results"]["smithers"]["passRate"], 0.6)
        self.assertEqual(report["results"]["baseline"]["passRate"], 0.5)
        self.assertEqual(report["results"]["smithers"]["solved"], 30)
        self.assertEqual(report["results"]["baseline"]["tokens"], {"input": 50_000, "cached": 40_000, "output": 2_500})
        self.assertEqual(report["results"]["smithers"]["harnessRevisions"], ["abc123"])
        self.assertIn(f"| {SMITHERS} | 60.0% | 30 of 50 | 50,000 | 40,000 | 2,500 |\n", text)
        self.assertIn(f"| {BASELINE} | 50.0% | 25 of 50 | 50,000 | 40,000 | 2,500 |\n", text)
        self.assertIn("- 50 paired tasks; attempts per task: 1.\n", text)
        self.assertIn("| terminal-bench/task-000 | 1.0 | 1.0 |\n", text)
        self.assertIn("| terminal-bench/task-049 | 0.0 | 0.0 |\n", text)
        first = report["tasks"][0]
        self.assertEqual(first["smithers"]["trajectories"], [f"{first['smithers']['trials'][0]}/agent/trajectory.json"])
        again_text, again = self.run_report(0)
        self.assertEqual((again_text, again), (text, report), "the report is deterministic")

    def test_forty_nine_paired_tasks_are_refused_and_min_tasks_is_a_parameter(self) -> None:
        self.paired(49)
        self.assert_refused("49 paired tasks; 50 required")
        text, report = self.run_report(0, "--min-tasks", "49")
        self.assertEqual(report["pairedTasks"], 49)
        self.assertIn("100.0%", text)

    def test_missing_usage_is_refused_per_trial(self) -> None:
        self.paired(2)
        trial = self.trial("baseline", "task-002", tokens=(None, None, None))
        self.trial("smithers", "task-002", tokens=(10, None, 5))
        report = self.assert_refused(f"baseline: {trial.name} reports no n_input_tokens, n_cache_tokens, n_output_tokens")
        self.assertTrue(any(r.endswith("reports no n_cache_tokens") and r.startswith("smithers: ") for r in report["refusals"]),
                        report["refusals"])

    def test_a_trial_re_run_in_place_after_a_usage_limit_is_refused(self) -> None:
        """#4798: harness revisions before the fix re-ran a usage-limited
        attempt in the container it had changed and kept only the last
        attempt's tokens, recording the re-runs as `requeues`."""
        self.paired(50)
        requeued = {}
        for arm in ("smithers", "baseline"):
            trial = next(self.jobs[arm].glob("task-007__*"))
            result = json.loads((trial / "result.json").read_text())
            result["agent_result"]["metadata"]["requeues"] = [{"attempt": 1, "from": "codex-1", "to": "codex-2"}]
            (trial / "result.json").write_text(json.dumps(result))
            requeued[arm] = trial.name
        self.assert_refused(*(f"{arm}: {name} was re-run in place after a usage limit; "
                              "re-run it in a fresh environment before publishing" for arm, name in requeued.items()))

    def test_an_empty_requeue_record_still_publishes(self) -> None:
        self.paired(50)
        trial = next(self.jobs["smithers"].glob("task-007__*"))
        result = json.loads((trial / "result.json").read_text())
        result["agent_result"]["metadata"]["requeues"] = []
        (trial / "result.json").write_text(json.dumps(result))
        self.assertTrue(self.run_report(0)[1]["publishable"])

    def test_a_smithers_host_call_unseals_the_trial(self) -> None:
        self.paired(1)
        trial = self.trial("smithers", "task-001", host_command="cat ../tests/test_outputs.py")
        self.trial("baseline", "task-001")
        self.assert_refused(f"smithers: {trial.name} is not sealed: host-call audit TAINTED")

    def test_a_benign_host_call_still_unseals_the_trial(self) -> None:
        self.paired(1)
        trial = self.trial("smithers", "task-001", host_command="uname -a")
        self.trial("baseline", "task-001")
        self.assert_refused(f"smithers: {trial.name} is not sealed: host-call audit host-calls-benign")

    def test_a_forbidden_name_at_the_start_of_a_script_line_taints_the_trial(self) -> None:
        """The audit reads the script's decoded lines. In its JSON encoding a
        name after a newline or tab follows the escape's letter, which the
        patterns' lookbehinds refuse."""
        for index, (command, flag) in enumerate((("cd /task\ntests/run.sh", "tests_dir"), ("ls\n\tjobs/", "jobs_dir"))):
            trial = self.trial("smithers", f"task-{index:03d}", host_command=command)
            _, audit = self.audit(trial)
            self.assertEqual((audit["verdict"], audit["hostCalls"][0]["flags"]), ("TAINTED", [flag]), command)

    FILE_CALLS = (("grep", {"pattern": "needle"}), ("read", {"path": "src/mod.py"}),
                  ("edit", {"path": "src/mod.py", "oldString": "a", "newString": "b"}),
                  ("apply_patch", {"input": "*** Begin Patch\n*** Add File: src/new.py\n+x\n*** End Patch"}))

    def test_a_sealed_trials_file_flow_calls_ran_in_its_container(self) -> None:
        """The sealed CLI binds the file flows to the task container's files, so
        a trial whose record names that container made no host call by using them."""
        self.paired(1)
        trial = self.trial("smithers", "task-001", file_calls=self.FILE_CALLS, sealed_to="ws-1")
        self.trial("baseline", "task-001")
        _, report = self.run_report(0, "--min-tasks", "2")
        self.assertTrue(report["publishable"], report["refusals"])
        text, audit = self.audit(trial)
        self.assertEqual((audit["verdict"], audit["containerCalls"], audit["hostCalls"]), ("clean", 5, []))
        self.assertIn(f"clean              {trial.parent.name}/{trial.name}  host=0 container=5 journal=kept\n", text)

    def test_a_file_flow_call_with_no_seal_on_record_is_a_host_call(self) -> None:
        """Without the record, nothing shows the CLI was sealed, and an unsealed
        CLI's file flows read and write this host."""
        self.paired(1)
        trial = self.trial("smithers", "task-001", file_calls=self.FILE_CALLS[1:2])
        self.trial("baseline", "task-001")
        self.assert_refused(f"smithers: {trial.name} is not sealed: host-call audit host-calls-benign")
        _, audit = self.audit(trial)
        self.assertEqual((audit["verdict"], [call["flow"] for call in audit["hostCalls"]]),
                         ("host-calls-benign", ["read"]))

    def audit(self, trial: Path) -> tuple[str, dict]:
        """The audit's listing of one trial, as text and as JSON."""
        runs = [subprocess.run([sys.executable, "-B", str(AUDIT), str(trial), *flag], text=True, capture_output=True,
                               timeout=120) for flag in ((), ("--json",))]
        self.assertEqual([run.stderr for run in runs], ["", ""])
        (listed,) = json.loads(runs[1].stdout)
        return runs[0].stdout, listed

    def test_a_bare_truncation_marker_stays_unsealed_and_the_audit_says_its_target_is_unknown(self) -> None:
        """A journal from before routing fields were kept holds only a digest
        of an input too large to keep, which hides the call's container.
        Nothing shows it reached the task container, so the trial stays
        unsealed; the output says why, so the reader need not open the journal."""
        marker = {"truncated": True, "bytes": 73_691, "digest": "ab" * 32}
        self.paired(1)
        trial = self.trial("smithers", "task-001", refused_input=marker)
        self.trial("baseline", "task-001")
        self.assert_refused(f"smithers: {trial.name} is not sealed: host-call audit host-calls-unread "
                            "(target unknown for 1 call: the journal truncated its input)")
        process = subprocess.run([sys.executable, "-B", str(AUDIT), str(trial)], text=True, capture_output=True, timeout=60)
        self.assertEqual((process.returncode, process.stderr), (0, ""))
        self.assertIn(f"host-calls-unread  {trial.parent.name}/{trial.name}  host=1 container=1 journal=kept unknown=1\n",
                      process.stdout)
        self.assertIn("    seq 2 bash exit=None code=invalid_input reason=too_large outcome=failure cwd=None TARGET UNKNOWN: "
                      "the journal kept a digest of this call's 73,691-byte input and nothing else, so its container and "
                      f"command are not recorded: digest {'ab' * 32}\n", process.stdout)
        (audit,) = json.loads(subprocess.run([sys.executable, "-B", str(AUDIT), str(trial), "--json"], text=True,
                                             capture_output=True, timeout=60).stdout)
        (call,) = audit["hostCalls"]
        self.assertEqual((audit["verdict"], audit["unknownTargets"], call["target"], call["truncated"], call["outcome"]),
                         ("host-calls-unread", 1, "unknown", {"bytes": 73_691, "digest": "ab" * 32}, "failure"))

    def test_a_truncated_input_that_kept_its_container_is_a_container_call(self) -> None:
        """Since the journal keeps an oversized input's small fields beside
        its digest, the call says where it was aimed and is read like any other."""
        self.paired(1)
        trial = self.trial("smithers", "task-001", refused_input={
            "container": "ws-1", "cwd": "/app", "interpreter": "python3", "truncated": True, "bytes": 73_691,
            "digest": "ab" * 32})
        self.trial("baseline", "task-001")
        _, report = self.run_report(0, "--min-tasks", "2")
        self.assertTrue(report["publishable"], report["refusals"])
        text, audit = self.audit(trial)
        self.assertEqual((audit["verdict"], audit["containerCalls"], audit["unknownTargets"], audit["hostCalls"]),
                         ("clean", 2, 0, []))
        self.assertIn(f"clean              {trial.parent.name}/{trial.name}  host=0 container=2 journal=kept\n", text)

    def test_a_truncated_input_that_kept_its_fields_and_names_no_container_is_a_host_call(self) -> None:
        """The kept fields show the call was aimed at no container, so its
        target is the host and is not unknown. Its command is still not
        recorded, and what was kept is still read for a forbidden name."""
        self.paired(1)
        kept = {"cwd": "/work", "interpreter": "python3", "truncated": True, "bytes": 73_691, "digest": "ab" * 32}
        trial = self.trial("smithers", "task-001", refused_input=kept)
        self.trial("baseline", "task-001")
        self.assert_refused(f"smithers: {trial.name} is not sealed: host-call audit host-calls-unread")
        text, audit = self.audit(trial)
        (call,) = audit["hostCalls"]
        self.assertEqual((audit["verdict"], audit["unknownTargets"], call["target"], call["truncated"], call["cwd"]),
                         ("host-calls-unread", 0, "host", {"bytes": 73_691, "digest": "ab" * 32}, "/work"))
        self.assertEqual((call["code"], call["reason"]), ("invalid_input", "too_large"))
        self.assertIn(f"host-calls-unread  {trial.parent.name}/{trial.name}  host=1 container=1 journal=kept\n", text)
        self.assertIn("    seq 2 bash exit=None code=invalid_input reason=too_large outcome=failure cwd=/work INPUT TRUNCATED: "
                      "the journal kept this call's small fields and a digest of its 73,691-byte input; it names no "
                      f"container and its command is not recorded: interpreter=python3 digest {'ab' * 32}\n", text)
        tainted = self.trial("smithers", "task-002", refused_input={**kept, "cwd": "/work/tests"})
        self.assertEqual(self.audit(tainted)[1]["verdict"], "TAINTED", "a kept field is read like any other input")

    def test_a_host_call_is_listed_as_before(self) -> None:
        self.paired(1)
        trial = self.trial("smithers", "task-001", host_command="uname -a")
        process = subprocess.run([sys.executable, "-B", str(AUDIT), str(trial)], text=True, capture_output=True, timeout=60)
        self.assertIn(f"host-calls-benign  {trial.parent.name}/{trial.name}  host=1 container=1 journal=kept\n", process.stdout)
        self.assertIn("    seq 2 bash exit=0 cwd=None: uname -a\n", process.stdout)
        (audit,) = json.loads(subprocess.run([sys.executable, "-B", str(AUDIT), str(trial), "--json"], text=True,
                                             capture_output=True, timeout=60).stdout)
        self.assertEqual((audit["unknownTargets"], audit["hostCalls"][0]["target"]), (0, "host"))
        self.assertNotIn("truncated", audit["hostCalls"][0])

    def test_extra_hosts_mounts_and_no_container_command_unseal(self) -> None:
        hosts = self.trial("baseline", "task-000", config={"agent": {"extra_allowed_hosts": ["example.com"]}})
        mounts = self.trial("baseline", "task-001", config={"environment": {"mounts": ["/data:/data"]}})
        idle = self.trial("baseline", "task-002", succeeded=0)
        for index in range(3):
            self.trial("smithers", f"task-{index:03d}")
        self.assert_refused(
            f"baseline: {hosts.name} is not sealed: agent extra_allowed_hosts ['example.com']",
            f"baseline: {mounts.name} is not sealed: environment mounts ['/data:/data']",
            f"baseline: {idle.name} is not sealed: no command exited 0 in the task container",
        )

    def test_only_the_stock_arm_may_add_its_model_route(self) -> None:
        """On a task that denies the agent network the stock Codex CLI still
        needs its model: Harbor's `--allow-agent-host` records the route as
        extra agent hosts (nyc-01 SWE-bench Pro V2). Any other host, or any
        host for the Smithers arm, which calls its model from the host, unseals."""
        route = self.trial("baseline", "task-000", task_toml=SWEPRO, config={"agent": {"extra_allowed_hosts": MODEL_ROUTE}})
        mixed = self.trial("baseline", "task-001", config={"agent": {"extra_allowed_hosts": ["chatgpt.com", "example.com"]}})
        self.trial("smithers", "task-000", task_toml=SWEPRO)
        ours = self.trial("smithers", "task-001", config={"agent": {"extra_allowed_hosts": ["chatgpt.com"]}})
        report = self.assert_refused(
            f"baseline: {mixed.name} is not sealed: agent extra_allowed_hosts ['example.com']",
            f"smithers: {ours.name} is not sealed: agent extra_allowed_hosts ['chatgpt.com']")
        self.assertFalse([reason for reason in report["refusals"] if route.name in reason], report["refusals"])

    def test_an_open_network_task_scores_an_unsealed_stock_trial(self) -> None:
        """Terminal-Bench 4.0 gives the agent open network by protocol, and the
        Smithers arm runs in the same open container: the stock arm's
        `sealed: false` there is the suite, not a leak."""
        self.trial("smithers", "tb4-task", task_toml=TB4)
        self.trial("baseline", "tb4-task", task_toml=TB4, sealed=False)
        self.trial("smithers", "explicit-public", task_toml='[environment]\nnetwork_mode = "public"\n')
        self.trial("baseline", "explicit-public", task_toml='[environment]\nnetwork_mode = "public"\n', sealed=False)
        text, report = self.run_report(0, "--min-tasks", "2")
        self.assertTrue(report["publishable"], report["refusals"])
        self.assertEqual(report["network"], {"public": 2})
        self.assertIn("Agent network: public (2 tasks).", text)

    def test_a_network_denied_task_refuses_an_unsealed_stock_trial(self) -> None:
        """DeepSWE's `network none`, SWE-bench Pro V2's offline agent phase, a
        legacy `allow_internet = false` and an allowlist all deny the agent the
        internet: an unsealed stock trial there is never scored. A sealed one is."""
        refused = []
        for task, toml in (("deepswe", DEEPSWE), ("swepro", SWEPRO), ("legacy", LEGACY), ("allowlist", ALLOWLIST)):
            self.trial("smithers", task, task_toml=toml)
            trial = self.trial("baseline", task, task_toml=toml, sealed=False)
            mode = "allowlist" if task == "allowlist" else "no-network"
            refused.append(f"baseline: {trial.name} is not sealed: the task denies the agent network ({mode}) "
                           f"and the stock arm's seal does not hold: {OPENED}")
        self.trial("smithers", "swepro-sealed", task_toml=SWEPRO)
        sealed = self.trial("baseline", "swepro-sealed", task_toml=SWEPRO, config={"agent": {"extra_allowed_hosts": MODEL_ROUTE}})
        self.trial("smithers", "unproven", task_toml=DEEPSWE)
        unproven = self.trial("baseline", "unproven", task_toml=DEEPSWE, sealed=None)
        refused.append(f"baseline: {unproven.name} is not sealed: the task denies the agent network (no-network) "
                       "and the stock arm's seal does not hold: no saved seal attempts")
        report = self.assert_refused(*refused)
        self.assertFalse([reason for reason in report["refusals"] if sealed.name in reason], report["refusals"])
        self.assertEqual(report["network"], {"allowlist": 1, "no-network": 5})

    def test_a_seal_stored_false_on_harbor_s_cut_handshakes_is_judged_again_and_scored(self) -> None:
        """nyc-01's SWE-bench Pro V2 Codex trials stored `sealed: false` before
        curl 35 counted as refused (#3863). The attempts they saved are judged
        again by the current rules: every denied attempt was cut, so the trial
        is sealed and scored, and the report says the verdict changed."""
        self.trial("smithers", "swepro", task_toml=SWEPRO)
        self.trial("baseline", "swepro", task_toml=SWEPRO, config={"agent": {"extra_allowed_hosts": MODEL_ROUTE}},
                   seal={"sealed": False, "reason": "denied https://github.com/ proves nothing: curl exit 35",
                         "attempts": CUT, "webSearches": 0})
        text, report = self.run_report(0, "--min-tasks", "1")
        self.assertTrue(report["publishable"], report["refusals"])
        self.assertEqual(report["sealVerdictsChanged"], {"smithers": 0, "baseline": 1})
        self.assertIn("Seal verdicts judged again from the saved attempts differ from the stored ones: "
                      "smithers 0, baseline 1.", text)

    def test_a_saved_connection_is_refused_whatever_the_stored_verdict(self) -> None:
        self.trial("smithers", "deepswe", task_toml=DEEPSWE)
        trial = self.trial("baseline", "deepswe", task_toml=DEEPSWE,
                           seal={"sealed": True, "attempts": OPEN, "webSearches": 0})
        report = self.assert_refused(f"baseline: {trial.name} is not sealed: the task denies the agent network "
                                     f"(no-network) and the stock arm's seal does not hold: {OPENED}")
        self.assertEqual(report["sealVerdictsChanged"], {"smithers": 0, "baseline": 1})

    def test_missing_or_unreadable_attempts_are_refused(self) -> None:
        """A stored `sealed: true` with nothing to judge it by is not a seal."""
        cases = {
            "no record": (None, "no saved seal attempts"),
            "no attempts": ({"sealed": True, "webSearches": 0}, "no saved seal attempts"),
            "empty attempts": ({"sealed": True, "attempts": [], "webSearches": 0}, "no saved seal attempts"),
            "text": ({"sealed": True, "attempts": "all refused", "webSearches": 0}, "the saved seal attempts are unreadable"),
            "no exit code": ({"sealed": True, "attempts": [{"kind": "denied", "url": "https://github.com/"}],
                              "webSearches": 0}, "the saved seal attempts are unreadable"),
            "one attempt short": ({"sealed": True, "attempts": REFUSED[:-1], "webSearches": 0},
                                  "no denied-direct attempt on https://1.1.1.1/ was recorded"),
        }
        refused = []
        for index, (case, (record, why)) in enumerate(cases.items()):
            task = f"case-{index}"
            self.trial("smithers", task, task_toml=DEEPSWE)
            trial = self.trial("baseline", task, task_toml=DEEPSWE, sealed=None, seal=record)
            refused.append(f"baseline: {trial.name} is not sealed: the task denies the agent network (no-network) "
                           f"and the stock arm's seal does not hold: {why}")
        self.assert_refused(*refused)

    def test_a_saved_web_search_unseals_the_trial(self) -> None:
        """The model backend runs a web search outside the task container, so
        refused attempts do not make up for one. A record that does not say how
        many ran proves nothing."""
        self.trial("smithers", "searched", task_toml=DEEPSWE)
        searched = self.trial("baseline", "searched", task_toml=DEEPSWE,
                              seal={"sealed": True, "attempts": REFUSED, "webSearches": 2})
        self.trial("smithers", "uncounted", task_toml=DEEPSWE)
        uncounted = self.trial("baseline", "uncounted", task_toml=DEEPSWE, seal={"sealed": True, "attempts": REFUSED})
        prefix = "is not sealed: the task denies the agent network (no-network) and the stock arm's seal does not hold"
        self.assert_refused(
            f"baseline: {searched.name} {prefix}: the CLI ran 2 web search(es) outside the task container",
            f"baseline: {uncounted.name} {prefix}: no saved count of web searches")

    def test_a_task_whose_network_cannot_be_read_needs_the_seal(self) -> None:
        """A registry task, or a task directory gone since the run: no proof the
        network was open, so an unsealed stock trial is refused."""
        self.trial("smithers", "task-000")
        trial = self.trial("baseline", "task-000", sealed=False)
        self.trial("smithers", "task-001", task_toml=TB4)
        gone = self.trial("baseline", "task-001", task_toml=TB4, sealed=False)
        (self.root / "tasks" / "task-001" / "task.toml").unlink()
        report = self.assert_refused(
            *(f"baseline: {name} is not sealed: the task's agent network is unknown (no readable task.toml at its "
              f"recorded path) and the stock arm's seal does not hold: {OPENED}" for name in (trial.name, gone.name)))
        self.assertEqual(report["network"], {"unknown": 2})

    def test_a_job_that_names_no_environment_runs_the_runner_s_default(self) -> None:
        """`harbor run` without `-e` writes no environment into the job's
        config, and every trial records Harbor's default, docker. nyc-01's
        burn-swepro-hard51 pair was refused 87 times for it."""
        docker = {"environment": {"import_path": None, "type": "docker"}}
        for arm, agent in (("smithers", SMITHERS), ("baseline", BASELINE)):
            self.job(arm, agent, environment={})
            self.trial(arm, "task-000", config=docker)
        text, report = self.run_report(0, "--min-tasks", "1")
        self.assertTrue(report["publishable"], report["refusals"])
        self.assertEqual(report["arms"]["baseline"]["environment"], "docker")
        self.assertIn("environment `docker`", text)

    def test_a_job_that_names_no_environment_refuses_a_trial_elsewhere(self) -> None:
        """The default stands in for the job only: a trial on another
        environment, or one whose own config names none, is refused."""
        for arm, agent in (("smithers", SMITHERS), ("baseline", BASELINE)):
            self.job(arm, agent, environment={})
        self.trial("smithers", "task-000", config={"environment": {"import_path": None, "type": "docker"}})
        plue = self.trial("baseline", "task-000")
        self.trial("smithers", "task-001", config={"environment": {"import_path": None, "type": "docker"}})
        unnamed = self.trial("baseline", "task-001", config={"environment": {"import_path": None, "type": None}})
        self.assert_refused(f"baseline: {plue.name} ran environment {ENVIRONMENT}, not the job's docker",
                            f"baseline: {unnamed.name} ran environment None, not the job's docker")

    def test_the_default_environment_is_each_installed_runner_s(self) -> None:
        """report.py runs without a runner installed, so it pins the default;
        this fails when Harbor's or Pier's own default moves."""
        import report
        checked = []
        for runner in ("harbor", "pier"):
            try:
                config = __import__(f"{runner}.models.trial.config", fromlist=["EnvironmentConfig"])
            except ImportError:
                continue
            default = config.EnvironmentConfig()
            self.assertEqual((default.type.value, default.import_path), (report.DEFAULT_ENVIRONMENT, None), runner)
            checked.append(runner)
        if not checked:
            self.skipTest("no runner importable; set HARBOR_PYTHON")

    def test_infra_and_running_trials_block_publication(self) -> None:
        self.paired(1)
        infra = self.trial("baseline", "task-001", reward=None, exception="PlueError")
        running = self.trial("smithers", "task-001")
        data = json.loads((running / "result.json").read_text())
        data["finished_at"] = None
        (running / "result.json").write_text(json.dumps(data))
        self.assert_refused(
            f"baseline: {infra.name} is infra (PlueError); re-run it before publishing",
            f"smithers: {running.name} is running (no exception); re-run it before publishing",
        )

    def test_unplaceable_task_leaves_both_arms_and_is_listed(self) -> None:
        self.paired(2)
        self.trial("smithers", "gpu-task", reward=None, exception="PlueUnplaceable")
        self.trial("baseline", "gpu-task")
        text, report = self.run_report(0, "--min-tasks", "2")
        self.assertEqual(report["pairedTasks"], 2)
        self.assertEqual(report["unplaceable"], ["terminal-bench/gpu-task"])
        self.assertEqual(report["results"]["baseline"]["trials"], 2, "the baseline's gpu-task trial is not scored")
        self.assertIn("- 1 tasks could not be placed and are excluded from both arms: terminal-bench/gpu-task.\n", text)

    def test_unequal_attempts_one_sided_tasks_and_changed_tasks_are_refused(self) -> None:
        self.paired(1)
        self.trial("smithers", "task-000")
        self.trial("baseline", "only-baseline")
        self.trial("smithers", "changed", checksum="a")
        self.trial("baseline", "changed", checksum="b")
        self.assert_refused(
            "terminal-bench/task-000: 2 scored attempts in smithers, 1 in baseline; 1 planned",
            "terminal-bench/only-baseline: no scored trial in the smithers arm",
            "terminal-bench/changed: task checksums differ across trials: ['a', 'b']",
        )

    def test_every_paired_task_has_the_planned_attempts(self) -> None:
        self.job("smithers", SMITHERS, n_attempts=2)
        self.job("baseline", BASELINE, n_attempts=2)
        self.paired(1)
        self.paired(1)
        self.trial("smithers", "task-001")
        self.trial("baseline", "task-001")
        self.assert_refused("terminal-bench/task-001: 1 scored attempts in smithers, 1 in baseline; 2 planned")

    def test_arms_must_share_dataset_model_environment_and_attempts(self) -> None:
        self.paired(1)
        self.job("baseline", BASELINE, n_attempts=5)
        config = json.loads((self.jobs["baseline"] / "config.json").read_text())
        config["datasets"][0]["version"] = "4.0.1"
        config["environment"] = {"type": "daytona"}
        config["agents"][0]["model_name"] = "openai/gpt-6-luna"
        (self.jobs["baseline"] / "config.json").write_text(json.dumps(config))
        report = self.assert_refused(
            "arms differ in model: openai/gpt-6-sol vs openai/gpt-6-luna",
            "arms differ in attempts: 1 vs 5",
        )
        for field in ("datasetSpec", "environmentSpec"):
            self.assertTrue(any(r.startswith(f"arms differ in {field}: ") for r in report["refusals"]), field)

    def test_every_trial_ran_what_its_job_names(self) -> None:
        self.paired(1)
        luna = self.trial("baseline", "task-001", config={"agent": {"model_name": "openai/gpt-6-luna"}})
        docker = self.trial("smithers", "task-001", config={"environment": {"import_path": None, "type": "docker"}})
        self.assert_refused(
            f"baseline: {luna.name} ran model openai/gpt-6-luna, not the job's {MODEL}",
            f"smithers: {docker.name} ran environment docker, not the job's {ENVIRONMENT}",
        )

    def test_the_arms_must_be_smithers_then_a_baseline(self) -> None:
        self.paired(1)
        self.job("smithers", BASELINE)
        self.job("baseline", SMITHERS)
        self.assert_refused(f"smithers: agent is {BASELINE}, not {SMITHERS}", "baseline: agent is the Smithers harness")

    def test_import_path_names_the_agent_harbor_loads(self) -> None:
        self.paired(1)
        config = json.loads((self.jobs["baseline"] / "config.json").read_text())
        config["agents"][0]["import_path"] = SMITHERS
        (self.jobs["baseline"] / "config.json").write_text(json.dumps(config))
        self.assert_refused("baseline: agent is the Smithers harness")

    def test_timeout_and_resource_overrides_are_refused(self) -> None:
        self.paired(1)
        slow = self.trial("smithers", "task-001", config={"timeout_multiplier": 2.0, "agent": {"override_timeout_sec": 7200}})
        big = self.trial("baseline", "task-001", config={"environment": {"override_cpus": 8}})
        self.assert_refused(
            f"smithers: {slow.name} overrides timeout_multiplier=2.0, agent.override_timeout_sec=7200",
            f"baseline: {big.name} overrides environment.override_cpus=8",
        )

    def test_a_trial_the_job_planned_but_did_not_retain_is_refused(self) -> None:
        self.paired(1)
        (self.jobs["baseline"] / "result.json").write_text(json.dumps({"n_total_trials": 2}))
        self.assert_refused("baseline: 1 trials retained; the job planned 2")

    def test_the_comparison_says_where_each_arm_s_time_and_tokens_went(self) -> None:
        for task in ("task-000", "task-001"):
            self.recorded("smithers", task, minutes=10)
            self.recorded("baseline", task, minutes=4.5)
        text, report = self.run_report(0, "--min-tasks", "2")
        ours, theirs = (report["comparison"]["arms"][arm] for arm in ("smithers", "baseline"))
        self.assertEqual((ours["trials"], ours["sources"], theirs["sources"]), (2, {"trajectory": 2}, {"session": 2}))
        self.assertEqual((ours["modelCalls"], ours["secondsPerCall"], ours["cacheShare"]), (10, 10.9, 0.6538))
        self.assertEqual((theirs["modelCalls"], theirs["secondsPerCall"], theirs["cacheShare"]), (6, 6.0, 0.8718))
        self.assertEqual((ours["thinkingTokens"], ours["writtenTokens"], ours["weightedTokens"], ours["agentMinutes"]),
                         (2_000, 3_200, 63_000, 20.0))
        self.assertEqual((theirs["thinkingTokens"], theirs["writtenTokens"], theirs["weightedTokens"], theirs["agentMinutes"]),
                         (800, 1_000, 31_200, 9.0))
        self.assertEqual(ours["time"], {"spanMs": 140_000, "modelMs": 109_000, "compactionMs": 20_000, "commandsMs": 6_600,
                                        "judgeMs": 2_800, "otherMs": 1_600, "recordedMs": 0,
                                        "derived": ["commandsMs", "compactionMs", "judgeMs", "modelMs", "otherMs"]})
        self.assertEqual(theirs["time"], {"spanMs": 43_000, "modelMs": 36_000, "compactionMs": 0, "commandsMs": 5_000,
                                          "judgeMs": 0, "otherMs": 2_000, "recordedMs": 0,
                                          "derived": ["commandsMs", "modelMs", "otherMs"]})
        self.assertEqual((ours["stageFit"], ours["stageFitUnavailable"], theirs["stageFit"], theirs["stageFitUnavailable"]),
                         (None, "no call records the wire's stage times", None,
                          "the Codex session log has no first-token time"))
        self.assertEqual((ours["ledgerEntries"], ours["ledgerByPurpose"]), (20, None))
        self.assertEqual((ours["compactions"], ours["judgeReadings"], theirs["compactions"], theirs["judgeReadings"]),
                         (2, 8, 2, 0))
        self.assertEqual((ours["wait"], theirs["wait"]),
                         (None, {"stage": "timing.firstItemMs", "calls": 6, "medianMs": 1_500, "leastMs": 1_200}))
        self.assertEqual({purpose: total["totalTokens"] for purpose, total in ours["byPurpose"].items()},
                         {"frame": 57_200, "compaction": 18_000, "judge": 6_480, "marks": 4_080, "claim": 52_400,
                          "relevance": 2_840, "reading": 1_520})
        self.assertEqual((ours["allPurposes"]["totalTokens"], ours["ledgerTokens"]), (142_520, 142_520))
        self.assertEqual(ours["fit"]["calls"], 8)
        self.assertEqual(theirs["fit"], {"calls": 6, "fixedSeconds": 16.0, "msPerThinkingToken": 0.0,
                                         "msPerWrittenToken": -60.0, "r2": 1.0}, "three distinct requests, fitted exactly")
        self.assertEqual(theirs["session"], {"cliVersions": ["0.160.0"], "models": ["seat-model"], "efforts": ["xhigh"],
                                             "summaries": ["none"]})
        first = report["comparison"]["tasks"][0]
        self.assertEqual((first["task"], first["smithers"]["modelCalls"], first["baseline"]["modelCalls"]),
                         ("terminal-bench/task-000", 5, 3))
        self.assertEqual((first["smithers"]["weightedTokens"], first["baseline"]["agentMinutes"]), (31_500, 4.5))
        for line in (
            "| Model calls | 10 | 6 |", "| Seconds per call | 10.9 | 6.0 |", "| Cache share | 65.4% | 87.2% |",
            "| Wait before a reply: median, least | n/a | 1.5 s, 1.2 s (timing.firstItemMs) |",
            "| Weighted tokens | 0.06M | 0.03M |", "| Agent minutes | 20.0 | 9.0 |", "| Model wait | 109.0 s | 36.0 s |",
            "| Commands | 6.6 s | 5.0 s |", "| Judge | 2.8 s | 0.0 s |", "| Compaction | 20.0 s | 0.0 s |",
            "| Other | 1.6 s | 2.0 s |", "| Compactions | 2 | 2 |", "| Judge readings | 8 | 0 |",
            "| Milliseconds per written token | " + f"{ours['fit']['msPerWrittenToken']:,.1f}" + " | -60.0 |",
            "| Smithers | compaction | 2 | n/a | n/a | n/a | 18,000 | n/a | n/a | 20.0 |",
            "| Smithers | judge | 2 | 6,000 | n/a | 480 | 6,480 | n/a | n/a | 0.5 |",
            "| Baseline | frame | 6 | 78,000 | 68,000 | 1,800 | 79,800 | n/a | n/a | 36.0 |",
            "| Stage fit: milliseconds per thinking token | n/a | n/a |",
            "- Smithers: the time split is from event times.",
            "- Baseline: the time split is from event times.",
            "- Smithers: no stage fit: no call records the wire's stage times.",
            "- Baseline: no stage fit: the Codex session log has no first-token time.",
            "- Smithers: 18,000 compaction tokens are recorded as a sum, with no input, cached or output count.",
            "- Smithers: 2 frame calls report no tokens and are in no total.",
            "- Baseline: Codex CLI 0.160.0; effort xhigh; summary none.",
            "- Baseline: median `timing` offsets from a call's start: `firstItemMs` 1.5 s (6 calls).",
            "| terminal-bench/task-000 | 5 / 3 | 10.9 / 6.0 | 65.4% / 87.2% | 10.0 / 4.5 | 0.03M / 0.02M | 54.5 s / 18.0 s | "
            "3.3 s / 2.5 s | 1.4 s / 0.0 s | 10.0 s / 0.0 s | 0.8 s / 1.0 s |",
        ):
            self.assertIn(line + "\n", text)
        self.assertNotIn("ledgers hold", text, "the rows sum to the run's ledger, so nothing is said")
        self.assertEqual(report["results"]["smithers"]["tokens"], {"input": 52_000, "cached": 34_000, "output": 5_200},
                         "the scored token columns are the agent's own calls, as before")

    def test_a_journal_that_records_its_own_times_reports_them_and_the_stage_fit(self) -> None:
        for task in ("task-000", "task-001"):
            self.recorded("smithers", task, minutes=10, journal=check_calls.recorded())
            self.recorded("baseline", task, minutes=4.5)
        text, report = self.run_report(0, "--min-tasks", "2")
        ours, theirs = (report["comparison"]["arms"][arm] for arm in ("smithers", "baseline"))
        self.assertEqual(ours["time"], {"spanMs": 141_000, "modelMs": 109_000, "compactionMs": 20_600, "commandsMs": 6_900,
                                        "judgeMs": 2_800, "otherMs": 1_700, "recordedMs": 137_400,
                                        "derived": ["modelMs", "otherMs"]})
        self.assertEqual(ours["stageFit"], {
            "calls": 8, "meanHeadersMs": 1_025,
            "thinking": {"calls": 8, "fixedMs": 500, "msPerThinkingToken": 20.0, "r2": 1.0},
            "written": {"calls": 8, "fixedMs": 300, "msPerWrittenToken": 10.0, "r2": 1.0}})
        self.assertNotIn("stageFitUnavailable", ours)
        self.assertEqual((theirs["stageFit"], theirs["stageFitUnavailable"], theirs["fit"]["calls"]),
                         (None, "the Codex session log has no first-token time", 6), "the whole-call fit stays")
        self.assertEqual((ours["ledgerEntries"], ours["ledgerTokens"], ours["ledgerByPurpose"]["frame"]),
                         (18, 141_720, {"tokens": 56_400, "costUsd": 0.114}))
        self.assertEqual(ours["cellWork"], {"calls": {"calls": 4, "durationMs": 50_000, "totalTokens": 26_400},
                                            "no_call": {"calls": 2, "durationMs": 16_000, "totalTokens": 16_800},
                                            "rejected": {"calls": 2, "durationMs": 40_000, "totalTokens": 13_200}})
        first = report["comparison"]["tasks"][0]
        self.assertEqual((first["smithers"]["stageFit"]["thinking"]["msPerThinkingToken"], first["baseline"]["stageFit"]),
                         (20.0, None))
        for line in (
            "| Stage fit: calls | 8 | n/a |", "| Stage fit: mean seconds to headers | 1.0 | n/a |",
            "| Stage fit: headers to first output, fixed seconds | 0.5 | n/a |",
            "| Stage fit: milliseconds per thinking token | 20.0 | n/a |", "| Stage fit: R squared, thinking | 1.00 | n/a |",
            "| Stage fit: first to last output, fixed seconds | 0.3 | n/a |",
            "| Stage fit: milliseconds per written token | 10.0 | n/a |", "| Stage fit: R squared, written | 1.00 | n/a |",
            "- Smithers: 137.4 s of the 141.0 s span is the frames' own clocks; from event times: modelMs, otherMs.",
            "- Baseline: the time split is from event times.",
            "- Baseline: no stage fit: the Codex session log has no first-token time.",
            "- Smithers: model calls by what their cell did: calls 4 (50.0 s), no_call 2 (16.0 s), rejected 2 (40.0 s).",
            "| Smithers | frame | 10 | 52,000 | 34,000 | 4,400 | 56,400 | 56,400 | 0.114000 | 109.0 |",
            "| Smithers | compaction | 2 | 16,400 | 0 | 1,600 | 18,000 | 18,000 | 0.040000 | 20.0 |",
            "| Smithers | marks | 2 | 4,000 | n/a | 80 | 4,080 | 4,080 | 0.000100 | 0.3 |",
            "Smithers. Baseline: no stage fit: the Codex session log has no first-token time.",
            "| terminal-bench/task-000 | 4 | 1.0 | 0.5 | 20.0 | 1.00 | 0.3 | 10.0 | 1.00 |",
        ):
            self.assertIn(line + "\n", text)
        self.assertNotIn("ledgers hold", text, "the rows agree with the ledger under every purpose")
        self.assertNotIn("Smithers: no stage fit", text)

    def test_an_old_trajectory_and_a_trial_with_no_call_record_still_report(self) -> None:
        old = self.trial("smithers", "task-000", tokens=(3_900, 1_100, 120))
        (old / "agent" / "trajectory.json").write_text(json.dumps({"schema_version": "ATIF-v1.8", "steps": [
            {"step_id": 1, "source": "user", "message": "i"},
            {"step_id": 2, "source": "agent", "timestamp": "2026-10-01T00:00:00.000Z", "message": "a",
             "metrics": {"prompt_tokens": 1_000, "completion_tokens": 50, "cached_tokens": 200,
                         "extra": {"reasoning_tokens": None, "duration_millis": 12_000}}},
            {"step_id": 3, "source": "agent", "timestamp": "2026-10-01T00:00:13.000Z", "message": "b",
             "metrics": {"prompt_tokens": 2_000, "completion_tokens": 70, "cached_tokens": 900,
                         "extra": {"reasoning_tokens": 20, "duration_millis": 8_000}}},
        ], "final_metrics": {"total_prompt_tokens": 3_900, "total_completion_tokens": 120, "total_cached_tokens": 1_100}}))
        self.trial("baseline", "task-000")
        text, report = self.run_report(0, "--min-tasks", "1")
        ours, theirs = (report["comparison"]["arms"][arm] for arm in ("smithers", "baseline"))
        self.assertEqual((ours["sources"], ours["modelCalls"], ours["secondsPerCall"], ours["splitTrials"]),
                         ({"steps": 1}, 2, 10.0, 0))
        self.assertEqual((ours["time"]["modelMs"], ours["time"]["commandsMs"], ours["fit"], ours["unlistedInputTokens"]),
                         (20_000, None, None, 900))
        self.assertEqual((ours["weightedTokens"], ours["agentMinutes"]), (round(2_800 + 110 + 960), None))
        self.assertEqual((theirs["sources"], theirs["modelCalls"], theirs["cacheShare"], theirs["weightedTokens"]),
                         ({"None": 1}, 0, None, round(200 + 80 + 400)))
        for line in ("| Model calls | 2 | 0 |", "| Seconds per call | 10.0 | n/a |", "| Model wait | 20.0 s | n/a |",
                     "| Commands | n/a | n/a |", "| Fixed seconds per call | n/a | n/a |",
                     "- Smithers: the time split is recorded for 0 of 1 trials.",
                     "- Smithers: 900 input tokens are in a trajectory total and in no row.",
                     "- Baseline: the time split is recorded for 0 of 1 trials."):
            self.assertIn(line + "\n", text)

    def test_a_refused_report_still_says_where_time_went(self) -> None:
        self.recorded("smithers", "task-000", minutes=10)
        self.recorded("baseline", "task-000", minutes=4.5)
        report = self.assert_refused("1 paired tasks; 50 required")
        self.assertEqual(report["comparison"]["arms"]["smithers"]["modelCalls"], 5)
        text = (self.root / "out" / "nested" / "report.md").read_text()
        self.assertIn("## Where time and tokens went\n", text)
        self.assertIn("| Model calls | 5 | 3 |\n", text)

    def test_missing_job_directory_is_refused(self) -> None:
        missing = self.root / "nowhere"
        self.jobs["baseline"] = missing
        self.assert_refused(f"baseline: {missing} is not a Harbor job directory")

    def test_usage_text_on_bad_arguments(self) -> None:
        process = subprocess.run([sys.executable, "-B", str(REPORT), "one"], text=True, capture_output=True, timeout=30)
        self.assertEqual(process.returncode, 64)
        self.assertIn("python3 report.py <smithers-job> <baseline-job> <out-dir>", process.stderr)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=0).result
    if not result.wasSuccessful():
        sys.exit(1)
    print(f"check_report.py: {result.testsRun} publication checks hold.")

"""Quota detection and account state, with Harbor's actual failure formatting."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[7]))
try:
    from harbor.environments.base import ExecResult
except ModuleNotFoundError as error:
    if error.name != "harbor" or os.environ.get("HARBOR_PYTHON"):
        raise
    print("check_codex_pool.py: Harbor not installed; pooled Codex checks not run")
    sys.exit(0)

from packages.smithers.agent.harness.benchmarks.harbor import accounts, codex_pool


def command_output(text: str) -> str:
    return json.dumps({"type": "item.completed", "item": {
        "type": "command_execution", "exit_code": 0, "aggregated_output": text}})


class UsageLimitTests(unittest.TestCase):
    def test_only_cli_failure_events_and_plain_transcript_lines_count(self):
        for line in (
            "ERROR: You've hit your usage limit.",
            json.dumps({"type": "error", "message": "usage_limit_reached"}),
            json.dumps({"type": "turn.failed", "error": {"message": "quota_exceeded"}}),
        ):
            with self.subTest(line=line):
                self.assertEqual(codex_pool.usage_limit_in(command_output("memory usage limit") + "\n" + line), line)
        self.assertIsNone(codex_pool.usage_limit_in(command_output("memory usage limit")))

    def test_malformed_json_is_task_text_even_when_it_mentions_a_limit(self):
        for line in (
            '{"type":"item.completed","text":"memory usage limit',
            '{"type":"error","message":"usage_limit_reached"',
            '{"usage limit"}',
            '  {not JSON: quota_exceeded',
        ):
            with self.subTest(line=line):
                self.assertIsNone(codex_pool.usage_limit_in(line))
                self.assertEqual(codex_pool.usage_limit_in(line + "\nERROR: usage_limit_reached"),
                                 "ERROR: usage_limit_reached")


class PooledOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.agent = codex_pool.PooledCodex(logs_dir=self.root)
        account = accounts.Account("codex-test", self.root / "seat")
        self.agent._pool = accounts.Pool([account], self.root / "pool.json", wait_sec=0)
        self.agent._account = self.agent._pool.lease("trial")
        self.agent._seal = {"sealed": True, "webSearches": 0}

    def record(self):
        return json.loads((self.root / codex_pool.ACCOUNT_FILE).read_text())

    def test_truncated_command_failure_preserves_error_and_account(self):
        # Exercise Harbor's real head/tail cut at many positions inside task events.
        for padding in (1, 7, 40, 200, 749, 1000):
            with self.subTest(padding=padding):
                transcript = "\n".join(command_output("set memory usage limit for compression " + "x" * padding)
                                       for _ in range(10))
                failure = self.agent._classify_exec_error(
                    "codex exec", ExecResult(return_code=1, stdout=transcript))
                self.assertIn("chars truncated", str(failure))
                with self.assertRaises(type(failure)) as raised:
                    self.agent._record_output(transcript, failure)
                self.assertIs(raised.exception, failure)
                self.assertEqual(self.agent._pool.disabled(), {})
                self.assertEqual(self.agent._pool.lease("next").label, "codex-test")
                self.assertNotIn("usageLimit", self.record())
                self.assertNotIn("resetAt", self.record())
                self.assertEqual(self.record()["containerCommands"], {"attempted": 10, "succeeded": 10})

    def test_missing_transcript_does_not_trust_exception_text(self):
        failure = RuntimeError("Command failed: usage_limit_reached")
        with self.assertRaises(RuntimeError) as raised:
            self.agent._record_output("", failure)
        self.assertIs(raised.exception, failure)
        self.assertEqual(self.agent._pool.disabled(), {})

    def test_real_limit_disables_account_even_when_command_failed(self):
        for event in (
            "ERROR: You've hit your usage limit.",
            json.dumps({"type": "error", "message": "usage_limit_reached"}),
            json.dumps({"type": "turn.failed", "error": {"message": "quota_exceeded"}}),
        ):
            with self.subTest(event=event):
                self.agent._pool.enable("codex-test")
                with self.assertRaises(accounts.SeatExhausted) as raised:
                    self.agent._record_output(event, RuntimeError("exit 1"))
                self.assertEqual(raised.exception.label, "codex-test")
                self.assertEqual(self.agent._pool.disabled()["codex-test"]["reason"], event)
                self.assertEqual(self.record()["usageLimit"], event)

    def test_success_keeps_command_and_web_search_evidence(self):
        self.agent._record_output(command_output("done") + "\n" +
                                  json.dumps({"type": "item.completed", "item": {"type": "web_search"}}), None)
        self.assertEqual(self.record()["containerCommands"], {"attempted": 1, "succeeded": 1})
        self.assertFalse(self.record()["sealed"])
        self.assertEqual(self.agent._metadata["seal"]["webSearches"], 1)
        self.assertEqual(self.agent._pool.disabled(), {})

    def test_no_successful_command_still_refuses_trial(self):
        with self.assertRaises(accounts.ContainerUnreachable):
            self.agent._record_output("", None)
        self.assertEqual(self.agent._pool.disabled(), {})


if __name__ == "__main__":
    unittest.main()

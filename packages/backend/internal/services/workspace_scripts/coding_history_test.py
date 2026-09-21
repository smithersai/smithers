import json
import subprocess
import unittest

from coding import Coding
import coding_engine_test


class NativeHistoryTest(unittest.TestCase):
    setUp = coding_engine_test.NativeEngineSnapshotTest.setUp
    jj = coding_engine_test.NativeEngineSnapshotTest.jj
    state = coding_engine_test.NativeEngineSnapshotTest.state

    def read(self, error=None, **fields):
        request = dict(repositoryPath=str(self.repo), operation="read", **fields)
        result = subprocess.run(["python3", str(self.script), "--local"], input=json.dumps(request),
                                capture_output=True, text=True)
        body = json.loads(result.stdout)
        if error:
            self.assertEqual(result.returncode, 1)
            self.assertEqual(body["error"]["code"], error, body)
        else:
            self.assertEqual(result.returncode, 0, (body, result.stderr))
        return body

    def test_history_window_is_oldest_first_bounded_and_readonly(self):
        a = self.state()["head"]
        self.jj("new", "-m", "second atom")
        b = self.state()["head"]
        self.jj("new", "-m", "third atom")
        c = self.state()["head"]
        before = self.state()
        (self.repo / "dirty").write_text("unsnapshotted edit")
        view = self.read(historyLimit=2, changeIds=[a["changeId"]])
        self.assertEqual(view["operationId"], before["operationId"])
        self.assertEqual(view["head"], c)
        self.assertEqual([row["changeId"] for row in view["history"]], [b["changeId"], c["changeId"]])
        self.assertEqual(view["history"][0]["parentCommitIds"], [a["commitId"]])
        self.assertEqual(view["revisions"][0]["commitId"], a["commitId"])
        self.assertTrue(all(row["operationId"] == before["operationId"] for row in view["history"]))
        self.assertEqual(len(self.read(historyLimit=1)["history"]), 1)
        self.assertEqual(len(self.read(historyLimit=100)["history"]), 3)
        self.assertNotIn("history", self.read())
        self.assertEqual(self.state(), before)
        self.assertEqual((self.repo / "dirty").read_text(), "unsnapshotted edit")

    def test_unrelated_descendant_branch_does_not_forbid_linear_memory(self):
        a = self.state()["head"]
        self.jj("new", "-m", "selected atom")
        selected = self.state()["head"]
        self.jj("new", a["commitId"], "-m", "unrelated branch")
        self.jj("edit", selected["commitId"])
        history = self.read(historyLimit=100)["history"]
        self.assertEqual([row["changeId"] for row in history], [a["changeId"], selected["changeId"]])

    def test_selected_merge_refuses_without_mutating_native_history(self):
        a = self.state()["head"]
        self.jj("new", "-m", "left")
        left = self.state()["head"]
        self.jj("new", a["commitId"], "-m", "right")
        right = self.state()["head"]
        self.jj("new", left["commitId"], right["commitId"], "-m", "merge")
        before = self.state()
        self.read(historyLimit=1, error="nonlinear_history")
        self.assertEqual(self.state(), before)

    def test_history_limit_validation_and_legacy_shape(self):
        before = self.state()
        for limit in (0, 1025, -1, True, None, "10", 1.5):
            with self.subTest(limit=limit):
                self.read(historyLimit=limit, error="invalid_request")

        self.assertEqual(len(self.read(historyLimit=1024)["history"]), 1)
        self.assertEqual(self.read(), before)

    def test_all_history_rows_stay_at_original_operation_during_external_change(self):
        before = self.state()
        adapter = Coding(str(self.repo), {"operation": "read", "historyLimit": 100})
        original = adapter.commits
        advanced = False
        def commits(revset, at, **options):
            nonlocal advanced
            if revset.startswith("ancestors(") and not advanced:
                advanced = True
                self.jj("new", "-m", "external later atom")
            return original(revset, at, **options)
        adapter.commits = commits
        view = adapter.run()
        self.assertTrue(advanced)
        self.assertEqual(view["operationId"], before["operationId"])
        self.assertEqual(view["head"], before["head"])
        self.assertEqual(view["history"], [before["head"]])
        self.assertNotEqual(self.state()["operationId"], before["operationId"])


if __name__ == "__main__":
    unittest.main()

import fcntl
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
import time
import unittest

import coding
from coding import Coding, CodingError, local_request


class NativeEngineSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="smithers-engine-snapshot-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        subprocess.run(["jj", "git", "init", str(self.repo)], check=True, capture_output=True)
        self.jj("config", "set", "--repo", "user.name", "Engine Test")
        self.jj("config", "set", "--repo", "user.email", "engine@example.com")
        self.jj("describe", "-m", "✨ feat(example): planned atomic change")
        # Exercise the actual installed-file entry point. Only deployment paths
        # move into the fixture; request parsing, UID binding and locking remain.
        self.reporter = Path(self.tmp.name) / "reporter"
        self.reporter.write_text('exec 9>"$op_repo/smithers-coding.lock"\n')
        config = Path(self.tmp.name) / "coding.json"
        self.config = dict(version=1, repositoryPath=str(self.repo), actorId=42,
                           workspaceId="owned", username=pwd.getpwuid(os.getuid()).pw_name)
        config.write_text(json.dumps(self.config))
        self.script = Path(self.tmp.name) / "coding.py"
        self.script.write_text(Path(coding.__file__).read_text().replace(
            "/etc/smithers/workspace-coding.json", str(config)).replace(
            coding.REPORTER_SCRIPT, str(self.reporter)))

    def jj(self, *args):
        result = subprocess.run(["jj", "-R", str(self.repo), "--no-pager", "--color=never", *args],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def state(self):
        return Coding(str(self.repo), {"operation": "read"}).run()

    def request(self, operation, **fields):
        return dict(repositoryPath=str(self.repo), operation=operation, **fields)

    def engine(self, operation, error=None, **fields):
        result = subprocess.run(["python3", str(self.script), "--engine"],
                                input=json.dumps(self.request(operation, **fields)),
                                capture_output=True, text=True)
        body = json.loads(result.stdout)
        if error:
            self.assertEqual(result.returncode, 1)
            self.assertEqual(body["error"]["code"], error, body)
        else:
            self.assertEqual(result.returncode, 0, (body, result.stderr))
        return body

    def test_snapshots_restore_exact_bytes_in_same_atom_across_reopen(self):
        initial = self.state()
        (self.repo / "binary").write_bytes(bytes(range(256)))
        (self.repo / "text").write_text("before 🙂\n")
        (self.repo / "executable").write_text("#!/bin/sh\nexit 0\n")
        (self.repo / "executable").chmod(0o755)
        (self.repo / "link").symlink_to("text")
        before = self.engine("snapshot")["changeId"]
        self.assertRegex(before, r"^[0-9a-f]{40}$")
        captured = self.state()
        self.assertEqual(before, captured["head"]["commitId"])
        for field in ("changeId", "parentCommitIds", "description"):
            self.assertEqual(captured["head"][field], initial["head"][field])
        # Repeated pre-effect snapshots and a lost acknowledgement are native
        # no-ops: a new Python process returns the same immutable commit and op.
        self.assertEqual(self.engine("snapshot"), {"changeId": before})
        self.assertEqual(self.state(), captured)

        (self.repo / "binary").write_bytes(b"\0changed\xff")
        (self.repo / "text").unlink()
        (self.repo / "executable").chmod(0o644)
        (self.repo / "link").unlink()
        (self.repo / "link").symlink_to("binary")
        (self.repo / "added").write_text("after\n")
        after = self.engine("snapshot")["changeId"]
        self.assertNotEqual(after, before)
        # Descriptions belong to the plan/human even when restored from an
        # older snapshot. Compensation must not overwrite a later description.
        self.jj("describe", "-m", "polished planned atom")
        (self.repo / "binary").write_bytes(b"pending unsnapshotted bytes")
        self.engine("restore", changeId=before)
        self.assertEqual((self.repo / "binary").read_bytes(), bytes(range(256)))
        self.assertEqual((self.repo / "text").read_text(), "before 🙂\n")
        self.assertTrue((self.repo / "executable").stat().st_mode & 0o111)
        self.assertEqual(os.readlink(self.repo / "link"), "text")
        self.assertFalse((self.repo / "added").exists())
        restored = self.state()
        self.assertEqual(restored["head"]["treeId"], captured["head"]["treeId"])
        self.assertEqual(restored["head"]["description"], "polished planned atom\n")
        for field in ("changeId", "parentCommitIds"):
            self.assertEqual(restored["head"][field], initial["head"][field])
        self.engine("restore", changeId=after)
        self.assertEqual((self.repo / "binary").read_bytes(), b"\0changed\xff")
        self.engine("restore", changeId=before)
        stable = self.state()
        self.engine("restore", changeId=before)
        self.assertEqual(self.state(), stable)
        self.assertEqual(self.jj("--ignore-working-copy", "log", "-r", "all()", "--no-graph",
                                 "-T", 'change_id ++ "\\n"').splitlines(),
                         [initial["head"]["changeId"], "z" * 32])

    def test_snapshot_can_retry_interruption_before_native_capture(self):
        (self.repo / "value").write_text("pending\n")
        request = local_request(json.dumps(self.request("snapshot")), self.config, engine=True)
        request["requireReporterLock"] = False  # This instance injects an interrupted native call.
        adapter = Coding(str(self.repo), request)
        original = adapter.jj
        def interrupted(args, *positional, **kwargs):
            if args == ["status"]:
                raise OSError("interrupted before native snapshot")
            return original(args, *positional, **kwargs)
        adapter.jj = interrupted
        before = self.state()
        with self.assertRaises(OSError):
            adapter.run(engine=True)
        self.assertEqual(self.state(), before)
        snapshot = self.engine("snapshot")
        self.assertEqual(self.engine("snapshot"), snapshot)
        self.assertEqual((self.repo / "value").read_text(), "pending\n")

    def test_incomplete_native_capture_fails_instead_of_claiming_compensation(self):
        snapshot = self.engine("snapshot")["changeId"]
        for setting, value, contents in (("snapshot.max-new-file-size", "16", b"x" * 100),
                                         ("snapshot.auto-track", "none()", b"small")):
            with self.subTest(setting=setting):
                self.jj("config", "set", "--repo", setting, value)
                (self.repo / "untracked").write_bytes(contents)
                before = self.state()
                self.engine("snapshot", error="snapshot_incomplete")
                self.engine("restore", changeId=snapshot, error="snapshot_incomplete")
                self.assertEqual((self.repo / "untracked").read_bytes(), contents)
                self.assertEqual(self.state(), before)
                (self.repo / "untracked").unlink()

    def test_restore_refuses_another_active_change_without_capturing_dirty_bytes(self):
        (self.repo / "value").write_text("old atom\n")
        snapshot = self.engine("snapshot")["changeId"]
        self.jj("new", "-m", "different atom")
        before = self.state()
        (self.repo / "value").write_text("different unsnapshotted atom\n")
        self.engine("restore", changeId=snapshot, error="revision_conflict")
        self.assertEqual(self.state(), before)
        self.assertEqual((self.repo / "value").read_text(), "different unsnapshotted atom\n")

    def test_restore_refuses_rewritten_parent_of_the_same_change(self):
        self.jj("new", "-m", "child atom")
        (self.repo / "value").write_text("child\n")
        snapshot = self.engine("snapshot")["changeId"]
        native = self.state()["head"]["changeId"]
        self.jj("describe", "@-", "-m", "rewritten parent")
        before = self.state()
        self.assertEqual(before["head"]["changeId"], native)
        self.engine("restore", changeId=snapshot, error="revision_conflict")
        self.assertEqual(self.state(), before)
        self.assertEqual((self.repo / "value").read_text(), "child\n")

    def test_diff_is_immutable_readonly_and_independent_of_active_change(self):
        (self.repo / "value").write_text("before\n")
        first = self.engine("snapshot")["changeId"]
        (self.repo / "value").write_text("after\n")
        second = self.engine("snapshot")["changeId"]
        self.jj("new", "-m", "unrelated active atom")
        before = self.state()
        (self.repo / "value").write_text("unsnapshotted\n")
        diff = self.engine("diff", **{"from": first, "to": second})["diff"]
        self.assertIn("diff --git a/value b/value", diff)
        self.assertIn("-before\n+after\n", diff)
        self.assertNotIn("unsnapshotted", diff)
        self.assertEqual(self.engine("diff", **{"from": first, "to": first}), {"diff": ""})
        self.assertEqual(self.state(), before)
        self.assertEqual((self.repo / "value").read_text(), "unsnapshotted\n")

    def test_engine_binding_and_immutable_id_validation(self):
        before = self.state()
        for value in ("@", "main", before["head"]["changeId"], before["head"]["commitId"][:12],
                      "A" * 40, "a" * 39, "a" * 41, '" | @', None, 123, [], {}):
            with self.subTest(value=value):
                self.engine("restore", changeId=value, error="invalid_request")
                self.engine("diff", error="invalid_request", **{"from": value, "to": "a" * 40})
        for fields in ({"actorId": 99}, {"workspaceId": "another"}, {"repositoryPath": "/another"},
                       {"requireReporterLock": False}, {"label": "must not describe"}):
            request = dict(self.request("snapshot"), **fields)
            with self.assertRaises(CodingError) as caught:
                local_request(json.dumps(request), self.config, engine=True)
            self.assertEqual(caught.exception.code, "invalid_request")
        self.engine("new", error="invalid_request")
        self.assertEqual(self.state(), before)

    def test_engine_uses_shared_lock_and_reporter_upgrade_fence(self):
        before = self.state()
        self.reporter.write_text("old reporter without operation lock\n")
        self.engine("snapshot", error="reporter_upgrade_required")
        self.assertEqual(self.state(), before)
        self.reporter.write_text('exec 9>"$op_repo/smithers-coding.lock"\n')
        (self.repo / "value").write_text("waiting for shared reporter lock\n")
        with (self.repo / ".jj/repo/smithers-coding.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(["python3", str(self.script), "--engine"], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                process.stdin.write(json.dumps(self.request("snapshot")))
                process.stdin.close()
                process.stdin = None
                time.sleep(0.25)
                self.assertIsNone(process.poll(), "engine bypassed the existing reporter lock")
                self.assertEqual(Coding(str(self.repo), {}).operation()["id"], before["operationId"])
                fcntl.flock(lock, fcntl.LOCK_UN)
                stdout, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, (stdout, stderr))
                self.assertNotEqual(json.loads(stdout)["changeId"], before["head"]["commitId"])
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()


if __name__ == "__main__":
    unittest.main()

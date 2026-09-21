import base64
import concurrent.futures
import copy
import hashlib
import json
import os
import pwd
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid
from unittest import mock

import coding
from coding import Coding, CodingError, FilePatch, local_request


class FilePatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="smithers-coding-files-")
        self.repo = Path(self.tmp.name) / "repo"
        subprocess.run(["jj", "git", "init", str(self.repo)], check=True, capture_output=True)
        self.jj("config", "set", "--repo", "user.name", "Patch Test")
        self.jj("config", "set", "--repo", "user.email", "patch@example.com")
        (self.repo / "value").write_text("before\n")
        self.jj("status")

    def tearDown(self):
        self.tmp.cleanup()

    def jj(self, *args):
        result = subprocess.run(["jj", "-R", str(self.repo), "--no-pager", *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def read(self):
        return Coding(str(self.repo), {"operation": "read"}).run()

    @staticmethod
    def edit(path="value", before="before\n", after="after\n"):
        return dict(path=path, beforeDigest=hashlib.sha256(before.encode()).hexdigest() if before is not None else None, content=after)

    def request(self, files=None):
        state = self.read()
        return dict(operation="apply_files", requestId=str(uuid.uuid4()), expectedOperationId=state["operationId"],
                    target=state["head"], files=files or [self.edit()], workspaceId="owned", reportProvenance=True)

    def apply(self, request):
        return Coding(str(self.repo), request).run()

    def failure(self, request, codes=("file_conflict", "file_recovery_required")):
        with self.assertRaises(CodingError) as caught:
            self.apply(request)
        error = caught.exception
        self.assertIn(error.code, codes, error.message)
        return error

    def test_exact_snapshot_replay_add_edit_delete_and_provenance(self):
        (self.repo / "remove").write_text("remove me\n")
        (self.repo / "value").chmod(0o755)
        self.jj("status")
        request = self.request([self.edit(after="after 🙂\r\n"), self.edit("nested/added", None, "new\n"), self.edit("remove", "remove me\n", None)])
        result = self.apply(request)
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(result["parentOperationId"], request["expectedOperationId"])
        self.assertEqual(result["revision"]["changeId"], request["target"]["changeId"])
        self.assertEqual((self.repo / "value").read_bytes(), b"after \xf0\x9f\x99\x82\r\n")
        self.assertTrue((self.repo / "value").stat().st_mode & 0o111)
        self.assertFalse((self.repo / "remove").exists())
        self.assertEqual((self.repo / "nested/added").read_text(), "new\n")
        recovery = result["recovery"]
        self.assertFalse(Path(recovery["path"]).is_relative_to(self.repo))
        self.assertEqual(Path(recovery["files"][0]["preimage"]).read_text(), "before\n")
        self.assertEqual(Path(recovery["files"][2]["preimage"]).read_text(), "remove me\n")
        self.assertEqual(Path(recovery["path"]).stat().st_mode & 0o077, 0)
        raw = subprocess.check_output(["python3", coding.__file__, str(self.repo), base64.b64encode(json.dumps(request).encode()).decode()], text=True)
        replay = json.loads(raw)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["operationId"], result["operationId"])
        projected = Coding(str(self.repo), {}).projections("owned")["coding_operations"]
        self.assertEqual([(row["operation"], row["operationId"]) for row in projected], [("apply_files", result["operationId"])])
        changed = copy.deepcopy(request)
        changed["files"][0]["content"] = "different"
        self.failure(changed, ("request_conflict",))

    def test_replay_never_overwrites_later_user_edits(self):
        request = self.request()
        result = self.apply(request)
        (self.repo / "value").write_text("later user edit\n")
        error = self.failure(request)
        self.assertEqual(error.recovery, result["recovery"])
        self.assertEqual((self.repo / "value").read_text(), "later user edit\n")
        self.assertEqual(Path(error.recovery["files"][0]["preimage"]).read_text(), "before\n")

    def test_all_preimages_are_checked_before_first_write(self):
        (self.repo / "second").write_text("actual")
        self.jj("status")
        request = self.request([self.edit(), self.edit("second", "wrong", "replacement")])
        before = self.read()
        self.failure(request)
        self.assertEqual((self.repo / "value").read_text(), "before\n")
        self.assertEqual((self.repo / "second").read_text(), "actual")
        self.assertEqual(self.read(), before)

    def test_race_before_move_retains_actual_displaced_bytes(self):
        request = self.request()
        move = FilePatch.move
        def edit_then_move(*args):
            (self.repo / "value").write_text("concurrent pre-move edit\n")
            return move(*args)
        with mock.patch.object(FilePatch, "move", staticmethod(edit_then_move)):
            error = self.failure(request)
        self.assertEqual(Path(error.recovery["files"][0]["preimage"]).read_text(), "concurrent pre-move edit\n")
        self.assertEqual(Path(error.recovery["files"][0]["proposed"]).read_text(), "after\n")
        self.assertEqual(self.read()["operationId"], request["expectedOperationId"])

    def test_race_before_install_never_replaces_newer_path(self):
        request = self.request()
        link = os.link
        def create_then_link(*args, **kwargs):
            (self.repo / "value").write_text("concurrent replacement\n")
            return link(*args, **kwargs)
        with mock.patch("coding.os.link", side_effect=create_then_link):
            error = self.failure(request)
        self.assertEqual((self.repo / "value").read_text(), "concurrent replacement\n")
        self.assertEqual(Path(error.recovery["files"][0]["preimage"]).read_text(), "before\n")

    def test_old_open_inode_write_stays_recoverable_and_rejects_acceptance(self):
        request = self.request()
        verify = FilePatch.verify
        with open(self.repo / "value", "r+") as editor:
            def write_then_verify(patch):
                editor.seek(0)
                editor.write("late old-descriptor edit\n")
                editor.truncate()
                editor.flush()
                return verify(patch)
            with mock.patch.object(FilePatch, "verify", write_then_verify):
                error = self.failure(request)
        self.assertEqual(Path(error.recovery["files"][0]["preimage"]).read_text(), "late old-descriptor edit\n")
        self.assertEqual((self.repo / "value").read_text(), "after\n")
        self.assertEqual(self.read()["operationId"], request["expectedOperationId"])

    def test_partial_installation_never_replays_over_user_content(self):
        request = self.request([self.edit(), self.edit("added", None, "added\n")])
        link = os.link
        def interrupted(*args, **kwargs):
            link(*args, **kwargs)
            raise OSError("lost process during installation")
        with mock.patch("coding.os.link", side_effect=interrupted):
            error = self.failure(request)
        (self.repo / "value").write_text("post-interruption edit\n")
        again = self.failure(request, ("file_recovery_required",))
        self.assertEqual(error.recovery, again.recovery)
        self.assertEqual((self.repo / "value").read_text(), "post-interruption edit\n")
        self.assertEqual(Path(error.recovery["files"][0]["preimage"]).read_text(), "before\n")
        self.assertFalse((self.repo / "added").exists())

    def test_interruption_after_install_resumes_exact_native_snapshot_once(self):
        request = self.request()
        adapter = Coding(str(self.repo), request)
        original = adapter.jj
        def interrupted(args, *positional, **kwargs):
            if args[-1] == "status" and "--config" in args:
                raise OSError("interrupted before JJ snapshot")
            return original(args, *positional, **kwargs)
        adapter.jj = interrupted
        with self.assertRaises(CodingError):
            adapter.run()
        self.assertEqual(self.read()["operationId"], request["expectedOperationId"])
        result = self.apply(request)
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(self.apply(request)["operationId"], result["operationId"])

    def test_unrelated_edit_during_snapshot_cannot_be_accepted(self):
        request = self.request()
        adapter = Coding(str(self.repo), request)
        original = adapter.jj
        def concurrent(args, *positional, **kwargs):
            if args[-1] == "status" and "--config" in args:
                (self.repo / "unrelated").write_text("user work\n")
            return original(args, *positional, **kwargs)
        adapter.jj = concurrent
        with self.assertRaises(CodingError) as caught:
            adapter.run()
        self.assertEqual(caught.exception.code, "file_conflict")
        self.assertIn("other edits", caught.exception.message)
        self.assertEqual((self.repo / "unrelated").read_text(), "user work\n")
        self.failure(request)

    def test_symlink_file_and_parent_never_escape_checkout(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "valuable").write_text("outside bytes\n")
        (self.repo / "link").symlink_to(outside)
        (self.repo / "file-link").symlink_to(outside / "valuable")
        self.jj("status")
        for path in ("link/valuable", "file-link"):
            with self.subTest(path=path):
                self.failure(self.request([self.edit(path, "outside bytes\n", "wrong")]))
        self.assertEqual((outside / "valuable").read_text(), "outside bytes\n")

    def test_parallel_request_has_one_snapshot(self):
        request = self.request()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(self.apply, [request, request]))
        self.assertEqual(results[0]["operationId"], results[1]["operationId"])
        self.assertEqual(sorted(result["replayed"] for result in results), [False, True])

    def test_local_request_boundaries_and_size(self):
        config = dict(version=1, workspaceId="owned", actorId=42, repositoryPath=str(self.repo))
        request = self.request()
        request.pop("workspaceId")
        request.pop("reportProvenance")
        request["repositoryPath"] = str(self.repo)
        bound = local_request(json.dumps(request), config)
        self.assertTrue(bound["requireReporterLock"])
        self.assertEqual(bound["actorId"], 42)
        for path in ("../escape", "/escape", ".jj/metadata", "nested/.git/config", "a//b", "a/./b", "a\\b", "a\nb"):
            with self.subTest(path=path), self.assertRaises(CodingError):
                local_request(json.dumps(dict(request, files=[self.edit(path)])), config)
        for files in ([self.edit()] * 31, [self.edit(after="🙂" * (65536 + 1))], [self.edit("a"), self.edit("a/b")], [self.edit(before=None, after=None)]):
            with self.assertRaises(CodingError):
                local_request(json.dumps(dict(request, files=files)), config)
        with self.assertRaises(CodingError):
            local_request(json.dumps(dict(request, recoveryPath="/elsewhere")), config)

    def test_installed_local_entrypoint_accepts_bounded_unicode_patch(self):
        config = Path(self.tmp.name) / "coding.json"
        config.write_text(json.dumps(dict(version=1, workspaceId="owned", actorId=42, repositoryPath=str(self.repo), username=pwd.getpwuid(os.getuid()).pw_name)))
        reporter = Path(self.tmp.name) / "reporter"
        reporter.write_text('exec 9>"$op_repo/smithers-coding.lock"\n')
        script = Path(self.tmp.name) / "coding.py"
        script.write_text(Path(coding.__file__).read_text().replace("/etc/smithers/workspace-coding.json", str(config)).replace(coding.REPORTER_SCRIPT, str(reporter)))
        request = self.request([self.edit(after="🙂" * 32768)])
        request.pop("workspaceId")
        request.pop("reportProvenance")
        request["repositoryPath"] = str(self.repo)
        result = subprocess.run(["python3", str(script), "--local"], input=json.dumps(request), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["status"], "accepted")
        self.assertEqual((self.repo / "value").read_text(), "🙂" * 32768)


if __name__ == "__main__":
    unittest.main()

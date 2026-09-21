import concurrent.futures
import copy
import json
import os
import signal
import subprocess
import tempfile
import unittest
import uuid
import time
from unittest import mock

from coding import Coding, CodingError, local_request


class NativeCodingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="smithers-coding-test-")
        self.repo = self.tmp.name
        subprocess.run(["jj", "git", "init", self.repo], check=True, capture_output=True)
        self.jj("config", "set", "--repo", "user.name", "Coding Test")
        self.jj("config", "set", "--repo", "user.email", "coding@example.com")

    def tearDown(self):
        self.tmp.cleanup()

    def jj(self, *args):
        result = subprocess.run(["jj", "-R", self.repo, "--no-pager", *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def read(self, *ids):
        return Coding(self.repo, {"operation": "read", "changeIds": list(ids)}).run()

    def request(self, operation, target=None, **options):
        read = self.read()
        return dict(operation=operation, requestId=str(uuid.uuid4()), expectedOperationId=read["operationId"],
                    target=target or read["head"], **options)

    def apply(self, request):
        return Coding(self.repo, request).run()

    def assert_error(self, code, request):
        with self.assertRaises(CodingError) as caught:
            self.apply(request)
        self.assertEqual(caught.exception.code, code, caught.exception.message)

    def write(self, name, contents):
        with open(os.path.join(self.repo, name), "w") as out:
            out.write(contents)

    def snapshot(self):
        return self.apply(self.request("snapshot"))

    def create(self, description):
        return self.apply(self.request("create", description=description))

    def test_exact_receipt_survives_lost_ack_later_edit_and_new_process(self):
        request = self.request("create", description="one")
        accepted = self.apply(request)  # pretend transport loses this response
        self.create("later")
        import base64
        script = os.path.join(os.path.dirname(__file__), "coding.py")
        raw = subprocess.check_output(["python3", script, self.repo,
                                       base64.b64encode(json.dumps(request).encode()).decode()], text=True)
        replay = json.loads(raw)
        self.assertTrue(replay.pop("replayed"))
        accepted.pop("replayed")
        self.assertEqual(replay, accepted)
        changed = copy.deepcopy(request)
        changed["description"] = "different"
        self.assert_error("request_conflict", changed)

    def test_quoted_description_receipt_and_projection_survive_replay(self):
        description = "📝 docs: test\n\nAppend a '## Cloud development' section and \"quotes\"."
        request = self.request("create", description=description,
                               reportProvenance=True, workspaceId="owned")
        created = self.apply(request)
        self.assertEqual(created["status"], "accepted")
        self.assertTrue(self.apply(request)["replayed"])
        request = self.request("describe", description=description + " Updated 'again'.",
                               reportProvenance=True, workspaceId="owned")
        accepted = self.apply(request)
        self.create("later")
        replay = self.apply(request)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["operationId"], accepted["operationId"])
        projected = Coding(self.repo, {}).projections("owned")["coding_operations"]
        self.assertEqual([row["operationId"] for row in projected],
                         [created["operationId"], accepted["operationId"]])

    def test_history_reports_complete_or_truncated_at_an_explicit_1024_bound(self):
        self.create("one")
        self.create("two")
        complete = Coding(self.repo, {"operation": "read", "historyLimit": 3}).run()
        partial = Coding(self.repo, {"operation": "read", "historyLimit": 2}).run()
        self.assertTrue(complete["historyComplete"])
        self.assertFalse(partial["historyComplete"])
        self.assertEqual(len(complete["history"]), 3)
        self.assertEqual(partial["history"], complete["history"][1:])
        config = dict(version=1, workspaceId="owned", actorId=42, repositoryPath=self.repo)
        local_request(json.dumps(dict(operation="read", historyLimit=1024, repositoryPath=self.repo)), config)
        with self.assertRaises(CodingError):
            local_request(json.dumps(dict(operation="read", historyLimit=1025, repositoryPath=self.repo)), config)
        reader = Coding(self.repo, {"operation": "read", "historyLimit": 1024})
        rows = [{"parents": ["0" * 40], "ordinal": i} for i in range(1025)]
        with mock.patch.object(reader, "operation", return_value={"id": "a" * 128}), mock.patch.object(reader, "commit", return_value=rows[0]), mock.patch.object(reader, "revision", side_effect=lambda row, at: row), mock.patch.object(reader, "commits", return_value=rows) as read:
            result = reader.read()
            self.assertEqual(len(result["history"]), 1024)
            self.assertFalse(result["historyComplete"])
            self.assertEqual(read.call_args.kwargs["limit"], 1025)

    def test_publication_identity_and_capability_come_only_from_provisioning(self):
        source = self.read()["head"]
        config = dict(version=1, workspaceId="0f8fad5b-d9cb-469f-a165-70867728950e", repositoryId=200,
                      actorId=42, repositoryPath=self.repo, apiBaseUrl="https://example.test/api",
                      gitUrl="https://example.test/acme/widgets.git", credentialSocket="/tmp/cache/socket")
        request = dict(operation="publish_source", requestId=str(uuid.uuid4()), source=source, repositoryPath=self.repo)
        bound = local_request(json.dumps(request), config)
        self.assertEqual(bound["workspaceId"], config["workspaceId"])
        self.assertEqual(bound["repositoryId"], 200)
        for key in ("workspaceId", "repositoryId", "token", "apiBaseUrl", "credentialSocket"):
            with self.assertRaises(CodingError):
                local_request(json.dumps(dict(request, **{key: "forged"})), config)
        with self.assertRaises(CodingError) as error:
            local_request(json.dumps(request), {key: value for key, value in config.items() if key != "apiBaseUrl"})
        self.assertEqual(error.exception.code, "source_publication_unavailable")

    def test_publication_requires_exact_helper_ack_and_does_not_log_credentials(self):
        source = self.read()["head"]
        workspace = "0f8fad5b-d9cb-469f-a165-70867728950e"
        request = dict(operation="publish_source", requestId=str(uuid.uuid4()), source=source, workspaceId=workspace, repositoryId=200)
        native = dict(change_id=source["changeId"], commit_id=source["commitId"], tree_id=source["treeId"], parent_commit_ids=source["parentCommitIds"])
        receipt = dict(status="retained", workspace_id=workspace, repository_id=200, ref="refs/smithers/workspaces/" + workspace + "/sources/" + source["commitId"], source=native)
        for mode in ("accepted", "wrong-workspace", "wrong-source", "missing-source"):
            result = copy.deepcopy(receipt)
            if mode == "wrong-workspace": result["workspace_id"] = "other"
            if mode == "wrong-source": result["source"]["tree_id"] = "a" * 40
            if mode == "missing-source": del result["source"]
            process = mock.Mock(returncode=0)
            process.communicate.return_value = (json.dumps(result), None)
            with mock.patch("coding.subprocess.Popen", return_value=process) as spawn:
                if mode == "accepted":
                    accepted = Coding(self.repo, request).publish_source()
                    self.assertEqual(accepted["source"]["commitId"], source["commitId"])
                    self.assertNotIn("token", json.dumps(accepted))
                else:
                    with self.assertRaises(CodingError): Coding(self.repo, request).publish_source()
                arguments = spawn.call_args.args[0]
                self.assertEqual(arguments[1], "--publish-source")
                payload = json.loads(process.communicate.call_args.args[0])
                self.assertEqual(set(payload), {"source", "expected_operation_id"})
                self.assertNotIn("token", json.dumps(payload))

    def test_publication_timeout_kills_and_waits_for_its_process_group(self):
        request = dict(operation="publish_source", requestId=str(uuid.uuid4()), source=self.read()["head"], workspaceId="owned", repositoryId=200)
        process = mock.Mock(pid=12345)
        process.communicate.side_effect = subprocess.TimeoutExpired("native-helper", 180)
        with mock.patch("coding.subprocess.Popen", return_value=process), mock.patch("coding.os.killpg") as kill:
            with self.assertRaises(CodingError) as error: Coding(self.repo, request).publish_source()
            self.assertEqual(error.exception.code, "source_publication_unavailable")
            self.assertEqual(process.communicate.call_args.kwargs["timeout"], 180)
            kill.assert_called_once_with(12345, signal.SIGKILL)
            process.wait.assert_called_once()

    def test_publication_cancellation_stops_helper_descendants_and_releases_native_lock(self):
        request = dict(operation="publish_source", requestId=str(uuid.uuid4()), source=self.read()["head"], workspaceId="owned", repositoryId=200)
        marker, helper, wrapper = [os.path.join(self.repo, name) for name in ("helper-pids.json", "helper.py", "cancel.py")]
        # Publish only complete JSON: marker existence is the readiness signal.
        with open(helper, "w") as out:
            # Publish readiness only after the complete PID list is readable.
            # Otherwise the parent's exists() poll can observe an empty file.
            out.write("#!/usr/bin/env python3\nimport json,os,subprocess,time\nchild=subprocess.Popen(['python3','-c','import time; time.sleep(60)'])\nwith open(" + repr(marker + ".tmp") + ",'w') as out: json.dump([os.getpid(),child.pid],out)\nos.replace(" + repr(marker + ".tmp") + "," + repr(marker) + ")\ntime.sleep(60)\n")
        os.chmod(helper, 0o700)
        with open(wrapper, "w") as out:
            out.write("import json,sys\nsys.path.insert(0," + repr(os.path.dirname(__file__)) + ")\nimport coding\ncoding.JJ_HELPER=" + repr(helper) + "\ntry:\n coding.Coding(" + repr(self.repo) + ",json.loads(" + repr(json.dumps(request)) + ")).run()\nexcept coding.CodingError as error:\n print(error.code)\n sys.exit(1)\n")
        adapter = subprocess.Popen(["python3", wrapper], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 15
            while not os.path.exists(marker):
                self.assertIsNone(adapter.poll(), "adapter exited before helper start")
                self.assertLess(time.monotonic(), deadline, "helper did not start")
                time.sleep(0.02)
            with open(marker) as file: pids = json.load(file)
            adapter.send_signal(signal.SIGTERM)
            stdout, stderr = adapter.communicate(timeout=10)
            self.assertEqual(adapter.returncode, 1, stderr)
            self.assertIn("source_publication_unavailable", stdout)
            for pid in pids:
                state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
                self.assertTrue(not state or state.startswith("Z"), "helper descendant still running: " + state)
            # The same shared lock can immediately be acquired for a native read.
            self.assertEqual(self.read()["head"]["commitId"], request["source"]["commitId"])
        finally:
            if adapter.poll() is None:
                adapter.kill()
                adapter.wait()

    def test_parallel_same_request_only_one_native_operation(self):
        request = self.request("create", description="parallel")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(self.apply, [request, request]))
        self.assertEqual(results[0]["operationId"], results[1]["operationId"])
        self.assertEqual(sorted(result["replayed"] for result in results), [False, True])

    def test_local_projections_replay_native_history_in_bounded_batches(self):
        config = dict(version=1, workspaceId="owned", actorId=42, repositoryPath=self.repo)
        def local(operation, **fields):
            request = local_request(json.dumps(dict(self.request(operation, **fields), repositoryPath=self.repo)), config)
            request["requireReporterLock"] = False  # Native harness has no guest service installation.
            return request
        request = local("create", description="local one")
        first = self.apply(request)
        self.jj("describe", "-m", "unrelated later operation")
        second = self.apply(local("create", description="local two"))
        # A receipt recipe is small, immutable, and never stores commit prose.
        log = self.jj("--ignore-working-copy", "op", "log", "--no-graph", "-T", "json(self)")
        self.assertIn("smithers.coding-projection", log)
        p = Coding(self.repo, {}).projections("owned", limit=1)
        self.assertEqual([record["operationId"] for record in p["coding_operations"]], [first["operationId"]])
        self.assertEqual(p["coding_operations"][0]["changeIds"], [row["changeId"] for row in first["revisions"]])
        self.assertTrue(p["more"])
        q = Coding(self.repo, {}).projections("owned", p["cursor"], limit=1)
        self.assertEqual([record["operationId"] for record in q["coding_operations"]], [second["operationId"]])
        self.assertFalse(q["more"])
        self.assertEqual(Coding(self.repo, {}).projections("owned", q["cursor"])["coding_operations"], [])
        self.assertEqual(Coding(self.repo, {}).projections("other")["coding_operations"], [])
        # Lost report acknowledgement/restart simply produces the same native rows.
        self.assertEqual(Coding(self.repo, {}).projections("owned", limit=1), p)
        self.assertEqual(self.apply(request)["operationId"], first["operationId"])

    def test_local_binding_refuses_actor_override_other_path_and_conflicted_target(self):
        config = dict(version=1, workspaceId="owned", actorId=42, repositoryPath=self.repo)
        request = dict(self.request("create", description="local"), repositoryPath=self.repo)
        bound = local_request(json.dumps(request), config)
        self.assertEqual((bound["actorId"], bound["workspaceId"]), (42, "owned"))
        self.assertTrue(bound["reportProvenance"])
        for edited in (dict(request, actorId=99), dict(request, workspaceId="another"),
                       dict(request, repositoryPath="/another"), dict(request, target=dict(request["target"], kind="conflicted"))):
            with self.assertRaises(CodingError) as caught:
                local_request(json.dumps(edited), config)
            self.assertEqual(caught.exception.code, "invalid_request")

    def test_pending_invocation_before_native_commit_can_retry(self):
        request = self.request("create", description="retry")
        # No extra controller/guest ledger is required: before native commit
        # there is no receipt and the exact precondition remains valid.
        first = Coding(self.repo, request)
        original = first.jj
        def interrupted(args, *positional, **kwargs):
            if "new" in args:
                raise OSError("guest interrupted before native commit")
            return original(args, *positional, **kwargs)
        first.jj = interrupted
        with self.assertRaises(OSError):
            first.run()
        self.assertEqual(self.apply(request)["status"], "accepted")

    def test_stale_exact_parent_and_operation_fail_without_mutation(self):
        request = self.request("create", description="wrong parent")
        request["target"]["parentCommitIds"] = ["1" * 40]
        before = self.read()["operationId"]
        self.assert_error("revision_conflict", request)
        self.assertEqual(self.read()["operationId"], before)
        request = self.request("create", description="stale")
        self.jj("describe", "-m", "external")
        before = self.read()["operationId"]
        self.assert_error("operation_conflict", request)
        self.assertEqual(self.read()["operationId"], before)

    def test_dirty_workspace_preserved_but_not_implicitly_accepted(self):
        request = self.request("create", description="must replan")
        self.write("draft.txt", "valuable dirty edit\n")
        self.assert_error("dirty_workspace", request)
        self.assertEqual(self.jj("file", "show", 'root:"draft.txt"'), "valuable dirty edit\n")
        current = self.read()
        self.assertNotEqual(current["head"]["treeId"], request["target"]["treeId"])
        self.assertNotEqual(current["head"]["commitId"], request["target"]["commitId"])
        self.assertEqual(current["head"]["changeId"], request["target"]["changeId"])

    def test_snapshot_is_exact_replayable_receipt(self):
        self.write("unicode.txt", "🙂 λ\n")
        request = self.request("snapshot")
        result = self.apply(request)
        self.assertEqual(result["revision"]["kind"], "resolved")
        self.assertNotEqual(result["revision"]["treeId"], request["target"]["treeId"])
        self.create("later")
        self.assertEqual(self.apply(request)["revision"], result["revision"])

    def test_native_describe_reorder_and_amend_restack_without_bookmarks(self):
        a = self.read()["head"]["changeId"]
        self.write("a", "a\n")
        self.snapshot()
        b = self.create("b")["revision"]["changeId"]
        self.write("b", "b\n")
        self.snapshot()
        c = self.create("c")["revision"]["changeId"]
        self.write("c", "c\n")
        self.snapshot()
        state = self.read(a, b, c)
        ra, rb, rc = state["revisions"]
        moved = self.apply(self.request("reorder", rc, after=ra))
        self.assertEqual(moved["revision"]["changeId"], c)
        state = self.read(a, b, c)
        ra, rb, rc = state["revisions"]
        self.assertEqual(rc["parentCommitIds"], [ra["commitId"]])
        self.assertEqual(rb["parentCommitIds"], [rc["commitId"]])
        described = self.apply(self.request("describe", ra, description="fundamental"))
        self.assertEqual(described["revision"]["changeId"], a)
        state = self.read(a, b, c)
        ra, rb, rc = state["revisions"]
        amended = self.apply(self.request("amend", ra, source=rc))
        self.assertEqual(amended["revision"]["changeId"], a)
        state = self.read(a, b, c)
        self.assertTrue(state["revisions"][2]["empty"])
        self.assertEqual(self.jj("bookmark", "list").strip(), "")

    def test_edit_returns_to_tip_after_older_insert_and_replays_exact_head(self):
        a = self.read()["head"]["changeId"]
        b = self.create("tip")["revision"]["changeId"]
        earlier = self.read(a)["revisions"][0]
        inserted = self.apply(self.request("create", earlier, description="inserted"))
        self.assertEqual(self.read()["head"]["changeId"], inserted["revision"]["changeId"])
        tip = self.read(b)["revisions"][0]
        request = self.request("edit", tip)
        result = self.apply(request)
        self.assertEqual(result["head"]["changeId"], b)
        self.create("later")
        replay = self.apply(request)
        self.assertEqual(replay["head"], result["head"])
        self.assertTrue(replay["replayed"])

    def test_external_divergent_operation_heads_are_not_merged(self):
        request = self.request("create", description="no auto merge")
        old = request["expectedOperationId"]
        self.jj("describe", "-m", "external one")
        self.jj("--at-op=" + old, "describe", "-m", "external two")
        heads = os.path.join(self.repo, ".jj", "repo", "op_heads", "heads")
        before = sorted(os.listdir(heads))
        self.assertEqual(len(before), 2)
        self.assert_error("jj_conflict", request)
        self.assertEqual(sorted(os.listdir(heads)), before)

    def test_conflicts_return_native_tree_terms_without_fake_tree_id(self):
        self.write("shared", "base\n")
        self.snapshot()
        a = self.read()["head"]["changeId"]
        self.create("b")
        self.write("shared", "b\n")
        self.snapshot()
        self.create("c")
        self.write("shared", "c\n")
        self.snapshot()
        state = self.read(a)
        result = self.apply(self.request("reorder", state["head"], after=state["revisions"][0]))
        conflicted = [row for row in result["revisions"] if row["kind"] == "conflicted"]
        self.assertTrue(conflicted)
        for row in conflicted:
            self.assertNotIn("treeId", row)
            self.assertTrue(row["treeTerms"])


if __name__ == "__main__":
    unittest.main()

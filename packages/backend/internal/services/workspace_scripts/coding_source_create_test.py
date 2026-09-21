"""Adapter contract; actual JJ tree and transfer proofs live in source_create.rs."""
import copy
import hashlib
import json
import subprocess
import unittest
import uuid
from unittest import mock

from coding import Coding, CodingError, local_request


class SourceCreationAdapterTest(unittest.TestCase):
    def fixture(self):
        base = dict(kind="resolved", changeId="k" * 32, commitId="a" * 40, treeId="b" * 40, operationId="c" * 128, parentCommitIds=["d" * 40])
        config = dict(version=1, workspaceId=str(uuid.uuid4()), actorId=2, repositoryId=3, repositoryPath="/owned/repository", apiBaseUrl="https://example.invalid/api", gitUrl="https://example.invalid/owner/repo.git", credentialSocket="/owned/cache")
        request = dict(operation="create_source", repositoryPath=config["repositoryPath"], requestId=str(uuid.uuid4()), expectedOperationId=base["operationId"], base=base,
                       description="A checked change", files=[dict(path="code.txt", beforeDigest=hashlib.sha256(b"before").hexdigest(), content="after")])
        return config, request

    def test_creation_and_publication_bind_provisioned_identity(self):
        config, raw = self.fixture()
        request = local_request(json.dumps(raw), config)
        self.assertEqual(request["workspaceId"], config["workspaceId"])
        self.assertEqual(request["repositoryId"], 3)
        self.assertTrue(request["requireReporterLock"])
        for field in ("actorId", "workspaceId", "repositoryId", "gitUrl", "creation"):
            with self.subTest(field=field), self.assertRaises(CodingError): local_request(json.dumps({**raw, field: "forged"}), config)
        proof = dict(requestId=raw["requestId"], requestDigest="a" * 64)
        publication = dict(operation="publish_source", repositoryPath=config["repositoryPath"], requestId=str(uuid.uuid4()), source=raw["base"], creation=proof)
        self.assertEqual(local_request(json.dumps(publication), config)["creation"], proof)
        for changed in ({**proof, "owner": 2}, {**proof, "requestDigest": "invalid"}, {**proof, "requestId": str(uuid.UUID(int=0))}):
            with self.assertRaises(CodingError): local_request(json.dumps({**publication, "creation": changed}), config)

    def test_capability_requires_both_installed_helper_operations(self):
        coding = Coding("/owned/repository", {})
        for capabilities in ([], ["create-source/v1"], ["publish-created-source/v1"], ["create-source/v1", "publish-created-source/v1"]):
            result = subprocess.CompletedProcess([], 0, json.dumps(dict(capabilities=capabilities)), "")
            with mock.patch("coding.subprocess.run", return_value=result) as call:
                self.assertEqual(coding.creation_capabilities(), ["create-source/v1"] if len(capabilities) == 2 else [])
                self.assertEqual(call.call_args.args[0][1:], ["--capabilities"])
        with mock.patch("coding.subprocess.run", side_effect=FileNotFoundError()): self.assertEqual(coding.creation_capabilities(), [])

    def test_proposal_and_native_fences_reject_before_helper_invocation(self):
        config, raw = self.fixture()
        for kind in ("stale-base", "metadata", "overlap", "traversal", "size", "owner", "extra"):
            changed, binding = copy.deepcopy(raw), copy.deepcopy(config)
            if kind == "stale-base": changed["base"]["operationId"] = "f" * 128
            elif kind == "metadata": changed["files"][0]["path"] = ".smithers/flows/job.md"
            elif kind == "overlap": changed["files"].append(dict(path="code.txt/child", beforeDigest=None, content="new"))
            elif kind == "traversal": changed["files"][0]["path"] = "../outside"
            elif kind == "size": changed["files"][0]["content"] = "x" * (262144 + 1)
            elif kind == "owner": binding["actorId"] = -1
            else: changed["base"]["url"] = "https://untrusted.invalid"
            with self.subTest(kind=kind), mock.patch("coding.subprocess.Popen") as spawn, self.assertRaises(CodingError):
                local_request(json.dumps(changed), binding)
            spawn.assert_not_called()

    def test_created_receipt_retains_race_outcome_and_refuses_another_base_or_owner(self):
        config, raw = self.fixture()
        request, base = local_request(json.dumps(raw), config), raw["base"]
        original = dict(status="created", replayed=False, requestId=request["requestId"], requestDigest="a" * 64,
                        workspaceId=config["workspaceId"], repositoryId=3, parentOperationId=base["operationId"], operationId="e" * 128,
                        base=dict(change_id=base["changeId"], commit_id=base["commitId"], tree_id=base["treeId"], parent_commit_ids=base["parentCommitIds"]),
                        head={**base, "operationId": "e" * 128}, source={**base, "commitId": "f" * 40, "operationId": "e" * 128, "parentCommitIds": [base["commitId"]]}, publicationReady=False)
        for kind in ("valid", "owner", "parent", "base", "operation"):
            result = copy.deepcopy(original)
            if kind == "owner": result["repositoryId"] += 1
            elif kind == "parent": result["source"]["parentCommitIds"] = ["f" * 40]
            elif kind == "base": result["base"]["tree_id"] = "f" * 40
            elif kind == "operation": result["parentOperationId"] = "f" * 128
            with self.subTest(kind=kind), mock.patch.object(Coding, "source_helper", return_value=result) as invoke:
                if kind == "valid":
                    value = Coding(config["repositoryPath"], request).create_source()
                    self.assertFalse(value["publicationReady"])
                    self.assertEqual(value["source"], result["source"])
                    self.assertEqual(value["base"]["commitId"], base["commitId"])
                    self.assertEqual(invoke.call_args.args[0], "--create-source")
                    self.assertNotIn("workspaceId", invoke.call_args.args[1])
                else:
                    with self.assertRaises(CodingError): Coding(config["repositoryPath"], request).create_source()

    def test_legacy_publication_still_validates_exact_remote_ack(self):
        config, raw = self.fixture()
        request = local_request(json.dumps(dict(operation="publish_source", repositoryPath=config["repositoryPath"], requestId=raw["requestId"], source=raw["base"])), config)
        source = raw["base"]
        ack = dict(status="retained", workspace_id=config["workspaceId"], repository_id=3,
                   ref="refs/smithers/workspaces/" + config["workspaceId"] + "/sources/" + source["commitId"],
                   source=dict(change_id=source["changeId"], commit_id=source["commitId"], tree_id=source["treeId"], parent_commit_ids=source["parentCommitIds"]))
        with mock.patch.object(Coding, "source_helper", return_value=ack) as helper:
            self.assertEqual(Coding(config["repositoryPath"], request).publish_source()["source"]["commitId"], source["commitId"])
            self.assertNotIn("creation", helper.call_args.args[1])
        ack["repository_id"] = 4
        with mock.patch.object(Coding, "source_helper", return_value=ack), self.assertRaises(CodingError): Coding(config["repositoryPath"], request).publish_source()

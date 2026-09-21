"""Compare private preflight with the actual pinned JJ snapshot behavior."""
import json
import os
from pathlib import Path
import subprocess
import unittest

import coding
import coding_engine_test


@unittest.skipUnless(os.environ.get("SMITHERS_JJ_EXPORT_BINARY"), "requires built native JJ helper")
class NativeEligibilityTest(unittest.TestCase):
    state = coding_engine_test.NativeEngineSnapshotTest.state
    request = coding_engine_test.NativeEngineSnapshotTest.request

    def setUp(self):
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1")
        coding_engine_test.NativeEngineSnapshotTest.setUp(self)
        self.script.write_text(self.script.read_text().replace(
            coding.JJ_HELPER, os.environ["SMITHERS_JJ_EXPORT_BINARY"]))
        self.git_config = Path(self.tmp.name) / "global-git-config"
        self.git_config.write_text("")
        self.env["GIT_CONFIG_GLOBAL"] = str(self.git_config)

    def jj(self, *args):
        result = subprocess.run(["jj", "-R", str(self.repo), "--no-pager", "--color=never", *args],
                                capture_output=True, text=True, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def engine(self, operation, error=None, **fields):
        result = subprocess.run(["python3", str(self.script), "--engine"],
                                input=json.dumps(self.request(operation, **fields)),
                                capture_output=True, text=True, env=self.env)
        body = json.loads(result.stdout)
        if error:
            self.assertEqual(result.returncode, 1)
            self.assertEqual(body["error"]["code"], error, body)
        else:
            self.assertEqual(result.returncode, 0, (body, result.stderr))
        return body

    def eligible(self, path, size=8, reason=None):
        before = self.state()
        result = self.engine("eligible", path=path, byteLength=size)
        self.assertEqual(self.state(), before, "preflight changed native operation or commit")
        expected = {"eligible": False, "reason": reason} if reason else {"eligible": True}
        self.assertEqual(result, expected, path)

    def tracked(self):
        return set(json.loads(line) for line in self.jj("--ignore-working-copy", "file", "list", "-T",
                                                       'json(path) ++ "\\n"').splitlines())

    def test_new_ignored_and_nested_directory_negation_match_native_capture(self):
        (self.repo / ".gitignore").write_text("*.log\nblocked/\n!blocked/keep.txt\n")
        (self.repo / "blocked").mkdir()
        (self.repo / "blocked/.gitignore").write_text("!keep.txt\n")
        (self.repo / "nested").mkdir()
        (self.repo / "nested/.gitignore").write_text("!keep.log\n")
        self.eligible("fresh.txt")
        self.eligible("ignored.log", reason="ignored_path")
        self.eligible("nested/other.log", reason="ignored_path")
        self.eligible("nested/keep.log")
        self.eligible("blocked/keep.txt", reason="ignored_directory")
        for path in ("fresh.txt", "ignored.log", "nested/other.log", "nested/keep.log", "blocked/keep.txt"):
            (self.repo / path).write_text("new file")
        self.jj("status")
        tracked = self.tracked()
        self.assertIn("fresh.txt", tracked)
        self.assertIn("nested/keep.log", tracked)
        self.assertTrue(tracked.isdisjoint({"ignored.log", "nested/other.log", "blocked/keep.txt"}))

    def test_tracked_ignored_files_bypass_new_file_rules(self):
        (self.repo / "known.log").write_text("already tracked\n")
        self.jj("status")
        (self.repo / ".gitignore").write_text("*.log\n")
        self.jj("config", "set", "--repo", "snapshot.auto-track", "none()")
        self.jj("config", "set", "--repo", "snapshot.max-new-file-size", "1")
        self.eligible("known.log", 100_000)
        self.eligible("new.log", reason="ignored_path")
        self.eligible("new.txt", reason="not_auto_tracked")
        (self.repo / "known.log").write_text("x" * 100_000)
        self.jj("status")
        self.assertEqual(self.jj("file", "show", 'root:"known.log"'), "x" * 100_000)

    def test_new_ignore_file_requires_native_preparation(self):
        self.eligible(".gitignore", reason="untracked_ignore_file")
        self.eligible("nested/.gitignore", reason="untracked_ignore_file")
        self.eligible(".GITIGNORE", reason="untracked_ignore_file")
        self.eligible("nested/.GitIgnore", reason="untracked_ignore_file")
        (self.repo / ".gitignore").write_text("# prepared in the native change\n")
        self.jj("status")
        self.eligible(".gitignore", 100)
        (self.repo / ".gitignore").write_text("*\n")
        self.jj("status")
        self.assertIn(".gitignore", self.tracked())

    def test_global_repo_and_local_ignore_precedence(self):
        global_ignore = Path(self.tmp.name) / "global-ignore"
        global_ignore.write_text("*.global\n*.override\n")
        self.git_config.write_text("[core]\nexcludesFile = " + json.dumps(str(global_ignore)) + "\n")
        target = (self.repo / ".jj/repo/store/git_target").read_text().strip()
        native_git = (self.repo / ".jj/repo/store" / target).resolve()
        (native_git / "info").mkdir(exist_ok=True)
        (native_git / "info/exclude").write_text("*.local\n!allowed.global\n")
        (self.repo / ".gitignore").write_text("!allowed.local\n!yes.override\n")
        for path, reason in (("denied.global", "ignored_path"), ("denied.local", "ignored_path"),
                             ("allowed.global", None), ("allowed.local", None), ("yes.override", None)):
            self.eligible(path, reason=reason)
            (self.repo / path).write_text("12345678")
        self.jj("status")
        self.assertTrue(self.tracked().issuperset({"allowed.global", "allowed.local", "yes.override"}))
        self.assertTrue(self.tracked().isdisjoint({"denied.global", "denied.local"}))
        # Effective backend-local core.excludesFile overrides the global setting;
        # its relative path is rooted at the workspace, exactly as native JJ.
        (self.repo / "repo-ignore").write_text("*.repo\n")
        with (native_git / "config").open("a") as config:
            config.write('\n[core]\nexcludesFile = "repo-ignore"\n')
        self.eligible("fresh.global")
        self.eligible("fresh.repo", reason="ignored_path")
        for path in ("fresh.global", "fresh.repo"):
            (self.repo / path).write_text("12345678")
        self.jj("status")
        self.assertIn("fresh.global", self.tracked())
        self.assertNotIn("fresh.repo", self.tracked())

    def test_native_auto_track_aliases_and_size_limit(self):
        self.jj("config", "set", "--repo", 'fileset-aliases."sources()"', json.dumps('glob:"**/*.ts"'))
        self.jj("config", "set", "--repo", "snapshot.auto-track", "sources()")
        self.jj("config", "set", "--repo", "snapshot.max-new-file-size", json.dumps("1KiB"))
        self.eligible("small.ts", 1024)
        self.eligible("big.ts", 1025, reason="new_file_too_large")
        self.eligible("file.js", reason="not_auto_tracked")
        for name, size in (("small.ts", 1024), ("big.ts", 1025), ("file.js", 8)):
            (self.repo / name).write_bytes(b"x" * size)
        self.jj("status")
        self.assertIn("small.ts", self.tracked())
        self.assertTrue(self.tracked().isdisjoint({"big.ts", "file.js"}))
        self.jj("config", "set", "--repo", "snapshot.max-new-file-size", "0")
        self.eligible("huge.ts", 1 << 40)

    def test_native_xdg_default_global_ignore_without_config_override(self):
        # The installed adapter owns HOME/XDG; exercise the native helper with
        # an isolated equivalent environment to avoid modifying the real user.
        config = Path(self.tmp.name) / "xdg"
        (config / "git").mkdir(parents=True)
        (config / "git/ignore").write_text("*.generated\n")
        env = dict(self.env, XDG_CONFIG_HOME=str(config), HOME=self.tmp.name)
        head = self.state()["head"]["commitId"]
        def check(path):
            raw = dict(commitId=head, path=path, byteLength=8, autoTrack="all()",
                       maxNewFileSize="26000000", filesetAliases="")
            result = subprocess.run([os.environ["SMITHERS_JJ_EXPORT_BINARY"], "--eligible", str(self.repo)],
                                    input=json.dumps(raw), capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        before = self.state()
        self.assertEqual(check("new.generated"), {"eligible": False, "reason": "ignored_path"})
        self.assertEqual(check("new.txt"), {"eligible": True})
        self.assertEqual(self.state(), before)
        (self.repo / "new.generated").write_text("12345678")
        (self.repo / "new.txt").write_text("12345678")
        result = subprocess.run(["jj", "-R", str(self.repo), "status"], capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("new.txt", self.tracked())
        self.assertNotIn("new.generated", self.tracked())

    def test_native_sparse_paths_exclude_even_tracked_files(self):
        (self.repo / "kept").mkdir()
        (self.repo / "kept/file").write_text("kept")
        (self.repo / "outside").write_text("tracked but excluded")
        self.jj("status")
        self.jj("sparse", "set", "--clear", "--add", "kept")
        self.eligible("kept/new")
        self.eligible("outside", reason="outside_sparse_snapshot")
        self.eligible("elsewhere/new", reason="outside_sparse_snapshot")

    def test_symlink_metadata_and_nonregular_targets_refuse(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "value").write_text("must remain unchanged")
        (self.repo / "link").symlink_to(outside, target_is_directory=True)
        (self.repo / "file-link").symlink_to(outside / "value")
        (self.repo / "directory").mkdir()
        self.eligible("link/value", reason="symlink_path")
        self.eligible("file-link", reason="symlink_path")
        self.eligible("directory", reason="nonregular_path")
        for path in (".jj/config", ".git/config", "parent/.JJ/config"):
            self.eligible(path, reason="repository_metadata")
        self.assertEqual((outside / "value").read_text(), "must remain unchanged")
        for path in ("../outside/value", "/outside", "a/../outside", "a//b", "./a"):
            self.engine("eligible", error="eligibility_unavailable", path=path, byteLength=1)
        for size in (-1, 1.5, True, "5", 1 << 53):
            self.engine("eligible", error="invalid_request", path="safe", byteLength=size)

    def test_missing_helper_and_unsupported_config_fail_closed(self):
        self.jj("config", "set", "--repo", "snapshot.auto-track", "missing_alias()")
        self.engine("eligible", error="eligibility_unavailable", path="new", byteLength=1)
        self.jj("config", "set", "--repo", "snapshot.auto-track", "all()")
        self.script.write_text(self.script.read_text().replace(os.environ["SMITHERS_JJ_EXPORT_BINARY"],
                                                              str(Path(self.tmp.name) / "missing-helper")))
        self.engine("eligible", error="guest_failure", path="new", byteLength=1)

    def test_helper_response_requires_an_actual_boolean(self):
        helper = Path(self.tmp.name) / "numeric-helper"
        helper.write_text('#!/bin/sh\nprintf \'{"eligible":1}\\n\'\n')
        helper.chmod(0o755)
        self.script.write_text(self.script.read_text().replace(os.environ["SMITHERS_JJ_EXPORT_BINARY"], str(helper)))
        self.engine("eligible", error="eligibility_unavailable", path="new", byteLength=1)


if __name__ == "__main__":
    unittest.main()

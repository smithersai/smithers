"""Opinionated JJ 0.39 adapter, executed in the existing owning sandbox.

The only durable mutation receipt is JJ's operation metadata. The lock is an
advisory guest lock shared with the workspace head reporter, not a job ledger.
"""
import base64
import ctypes
import fcntl
import hashlib
import json
import os
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit

REPORTER_SCRIPT = "/usr/local/bin/smithers-workspace-head"
JJ_HELPER = "/usr/local/bin/smithers-jj-export"
EGRESS_ENV = "/etc/smithers/egress.env"
EGRESS_CA = "/etc/smithers/egress-ca.pem"


class CodingError(Exception):
    def __init__(self, code, message, recovery=None):
        self.code, self.message = code, message
        self.recovery = recovery


def fail(code, message, recovery=None):
    raise CodingError(code, message, recovery)


def managed_source_file(path, limit):
    """Read fixed provisioning data without following workspace-owned links."""
    # Detect an absent managed file before walking Linux's protected path.
    # This also permits unprovisioned local hosts where /etc is an OS symlink.
    # Existing files still undergo the complete no-follow ownership check.
    os.lstat(path)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = path.strip("/").split("/")
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                fail("source_import_unavailable", "Managed source transport configuration is not protected")
        child = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(child)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or stat.S_IMODE(before.st_mode) & 0o022 or before.st_size > limit:
                fail("source_import_unavailable", "Managed source transport configuration is not protected")
            data = bytearray()
            while len(data) <= limit:
                block = os.read(child, min(65536, limit + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
            after = os.fstat(child)
            identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if len(data) > limit or identity(before) != identity(after):
                fail("source_import_unavailable", "Managed source transport configuration changed; retry")
            return bytes(data)
        finally:
            os.close(child)
    finally:
        os.close(fd)


def managed_source_transport():
    # The guest firewall deliberately denies direct egress. Trust only the
    # worker's root-owned routing/CA bundle, never the invocation environment,
    # repository configuration, or shell evaluation of this file.
    try:
        raw = managed_source_file(EGRESS_ENV, 16384)
    except FileNotFoundError:
        # Local native repositories may have no managed guest transport.
        return []
    except OSError:
        fail("source_import_unavailable", "Managed source transport configuration is unavailable")
    try:
        values = {}
        for line in raw.decode().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            fields = shlex.split(line, posix=True)
            if len(fields) != 2 or fields[0] != "export" or "=" not in fields[1]:
                raise ValueError()
            key, value = fields[1].split("=", 1)
            if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", key) or key in values or any(ord(c) < 32 or ord(c) == 127 for c in value):
                raise ValueError()
            values[key] = value
        address = values["HTTPS_PROXY"]
        proxy = urlsplit(address)
        if any(values[key] != address for key in ("https_proxy", "HTTP_PROXY", "http_proxy")) or proxy.scheme != "http" or proxy.hostname != "host.microsandbox.internal" or not proxy.port or proxy.username is not None or proxy.password is not None or proxy.path or proxy.query or proxy.fragment:
            raise ValueError()
        if any(values[key] != EGRESS_CA for key in ("GIT_SSL_CAINFO", "SSL_CERT_FILE", "CURL_CA_BUNDLE")):
            raise ValueError()
        managed_source_file(EGRESS_CA, 1 << 20)
        return [("http.proxy", address), ("http.sslCAInfo", EGRESS_CA), ("http.sslVerify", "true")]
    except (ValueError, KeyError, OSError):
        fail("source_import_unavailable", "Managed source transport routing or trust is unavailable")


def validate_file_patch(files):
    if not isinstance(files, list) or not 1 <= len(files) <= 30:
        fail("invalid_request", "apply_files requires 1 to 30 file edits")
    paths, size = set(), 0
    for file in files:
        if not isinstance(file, dict) or file.keys() != {"path", "beforeDigest", "content"}:
            fail("invalid_request", "file edits require path, beforeDigest and content")
        path, before, content = file["path"], file["beforeDigest"], file["content"]
        if not isinstance(path, str) or len(path.encode()) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in path) or "\\" in path:
            fail("invalid_request", "file paths must be canonical relative paths")
        parts = path.split("/")
        if any(part in ("", ".", "..", ".git", ".jj") for part in parts) or path in paths:
            fail("invalid_request", "file paths must be distinct and cannot enter native metadata")
        if before is not None and (not isinstance(before, str) or not re.fullmatch(r"[0-9a-f]{64}", before)):
            fail("invalid_request", "file preimages require SHA256 or null for absent files")
        if content is not None and not isinstance(content, str):
            fail("invalid_request", "file contents must be text or null for deletion")
        encoded = content.encode() if content is not None else None
        if before == (hashlib.sha256(encoded).hexdigest() if encoded is not None else None):
            fail("invalid_request", "each file edit must change its preimage")
        size += len(encoded) if encoded is not None else 0
        paths.add(path)
    if size > 256 << 10 or any("/".join(path.split("/")[:i]) in paths for path in paths for i in range(1, len(path.split("/")))):
        fail("invalid_request", "file edits exceed 256 KiB or overlap ancestor paths")


class FilePatch:
    """Retained preimages, not a transaction over an arbitrary editor's writes.

    A moved inode is never discarded: an editor with an old open descriptor
    can still write recoverable bytes after the path has been replaced. Partial
    installation fails visibly and never rolls back over a newer file. JJ's
    operation metadata remains the only accepted-mutation receipt.
    """
    def __init__(self, repo, request, digest):
        self.root, self.request, self.digest = os.path.realpath(repo), request, digest
        self.root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.fds, self.directory, self.manifest = [self.root_fd], None, None

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)

    def parent(self, path, create=False):
        visible = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            pinned, current = os.fstat(self.root_fd), os.fstat(visible)
            if (pinned.st_dev, pinned.st_ino) != (current.st_dev, current.st_ino):
                fail("file_conflict", "repository directory changed during installation", self.receipt())
        finally:
            os.close(visible)
        fd = os.dup(self.root_fd)
        try:
            for part in path.split("/")[:-1]:
                if create:
                    try:
                        os.mkdir(part, 0o755, dir_fd=fd)
                    except FileExistsError:
                        pass
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            return fd
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def state(fd, name):
        try:
            file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except FileNotFoundError:
            return None
        try:
            before = os.fstat(file)
            if not stat.S_ISREG(before.st_mode) or before.st_size > 8 << 20:
                fail("file_conflict", "file preimage must be a bounded regular file")
            digest, count = hashlib.sha256(), 0
            while block := os.read(file, 64 << 10):
                digest.update(block)
                count += len(block)
                if count > 8 << 20:
                    fail("file_conflict", "file preimage changed while reading")
            after = os.fstat(file)
            identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if identity(before) != identity(after):
                fail("file_conflict", "file preimage changed while reading")
            return dict(device=after.st_dev, inode=after.st_ino, digest=digest.hexdigest(), mode=stat.S_IMODE(after.st_mode))
        finally:
            os.close(file)

    def current(self, path):
        try:
            parent = self.parent(path)
        except FileNotFoundError:
            return None
        try:
            return self.state(parent, path.split("/")[-1])
        finally:
            os.close(parent)

    @staticmethod
    def private_dir(parent, name):
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            os.close(fd)
            fail("file_recovery_required", "file recovery directory must be private to the workspace owner")
        return fd

    def open_recovery(self):
        parent = os.open(os.path.dirname(self.root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.fds.append(parent)
        parts = [".smithers-coding-recovery", hashlib.sha256(self.root.encode()).hexdigest(), self.request["requestId"]]
        for part in parts:
            parent = self.private_dir(parent, part)
            self.fds.append(parent)
        self.recovery_fd = parent
        self.directory = os.path.join(os.path.dirname(self.root), *parts)

    def receipt(self):
        if self.directory is None:
            return None
        def retained(index, suffix):
            name = str(index) + suffix
            try:
                os.stat(name, dir_fd=self.recovery_fd, follow_symlinks=False)
                return os.path.join(self.directory, name)
            except FileNotFoundError:
                return None
        return {"requestId": self.request["requestId"], "path": self.directory,
                "files": [{"path": file["path"],
                           "preimage": retained(index, ".before"), "proposed": retained(index, ".after")}
                          for index, file in enumerate(self.request["files"])]}

    def save(self, phase):
        self.manifest["phase"] = phase
        name = "manifest-" + uuid.uuid4().hex
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.recovery_fd)
        with os.fdopen(fd, "w") as out:
            json.dump(self.manifest, out, separators=(",", ":"))
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, "manifest.json", src_dir_fd=self.recovery_fd, dst_dir_fd=self.recovery_fd)
        os.fsync(self.recovery_fd)

    def prepare(self):
        self.open_recovery()
        try:
            fd = os.open("manifest.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.recovery_fd)
        except FileNotFoundError:
            fd = None
        if fd is not None:
            with os.fdopen(fd) as source:
                self.manifest = json.load(source)
            if self.manifest.get("digest") != self.digest:
                fail("request_conflict", "file recovery already belongs to different request content", self.receipt())
            if self.manifest.get("phase") != "installed":
                fail("file_recovery_required", "file installation was interrupted; inspect retained files before replanning", self.receipt())
            self.verify()
            return False
        states = [self.current(file["path"]) for file in self.request["files"]]
        for file, before in zip(self.request["files"], states):
            if (before["digest"] if before else None) != file["beforeDigest"]:
                fail("file_conflict", "file preimage changed; read and replan")
        self.manifest = dict(version=1, digest=self.digest, states=states)
        # Journal intent before creating stage files. An interrupted preflight
        # cannot silently reuse somebody else's partially populated directory.
        self.save("preparing")
        for index, (file, before) in enumerate(zip(self.request["files"], states)):
            if file["content"] is None:
                continue
            fd = os.open(str(index) + ".after", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.recovery_fd)
            with os.fdopen(fd, "wb") as out:
                out.write(file["content"].encode())
                out.flush()
                os.fchmod(out.fileno(), (before["mode"] & 0o777) if before else 0o644)
                os.fsync(out.fileno())
        self.save("prepared")
        return True

    @staticmethod
    def move(source_fd, source, destination_fd, destination):
        # Both supported guests (Linux) and the native macOS harness provide a
        # no-replace rename. Never emulate it using check-then-overwrite rename.
        library = ctypes.CDLL(None, use_errno=True)
        if sys.platform == "darwin":
            command, flags = library.renameatx_np, 0x4  # RENAME_EXCL
        elif sys.platform.startswith("linux"):
            command, flags = library.renameat2, 1  # RENAME_NOREPLACE
        else:
            fail("file_recovery_required", "safe native file move is unavailable")
        command.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        command.restype = ctypes.c_int
        if command(source_fd, os.fsencode(source), destination_fd, os.fsencode(destination), flags) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))

    def install(self):
        self.save("applying")
        for index, (file, before) in enumerate(zip(self.request["files"], self.manifest["states"])):
            parent = self.parent(file["path"], create=True)
            name = file["path"].split("/")[-1]
            try:
                if self.state(parent, name) != before:
                    fail("file_conflict", "file changed before installation", self.receipt())
                if before is not None:
                    self.move(parent, name, self.recovery_fd, str(index) + ".before")
                    os.fsync(parent)
                    os.fsync(self.recovery_fd)
                    if self.state(self.recovery_fd, str(index) + ".before") != before:
                        fail("file_conflict", "a concurrent edit was retained instead of overwritten", self.receipt())
                # A renamed parent or symlink cannot redirect this installation.
                current_parent = self.parent(file["path"])
                try:
                    left, right = os.fstat(parent), os.fstat(current_parent)
                    if (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino):
                        fail("file_conflict", "file parent changed before installation", self.receipt())
                finally:
                    os.close(current_parent)
                if file["content"] is not None:
                    os.link(str(index) + ".after", name, src_dir_fd=self.recovery_fd, dst_dir_fd=parent, follow_symlinks=False)
                    os.fsync(parent)
            finally:
                os.close(parent)
        self.verify()
        self.save("installed")

    def verify(self):
        for index, (file, before) in enumerate(zip(self.request["files"], self.manifest["states"])):
            if before is not None and self.state(self.recovery_fd, str(index) + ".before") != before:
                fail("file_conflict", "an editor changed a retained preimage; inspect recovery files", self.receipt())
            after = self.current(file["path"])
            if file["content"] is None:
                matches = after is None
            else:
                stage = self.state(self.recovery_fd, str(index) + ".after")
                matches = after is not None and stage == after and after["digest"] == hashlib.sha256(file["content"].encode()).hexdigest()
            if not matches:
                fail("file_conflict", "installed files changed; inspect recovery files before replanning", self.receipt())


class Coding:
    def __init__(self, repo, request):
        self.repo, self.request = repo, request
        self.env = dict(os.environ, JJ_EDITOR="false", PAGER="cat")

    def jj(self, args, at=None, mutable=False, binary=False):
        command = ["jj", "-R", self.repo, "--no-pager", "--color=never"]
        if not mutable:
            command += ["--ignore-working-copy", "--at-op=" + (at or "@")]
        command += args
        result = subprocess.run(command, capture_output=True, text=not binary, env=self.env, timeout=90)
        if result.returncode:
            # Do not silently reconcile externally divergent operation heads.
            message = result.stderr.decode(errors="replace") if binary else result.stderr
            fail("jj_conflict", message.strip()[-2000:] or "JJ command failed")
        return result.stdout

    def operation(self):
        return json.loads(self.jj(["op", "log", "-n", "1", "--no-graph", "-T", "json(self)"]))

    def commits(self, revset, at, limit=None):
        args = ["log", "-r", revset, "--no-graph", "-T",
                'json(self) ++ "\\t" ++ conflict ++ "\\t" ++ empty ++ "\\n"']
        if limit is not None:
            args += ["-n", str(limit)]
        output = self.jj(args, at)
        rows = []
        for line in output.splitlines():
            raw, conflict, empty = line.split("\t")
            commit = json.loads(raw)
            commit["conflict"], commit["empty"] = conflict == "true", empty == "true"
            rows.append(commit)
        return rows

    def commit(self, revset, at):
        rows = self.commits(revset, at)
        if len(rows) != 1:
            fail("revision_conflict", "change must resolve to exactly one visible native revision")
        return rows[0]

    def revision(self, commit, at):
        # JJ's supported template API omits root_tree. Isolate its pinned debug
        # representation here, preserving native merge terms instead of hashing
        # the working directory or pretending a conflicted tree has one ID.
        raw = self.jj(["debug", "object", "commit", commit["commit_id"]], at)
        match = re.search(r"\n    root_tree: (.*?),\n    conflict_labels:", raw, re.S)
        if not match:
            fail("unsupported_jj", "JJ 0.39 commit object tree representation changed")
        tree = match.group(1)
        ids = re.findall(r'TreeId\(\s*"([0-9a-f]{40})"\s*,?\s*\)', tree)
        if not ids or len(ids) % 2 != 1 or not tree.startswith(("Resolved(", "Conflicted(")):
            fail("unsupported_jj", "unsupported native JJ tree terms")
        result = {"changeId": commit["change_id"], "commitId": commit["commit_id"],
                  "operationId": at, "parentCommitIds": commit["parents"],
                  "description": commit["description"], "empty": commit["empty"]}
        if commit["conflict"] or len(ids) > 1:
            result.update(kind="conflicted", treeTerms=[
                {"treeId": value, "positive": index % 2 == 0} for index, value in enumerate(ids)])
        else:
            result.update(kind="resolved", treeId=ids[0])
        return result

    def read(self, at=None):
        at = at or self.operation()["id"]
        selectors = self.request.get("changeIds") or []
        rows = [self.commit("change_id(" + json.dumps(value) + ")", at) for value in selectors]
        result = {"status": "read", "operationId": at,
                  "capabilities": ["apply-files/v1", "import-source/v1"] + self.creation_capabilities(),
                  "head": self.revision(self.commit("@", at), at),
                  "revisions": [self.revision(row, at) for row in rows]}
        if "historyLimit" in self.request:
            limit = self.request["historyLimit"]
            history = self.commits("ancestors(@, " + str(limit + 1) + ") ~ root()", at, limit=limit + 1)
            result["historyComplete"] = len(history) <= limit
            history = history[:limit]
            if any(len(row["parents"]) != 1 for row in history):
                fail("nonlinear_history", "memory history requires a linear selected ancestry")
            result["history"] = [self.revision(row, at) for row in reversed(history)]
        return result

    def check_expected(self, expected, at):
        commit = self.commit("change_id(" + json.dumps(expected["changeId"]) + ")", at)
        actual = self.revision(commit, at)
        if any(actual.get(field) != expected.get(field) for field in (
                "changeId", "commitId", "treeId", "operationId", "parentCommitIds")):
            fail("revision_conflict", "exact native revision or parents changed; read and replan")
        if actual["kind"] != "resolved":
            fail("revision_conflict", "conflicted revisions cannot pass fast acceptance")
        return commit

    def operation_configs(self, operation):
        # JJ 0.39's quoted arguments are not POSIX shell syntax. Match our
        # generated prefix and config arguments, never the commit-message prose.
        path = self.repo if re.fullmatch(r"[A-Za-z0-9,./:@_-]*", self.repo) else "'" + self.repo.replace("'", "\\'") + "'"
        prefix = "jj -R " + path + " --no-pager '--color=never' "
        args = operation.get("tags", {}).get("args", "")
        if not args.startswith(prefix):
            return []
        args = args[len(prefix):]
        configs = []
        while args.startswith("--config "):
            match = re.match(r"--config 'smithers\.(coding-request|coding-projection)=\"([^\"]*)\"' ", args)
            if not match:
                return []
            configs.append((match[1], match[2]))
            args = args[match.end():]
        return configs

    def receipt(self, key, digest):
        # Scan native metadata, including after subsequent unrelated operations.
        # Expected-op fencing makes missing/GC'd receipts fail closed on retry.
        output = self.jj(["op", "log", "--no-graph", "-T", 'json(self) ++ "\\n"'])
        found = []
        for line in output.splitlines():
            operation = json.loads(line)
            for name, value in self.operation_configs(operation):
                if name != "coding-request":
                    continue
                old_key, _, old_digest = value.partition(":")
                if old_key != key:
                    continue
                if old_digest != digest:
                    fail("request_conflict", "requestId was already used for a different request")
                # Normal CLI may first snapshot and then make its explicit
                # mutation. Such an external file race must not become a valid
                # acceptance receipt (except the explicit snapshot operation).
                if not operation.get("is_snapshot") or self.request["operation"] in ("snapshot", "apply_files"):
                    found.append(operation)
        if len(found) > 1:
            fail("operation_conflict", "multiple native operations carry this receipt; inspect operation history")
        return found[0] if found else None

    def result(self, operation, replayed):
        at = operation["id"]
        if operation["parents"] != [self.request["expectedOperationId"]]:
            fail("operation_conflict", "another operation intervened; native mutation is preserved for inspection")
        kind = self.request["operation"]
        selector = "@" if kind in ("create", "snapshot", "apply_files") else (
            "change_id(" + json.dumps(self.request["target"]["changeId"]) + ")")
        target = self.commit(selector, at)
        rows = self.affected(operation, target)
        revisions = [self.revision(row, at) for row in rows]
        return {"status": "accepted", "replayed": replayed, "operationId": at,
                "timestamp": operation["time"]["end"],
                "parentOperationId": operation["parents"][0],
                "head": self.revision(self.commit("@", at), at),
                "revision": self.revision(target, at), "revisions": revisions}

    def affected(self, operation, target):
        at = operation["id"]
        # Reordering can rewrite revisions left below the moved target too.
        # Reconstruct the affected set from the receipt's exact parent view,
        # then read those stable native change IDs in the receipt's result view.
        before = operation["parents"][0]
        roots = [self.request["target"]["commitId"]]
        for field in ("source", "after"):
            if self.request.get(field):
                roots.append(self.request[field]["commitId"])
        previous = self.commits(" | ".join(root + "::" for root in roots), before)
        old_ids = {row["change_id"]: row["commit_id"] for row in previous}
        selectors = ['change_id(' + json.dumps(value) + ')' for value in old_ids]
        selectors.append(target["commit_id"])
        rows = self.commits(" | ".join(selectors), at)
        return [row for row in rows if row["commit_id"] != old_ids.get(row["change_id"])
                or row["change_id"] == target["change_id"]]

    def projections(self, workspace_id, after="", limit=20):
        # Native operations are the replay source. This cursor is only a scan
        # position: restarting the reporter safely upserts the same DB rows.
        operations = [json.loads(line) for line in self.jj(
            ["op", "log", "--no-graph", "-T", 'json(self) ++ "\\n"']).splitlines()]
        operations.reverse()
        if after:
            offset = next((i for i, op in enumerate(operations) if op["id"] == after), -1)
            operations = operations[offset + 1:]
        records, cursor = [], after
        for operation in operations:
            cursor = operation["id"]
            try:
                markers = [value for name, value in self.operation_configs(operation)
                           if name == "coding-projection"]
                if len(markers) != 1:
                    continue
                metadata = json.loads(base64.b64decode(markers[0], validate=True))
                request = metadata["request"]
                if metadata["version"] != 1 or metadata["workspaceId"] != workspace_id:
                    continue
                if operation.get("is_snapshot") and request["operation"] not in ("snapshot", "apply_files"):
                    continue
                if operation["parents"] != [request["expectedOperationId"]]:
                    continue  # A native mutation with intervening work never passed acceptance.
                reader = Coding(self.repo, request)
                selector = "@" if request["operation"] in ("create", "snapshot", "apply_files") else (
                    "change_id(" + json.dumps(request["target"]["changeId"]) + ")")
                target = reader.commit(selector, operation["id"])
                records.append({"operation": request["operation"], "operationId": operation["id"],
                                "parentOperationId": operation["parents"][0],
                                "timestamp": operation["time"]["end"],
                                "changeIds": [row["change_id"] for row in reader.affected(operation, target)]})
            except (ValueError, KeyError, TypeError):
                continue  # Unrelated/unrecognized user config is not a coding receipt.
            if len(records) == limit:
                break
        return {"coding_operations": records, "cursor": cursor,
                "more": bool(operations and cursor != operations[-1]["id"])}

    def assert_linear(self, commit, at):
        rows = self.commits(commit["commit_id"] + "::", at)
        child_counts = {}
        for row in rows:
            if len(row["parents"]) != 1:
                fail("nonlinear_history", "coding mutation requires a linear descendant chain")
            for parent in row["parents"]:
                child_counts[parent] = child_counts.get(parent, 0) + 1
        if any(count > 1 for count in child_counts.values()):
            fail("nonlinear_history", "coding mutation would rewrite multiple branches")
        return rows

    def mutate(self):
        request = self.request
        if request["operation"] == "apply_files":
            validate_file_patch(request.get("files"))
        digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":"),
                                           ensure_ascii=True).encode()).hexdigest()
        receipt = self.receipt(request["requestId"], digest)
        if receipt:
            if request["operation"] == "apply_files":
                return self.apply_files(None, digest, receipt)
            return self.result(receipt, True)
        before = self.operation()["id"]
        if before != request["expectedOperationId"]:
            fail("operation_conflict", "operation head changed; read and replan")
        target = self.check_expected(request["target"], before)
        operation = request["operation"]
        self.assert_linear(target, before)
        args = ["--config", 'smithers.coding-request="' + request["requestId"] + ":" + digest + '"']
        if request.get("reportProvenance"):
            # A compact immutable projection recipe lives in this SAME native
            # operation. It contains no credential, prose, or second receipt DB.
            projection = {"version": 1, "workspaceId": request["workspaceId"], "request": {
                field: request[field] for field in ("operation", "expectedOperationId", "target", "source", "after")
                if field in request}}
            for field in ("target", "source", "after"):
                if field in projection["request"]:
                    projection["request"][field] = {key: request[field][key] for key in ("changeId", "commitId")}
            encoded = base64.b64encode(json.dumps(projection, separators=(",", ":")).encode()).decode()
            args += ["--config", 'smithers.coding-projection="' + encoded + '"']

        if operation == "apply_files":
            if target["commit_id"] != self.commit("@", before)["commit_id"]:
                fail("revision_conflict", "file patch target must be the working-copy revision")
            return self.apply_files(args, digest)
        elif operation == "snapshot":
            if target["commit_id"] != self.commit("@", before)["commit_id"]:
                fail("revision_conflict", "snapshot target must be the working-copy revision")
            args += ["status"]
        else:
            # Preserve and record dirty edits, then require the caller to bind
            # its plan to that new revision. This is not an accepted mutation.
            self.jj(["status"], mutable=True)
            if self.operation()["id"] != before:
                fail("dirty_workspace", "working files were snapshotted; read the new revision and replan")
            if operation == "create":
                args += ["new", "--insert-after", target["commit_id"], "-m", request["description"]]
            elif operation == "describe":
                if target["description"].rstrip("\n") == request["description"].rstrip("\n"):
                    return {"status": "unchanged", "operationId": before,
                            "revision": self.revision(target, before)}
                args += ["describe", target["commit_id"], "-m", request["description"]]
            elif operation == "edit":
                if self.commit("@", before)["commit_id"] == target["commit_id"]:
                    return {"status": "unchanged", "operationId": before,
                            "revision": self.revision(target, before)}
                args += ["edit", target["commit_id"]]
            elif operation in ("amend", "reorder"):
                other = self.check_expected(request["source" if operation == "amend" else "after"], before)
                self.assert_linear(other, before)
                if target["change_id"] == other["change_id"]:
                    fail("invalid_request", "target and source/destination must differ")
                # Both operands must already inhabit one line; this adapter
                # does not import unrelated branches or manufacture merges.
                related = self.commits("(" + target["commit_id"] + "::" + other["commit_id"] +
                                       ") | (" + other["commit_id"] + "::" + target["commit_id"] + ")", before)
                if not related:
                    fail("nonlinear_history", "operands must belong to the same linear history")
                if operation == "amend":
                    if other["empty"]:
                        fail("invalid_request", "amend source has no prepared changes")
                    args += ["squash", "--from", other["commit_id"], "--into", target["commit_id"],
                             "--keep-emptied", "--use-destination-message"]
                else:
                    if target["parents"] == [other["commit_id"]]:
                        return {"status": "unchanged", "operationId": before,
                                "revision": self.revision(target, before)}
                    args += ["rebase", "--revisions", target["commit_id"], "--insert-after", other["commit_id"]]
        self.jj(args, mutable=True)
        receipt = self.receipt(request["requestId"], digest)
        if receipt:
            # Refuse to report a clean current head if a concurrent external JJ
            # process left divergent operation heads. Never auto-merge them.
            self.operation()
            return self.result(receipt, False)
        if self.operation()["id"] == before:
            return {"status": "unchanged", "operationId": before,
                    "revision": self.revision(target, before)}
        fail("operation_conflict", "native operation finished without a recoverable receipt")

    def verify_file_snapshot(self, operation, recovery):
        at = operation["id"]
        target = self.commit("@", at)
        if target["change_id"] != self.request["target"]["changeId"] or target["parents"] != self.request["target"]["parentCommitIds"]:
            fail("file_conflict", "file snapshot changed native owners", recovery)
        output = self.jj(["diff", "--from", self.request["target"]["commitId"], "--to", target["commit_id"],
                          "-T", 'json(path) ++ "\\t" ++ json(status) ++ "\\t" ++ json(source.path()) ++ "\\n"'], at)
        changed = set()
        for line in output.splitlines():
            path, status, source = [json.loads(value) for value in line.split("\t")]
            changed.add(path)
            if status == "renamed":
                changed.add(source)
        if changed != {file["path"] for file in self.request["files"]}:
            fail("file_conflict", "snapshot includes other edits or omitted proposed files", recovery)
        for file in self.request["files"]:
            if file["content"] is not None:
                data = self.jj(["file", "show", "-r", target["commit_id"], "--", "root:" + json.dumps(file["path"])], at, binary=True)
                if data != file["content"].encode():
                    fail("file_conflict", "snapshot bytes differ from the checked proposal", recovery)

    def apply_files(self, args, digest, receipt=None):
        patch = FilePatch(self.repo, self.request, digest)
        try:
            fresh = patch.prepare()
            if receipt is not None:
                if fresh:
                    fail("file_recovery_required", "native receipt is missing its retained preimages", patch.receipt())
            else:
                # JJ owns pending working edits. Capture them before the first
                # filesystem mutation and make the caller replan on that source.
                if fresh:
                    self.jj(["status"], mutable=True)
                    if self.operation()["id"] != self.request["expectedOperationId"]:
                        fail("dirty_workspace", "working files were snapshotted; read and replan", patch.receipt())
                    patch.install()
                if self.operation()["id"] != self.request["expectedOperationId"]:
                    fail("operation_conflict", "native owner changed before file snapshot", patch.receipt())
                patch.verify()
                self.jj(args + ["status"], mutable=True)
                receipt = self.receipt(self.request["requestId"], digest)
                if receipt is None:
                    fail("file_recovery_required", "files are retained but JJ did not produce an exact snapshot receipt", patch.receipt())
            self.operation()  # Never merge divergent external operation heads.
            patch.verify()
            self.verify_file_snapshot(receipt, patch.receipt())
            result = self.result(receipt, args is None)
            result["recovery"] = patch.receipt()
            return result
        except CodingError as error:
            if error.recovery is None:
                error.recovery = patch.receipt()
            raise
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
            fail("file_recovery_required", "file installation did not finish; inspect retained files before replanning", patch.receipt())
        finally:
            patch.close()

    def engine(self):
        # Engine snapshots are immutable commit references, not new planned
        # changes. The existing journal owns labels and recovery sequencing.
        before = self.operation()["id"]
        operation = self.request["operation"]
        if operation == "eligible":
            # Configuration resolution belongs to the same installed JJ CLI;
            # all path/ignore/fileset matching belongs to the native jj-lib helper.
            request = {"commitId": self.commit("@", before)["commit_id"],
                       "path": self.request["path"], "byteLength": self.request["byteLength"],
                       "autoTrack": self.jj(["config", "get", "snapshot.auto-track"], before).strip(),
                       "maxNewFileSize": self.jj(["config", "get", "snapshot.max-new-file-size"], before).strip(),
                       "filesetAliases": self.jj(["config", "list", "fileset-aliases", "--include-defaults"], before)}
            result = subprocess.run([JJ_HELPER, "--eligible", self.repo], input=json.dumps(request),
                                    text=True, capture_output=True, env=self.env, timeout=90)
            if result.returncode:
                fail("eligibility_unavailable", result.stderr.strip()[-1000:] or "native eligibility is unavailable")
            result = json.loads(result.stdout)
            if isinstance(result, dict) and ((result.keys() == {"eligible"} and result["eligible"] is True) or (
                    result.keys() == {"eligible", "reason"} and result["eligible"] is False
                    and isinstance(result["reason"], str) and len(result["reason"]) <= 100)):
                return result
            fail("eligibility_unavailable", "unsupported native eligibility response")
        if operation == "diff":
            source = self.commit('commit_id("' + self.request["from"] + '")', before)
            target = self.commit('commit_id("' + self.request["to"] + '")', before)
            return {"diff": self.jj(["diff", "--git", "--from", 'commit_id("' + source["commit_id"] + '")',
                                     "--to", 'commit_id("' + target["commit_id"] + '")'], before)}

        current = self.commit("@", before)
        source = (self.commit('commit_id("' + self.request["changeId"] + '")', before)
                  if operation == "restore" else current)

        def require_owner(actual):
            if any(actual[field] != source[field] for field in ("change_id", "parents")):
                fail("revision_conflict", "engine snapshot belongs to another change or parent revision; replan before restoring")

        require_owner(current)
        # Save pending bytes through JJ before a restore, and make an unchanged
        # snapshot a native no-op. Never run new/edit/describe for engine calls.
        status = self.jj(["status"], mutable=True)
        # JJ 0.39 can exit successfully while declining nonignored new files
        # (size limit or snapshot.auto-track). Such a tree is no preimage for a
        # compensable write. Preserve the files and refuse false acceptance.
        if re.search(r"(?m)^Untracked paths:$", status):
            fail("snapshot_incomplete", "JJ left untracked paths; adjust native tracking before compensable writes")
        at = self.operation()["id"]
        current = self.commit("@", at)
        require_owner(current)
        if operation == "snapshot":
            return {"changeId": current["commit_id"]}

        # Pin both operands. An uncooperative external command must not redirect
        # a mutable @ selector to a different planned atom after the owner check.
        self.jj(["restore", "--from", 'commit_id("' + source["commit_id"] + '")',
                 "--into", 'commit_id("' + current["commit_id"] + '")'], mutable=True)
        at = self.operation()["id"]
        restored = self.commit("@", at)
        require_owner(restored)
        actual = self.revision(restored, at)
        expected = self.revision(source, at)
        if restored["description"] != current["description"] or any(
                actual.get(field) != expected.get(field) for field in ("kind", "treeId", "treeTerms")):
            fail("revision_conflict", "engine restore did not preserve the owned description and exact snapshot tree")
        return {"changeId": restored["commit_id"]}

    def source_git(self, args, env=None, allow_missing=False):
        """Bounded quiet transport; neither credentials nor remote errors escape."""
        previous, process = {}, None
        def interrupted(signum, frame):
            raise InterruptedError()
        try:
            for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
                previous[signum] = signal.signal(signum, interrupted)
            process = subprocess.Popen(["git", *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       env=env or self.source_git_env(), text=True, start_new_session=True)
            stdout, _ = process.communicate(timeout=max(0.001, self.import_deadline - time.monotonic()))
            if len(stdout.encode()) > 4 << 20:
                fail("source_import_unavailable", "Source import exceeded its response budget")
            if process.returncode and not allow_missing:
                fail("source_import_unavailable", "Source import could not complete; retry")
            return stdout if process.returncode == 0 else None
        except (subprocess.TimeoutExpired, InterruptedError, OSError):
            if process is not None:
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait()
            fail("source_import_unavailable", "Source import was interrupted; retry the same source")
        finally:
            for signum, handler in previous.items(): signal.signal(signum, handler)

    def source_git_env(self, transport=False, objects=None):
        # A fresh scratch Git directory handles the network. Repository Git
        # config, URL rewrites, hooks, askpass and tracing cannot influence it.
        env = {"PATH": os.environ.get("PATH", ""), "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "false",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        settings = [("core.hooksPath", "/dev/null"), ("credential.helper", ""),
                    ("protocol.allow", "never"), ("http.followRedirects", "false"),
                    ("http.lowSpeedLimit", "1"), ("http.lowSpeedTime", "30"),
                    ("pack.threads", "1"), ("fetch.fsckObjects", "true")]
        if transport:
            settings += [("protocol.https.allow", "always"), ("protocol.http.allow", "always"),
                         ("credential.helper", "cache --socket " + self.request["credentialSocket"]),
                         ("credential.useHttpPath", "true")]
            settings += managed_source_transport()
        if objects: env["GIT_OBJECT_DIRECTORY"] = objects
        env["GIT_CONFIG_COUNT"] = str(len(settings))
        for i, (key, value) in enumerate(settings):
            env["GIT_CONFIG_KEY_" + str(i)], env["GIT_CONFIG_VALUE_" + str(i)] = key, value
        return env

    def source_refs(self, git_dir):
        output = self.source_git(["--git-dir", git_dir, "for-each-ref", "--format=%(refname) %(objectname)",
                                  "refs/heads/", "refs/tags/", "refs/remotes/"])
        return dict(line.split(" ", 1) for line in output.splitlines())

    def source_import_preflight(self, git_dir, at, seeds):
        # A generic jj git import would also admit an editor's pending Git
        # changes. Refuse those BEFORE mutation, rather than moving a bookmark
        # or abandoning its working-copy commit as an import side effect.
        view = self.jj(["debug", "object", "view", "--op", at], at)
        section = re.search(r"\n    git_refs: (.*?),\n    git_head:", view, re.S)
        if not section:
            fail("unsupported_jj", "JJ source import view representation changed")
        entries = re.findall(r'GitRefNameBuf\(\s*("(?:[^"\\]|\\.)*")\s*,?\s*\): RefTarget \{(.*?)\n        \},', section.group(1), re.S)
        if section.group(1).count("GitRefNameBuf(") != len(entries):
            fail("source_changed", "Native Git references must be reconciled before importing source")
        tracked = {}
        for name, target in entries:
            commits = re.findall(r'CommitId\(\s*"([0-9a-f]{40})"', target)
            if "Resolved(" not in target or len(commits) > 1:
                fail("source_changed", "Native Git references must be reconciled before importing source")
            if commits: tracked[json.loads(name)] = commits[0]
        actual = self.source_refs(git_dir)
        for name in list(actual):
            if name in seeds or name.endswith("/HEAD"): actual.pop(name)
        tracked = {name: sha for name, sha in tracked.items() if name not in seeds}
        # Annotated tags point to a tag object in Git, but to its peeled commit
        # in JJ. Read the exact commit before comparing the import baseline.
        for name in actual:
            if name.startswith("refs/tags/"):
                peeled = self.source_git(["--git-dir", git_dir, "rev-parse", "--verify", name + "^{commit}"], allow_missing=True)
                if peeled is not None: actual[name] = peeled.strip()
        git_head = self.source_git(["--git-dir", git_dir, "rev-parse", "--verify", "HEAD^{commit}"], allow_missing=True)
        head_section = re.search(r"\n    git_head: (.*?),\n    wc_commit_ids:", view, re.S)
        expected_head = re.findall(r'CommitId\(\s*"([0-9a-f]{40})"', head_section.group(1)) if head_section else []
        if actual != tracked or (git_head.strip() if git_head else None) != (expected_head[0] if len(expected_head) == 1 else None):
            fail("source_changed", "Pending Git changes must be imported before capturing another source")

    def import_source(self):
        self.import_deadline = time.monotonic() + 180
        before = self.operation()["id"]
        original = self.revision(self.commit("@", before), before)
        git_dir = os.path.realpath(self.jj(["git", "root"], before).strip())
        commits = self.request["commits"]
        seeds = {"refs/tags/smithers-source-import/" + self.request["workspaceId"] + "/" + self.request["requestId"] + "/" + c["commitId"]: c["commitId"] for c in commits}
        user_refs = {name: sha for name, sha in self.source_refs(git_dir).items() if name not in seeds}
        bookmarks = self.jj(["bookmark", "list", "--all-remotes", "-T", 'json(self) ++ "\\n"'], before)
        self.source_import_preflight(git_dir, before, seeds)
        # Fetch through an isolated config, writing immutable object files to
        # the native store; no local repository credential or URL setting is
        # used for this transfer. FETCH_HEAD and ordinary refs stay untouched.
        with tempfile.TemporaryDirectory(prefix="smithers-source-import-") as scratch:
            self.source_git(["init", "--bare", "--template=", scratch])
            env = self.source_git_env(transport=True, objects=os.path.join(git_dir, "objects"))
            advertised = self.source_git(["--git-dir", scratch, "ls-remote", "--refs", self.request["gitUrl"], *[c["ref"] for c in commits]], env)
            retained = dict((row.split()[1], row.split()[0]) for row in advertised.splitlines() if len(row.split()) == 2)
            for c in commits:
                if c["ref"] not in retained: fail("source_missing", "The retained source reference is missing")
                if retained[c["ref"]] != c["commitId"]: fail("source_changed", "The retained source reference changed")
            args = ["--git-dir", scratch, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", self.request["gitUrl"]]
            for c in commits: args.append(c["ref"] + ":refs/smithers-import/" + c["commitId"])
            self.source_git(args, env)
            for c in commits:
                sha = self.source_git(["--git-dir", scratch, "rev-parse", "--verify", "refs/smithers-import/" + c["commitId"] + "^{commit}"], env).strip()
                if sha != c["commitId"]:
                    fail("source_changed", "Retained source reference no longer matches its immutable commit")
        if self.operation()["id"] != before:
            fail("source_changed", "Native repository changed during source fetch; retry")
        self.source_import_preflight(git_dir, before, seeds)
        for c in commits:
            existing = self.source_git(["--git-dir", git_dir, "show-ref", "--hash", "--verify", c["ref"]], allow_missing=True)
            if existing is None:
                self.source_git(["--git-dir", git_dir, "update-ref", c["ref"], c["commitId"], "0" * 40])
            elif existing.strip() != c["commitId"]:
                fail("source_changed", "A retained source reference already names another commit")
        for seed, sha in seeds.items():
            existing = self.source_git(["--git-dir", git_dir, "show-ref", "--hash", "--verify", seed], allow_missing=True)
            if existing is not None and existing.strip() != sha:
                fail("source_changed", "Source import recovery reference changed")
            indexed = self.commits('commit_id("' + sha + '")', before)
            if not indexed and existing is None:
                self.source_git(["--git-dir", git_dir, "update-ref", seed, sha, "0" * 40])
        # The private temporary tags index new ancestry. Removing only their
        # exact preimages is retryable after a crash and cannot prune user refs.
        self.jj(["--config", "git.abandon-unreachable-commits=false", "git", "import"])
        for seed, sha in seeds.items():
            existing = self.source_git(["--git-dir", git_dir, "show-ref", "--hash", "--verify", seed], allow_missing=True)
            if existing is not None:
                if existing.strip() != sha: fail("source_changed", "Source import recovery reference changed")
                self.source_git(["--git-dir", git_dir, "update-ref", "-d", seed, sha])
        self.jj(["--config", "git.abandon-unreachable-commits=false", "git", "import"])
        at = self.operation()["id"]
        head = self.revision(self.commit("@", at), at)
        if any(head.get(key) != original.get(key) for key in ("kind", "commitId", "changeId", "treeId", "treeTerms", "parentCommitIds")) or self.source_refs(git_dir) != user_refs or self.jj(["bookmark", "list", "--all-remotes", "-T", 'json(self) ++ "\\n"'], at) != bookmarks:
            fail("source_changed", "Native repository changed during source import; inspect before retrying")
        revisions = [self.revision(self.commit('commit_id("' + c["commitId"] + '")', at), at) for c in commits]
        if any(r["commitId"] != c["commitId"] or r["kind"] != "resolved" for r, c in zip(revisions, commits)):
            fail("source_changed", "Imported source identity could not be verified")
        return {"status": "imported", "requestId": self.request["requestId"], "workspaceId": self.request["workspaceId"],
                "repositoryId": self.request["repositoryId"], "operationId": at, "head": head, "revisions": revisions}

    def creation_capabilities(self):
        # The Python adapter alone cannot advertise a newly compiled primitive.
        try:
            result = subprocess.run([JJ_HELPER, "--capabilities"], capture_output=True, text=True, timeout=5)
            value = json.loads(result.stdout) if result.returncode == 0 and len(result.stdout) < 4096 else {}
            capabilities = value.get("capabilities", []) if isinstance(value, dict) else []
            return ["create-source/v1"] if isinstance(capabilities, list) and all(c in capabilities for c in ("create-source/v1", "publish-created-source/v1")) else []
        except (OSError, subprocess.SubprocessError, ValueError, TypeError):
            return []

    def source_helper(self, mode, payload, failure_code):
        # The shared lock remains held through the bounded transport. Killing
        # the process group also stops a stalled native transport child.
        env = {key: value for key, value in self.env.items() if not key.startswith(("GIT_TRACE", "GIT_CURL_VERBOSE"))}
        process = subprocess.Popen([JJ_HELPER, mode, self.repo], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                   env=env, start_new_session=True)
        previous = {}
        def interrupted(signum, frame):
            raise KeyboardInterrupt()
        # The owning Effect spawner sends SIGTERM on cancellation. Forward it
        # to the helper's group before releasing the shared workspace lock.
        import threading
        if threading.current_thread() is threading.main_thread():
            for signum in (signal.SIGTERM, signal.SIGINT):
                previous[signum] = signal.signal(signum, interrupted)
        try:
            stdout, _ = process.communicate(json.dumps(payload), timeout=180)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            fail(failure_code, "Native source operation timed out or was interrupted; retry the identical request")
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)
        if len(stdout.encode()) > 64 << 10:
            fail(failure_code, "Invalid native source response size")
        try:
            result = json.loads(stdout)
            if "error" in result:
                error = result["error"]
                # Only the installed helper's bounded error categories escape.
                if error.get("code") in ("revision_conflict", "source_publication_invalid_ack", "source_publication_unavailable", "invalid_request", "operation_conflict", "request_conflict", "file_conflict", "source_missing", "source_creation_unavailable", "source_creation_invalid_receipt"):
                    fail(error["code"], "Native source operation refused; retain the draft and inspect before retrying")
                fail(failure_code, "Native source operation could not be verified")
            if process.returncode:
                fail(failure_code, "Native source operation returned no accepted receipt")
            return result
        except (ValueError, KeyError, TypeError):
            fail(failure_code, "Native source operation returned no valid receipt")

    def create_source(self):
        request, base = self.request, self.request["base"]
        payload = {"request_id": request["requestId"], "expected_operation_id": request["expectedOperationId"],
                   "base": {"change_id": base["changeId"], "commit_id": base["commitId"], "tree_id": base["treeId"], "parent_commit_ids": base["parentCommitIds"]},
                   "description": request["description"], "files": [{"path": f["path"], "before_digest": f["beforeDigest"], "content": f["content"]} for f in request["files"]]}
        result = self.source_helper("--create-source", payload, "source_creation_unavailable")
        try:
            source = result["source"]
            if result["status"] != "created" or result["requestId"] != request["requestId"] or result["workspaceId"] != request["workspaceId"] or result["repositoryId"] != request["repositoryId"] or result["parentOperationId"] != request["expectedOperationId"] or result["base"] != payload["base"] or not re.fullmatch(r"[0-9a-f]{64}", result["requestDigest"]) or source["kind"] != "resolved" or source["operationId"] != result["operationId"] or source["parentCommitIds"] != [base["commitId"]] or type(result["publicationReady"]) is not bool:
                fail("source_creation_invalid_receipt", "Native source creation did not match the exact owner and base")
            return {**result, "base": {key: base[key] for key in ("changeId", "commitId", "treeId", "parentCommitIds")}}
        except (ValueError, KeyError, TypeError):
            fail("source_creation_invalid_receipt", "Native source creation returned no valid owned receipt")

    def publish_source(self):
        source = self.request["source"]
        payload = {"source": {"change_id": source["changeId"], "commit_id": source["commitId"],
                              "tree_id": source["treeId"], "parent_commit_ids": source["parentCommitIds"]},
                   "expected_operation_id": source["operationId"]}
        if "creation" in self.request:
            payload["creation"] = self.request["creation"]
        result = self.source_helper("--publish-source", payload, "source_publication_unavailable")
        try:
            native = result["source"]
            expected_ref = "refs/smithers/workspaces/" + self.request["workspaceId"] + "/sources/" + source["commitId"]
            if result["status"] != "retained" or result["workspace_id"] != self.request["workspaceId"] or result["repository_id"] != self.request["repositoryId"] or result["ref"] != expected_ref or native != payload["source"]:
                fail("source_publication_invalid_ack", "Cloud acknowledgement did not match the exact workspace and source")
            return {"status": "retained", "requestId": self.request["requestId"],
                    "workspaceId": result["workspace_id"], "repositoryId": result["repository_id"], "ref": result["ref"],
                    "source": {key: source[key] for key in ("changeId", "commitId", "treeId", "parentCommitIds")}}
        except (ValueError, KeyError, TypeError):
            fail("source_publication_unavailable", "Original source publication returned no valid acknowledgement")

    def run(self, engine=False):
        version = subprocess.check_output(["jj", "--version"], text=True).strip()
        if not re.fullmatch(r"jj 0\.39\.0(?:[-+].*)?", version):
            fail("unsupported_jj", "coding adapter requires the VM-pinned JJ 0.39.0")
        if self.request.get("requireReporterLock") and self.request["operation"] != "read":
            try:
                with open(REPORTER_SCRIPT) as reporter:
                    compatible = 'exec 9>"$op_repo/smithers-coding.lock"' in reporter.read()
            except OSError:
                compatible = False
            if not compatible:
                fail("reporter_upgrade_required", "workspace head reporter must be reinstalled through the normal start/resume path before coding mutations")
        # .jj/repo can be a pointer for linked JJ workspaces. The owned cloud
        # clone is isolated, but resolving the pointer also serializes linked
        # adapters sharing one native operation graph.
        repo_dir = os.path.join(self.repo, ".jj", "repo")
        if os.path.isfile(repo_dir):
            with open(repo_dir) as pointer:
                repo_dir = os.path.realpath(os.path.join(self.repo, ".jj", pointer.read().strip()))
        with open(os.path.join(repo_dir, "smithers-coding.lock"), "a") as lock:
            deadline = time.monotonic() + 15
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() > deadline:
                        fail("workspace_busy", "another native coding operation is running; retry")
                    time.sleep(0.05)
            if engine:
                return self.engine()
            if self.request["operation"] == "create_source":
                return self.create_source()
            if self.request["operation"] == "publish_source":
                return self.publish_source()
            if self.request["operation"] == "import_source":
                return self.import_source()
            return self.read() if self.request["operation"] == "read" else self.mutate()


def local_request(raw, config, engine=False):
    """Bind an authorized guest invocation to provisioning identity, never input credentials."""
    request = json.loads(raw)
    if config.get("version") != 1 or not isinstance(request, dict):
        fail("invalid_request", "unsupported coding configuration or request")
    if request.pop("repositoryPath", None) != config["repositoryPath"]:
        fail("invalid_request", "coding request does not own the provisioned repository path")
    if engine:
        operation = request.get("operation")
        if operation == "eligible":
            if request.keys() != {"operation", "path", "byteLength"} or not isinstance(request.get("path"), str) or (
                    not request["path"] or len(request["path"].encode()) > 4096 or "\0" in request["path"]) or (
                    type(request.get("byteLength")) is not int or not 0 <= request["byteLength"] <= (1 << 53) - 1):
                fail("invalid_request", "eligibility requires a repository-relative path and exact nonnegative byte length")
            request["requireReporterLock"] = True
            return request
        elif operation == "snapshot":
            ids = set()
        elif operation == "restore":
            ids = {"changeId"}
        elif operation == "diff":
            ids = {"from", "to"}
        else:
            fail("invalid_request", "unsupported engine snapshot operation")
        if request.keys() != {"operation"} | ids or any(
                not isinstance(request[field], str) or not re.fullmatch(r"[0-9a-f]{40}", request[field])
                for field in ids):
            fail("invalid_request", "engine snapshots require full lowercase immutable commit IDs and exact operation fields")
        request["requireReporterLock"] = True
        return request
    allowed = {"operation", "changeIds", "historyLimit", "requestId", "expectedOperationId", "target", "source", "after", "description", "files", "commits", "base", "creation"}
    if request.keys() - allowed:
        fail("invalid_request", "coding identity and internal options are supplied by provisioning")
    if request.get("operation") == "import_source":
        if request.keys() != {"operation", "requestId", "commits"}:
            fail("invalid_request", "source import requires only its commits and request identity")
        key, workspace = uuid.UUID(request["requestId"]), uuid.UUID(config["workspaceId"])
        commits = request["commits"]
        if str(key) != request["requestId"] or not key.int or str(workspace) != config["workspaceId"] or not workspace.int or not isinstance(commits, list) or not 1 <= len(commits) <= 2:
            fail("invalid_request", "invalid source import identity")
        seen = set()
        for c in commits:
            if not isinstance(c, dict) or c.keys() != {"commitId", "ref"} or not isinstance(c["commitId"], str) or not re.fullmatch(r"[0-9a-f]{40}", c["commitId"]) or c["commitId"] == "0" * 40 or c["commitId"] in seen or c["ref"] != "refs/smithers/workspaces/" + str(workspace) + "/sources/" + c["commitId"]:
                fail("invalid_request", "source import requires exact distinct workspace source references")
            seen.add(c["commitId"])
        api, slug, git_url, socket = [config.get(k, "") for k in ("apiBaseUrl", "repositorySlug", "gitUrl", "credentialSocket")]
        if type(config.get("repositoryId")) is not int or config["repositoryId"] <= 0 or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", slug) or not re.fullmatch(r"/[A-Za-z0-9/_.-]{1,1023}", socket) or not (api.startswith("https://") or api.startswith("http://127.0.0.1:") or api.startswith("http://localhost:")) or not api.endswith("/api") or re.search(r'[\s"\\?#@]', api) or git_url != api[:-4] + "/" + slug + ".git":
            fail("source_import_unavailable", "Source import requires the current cloud workspace provisioning")
        request.update(workspaceId=config["workspaceId"], repositoryId=config["repositoryId"], gitUrl=git_url,
                       credentialSocket=socket, requireReporterLock=True)
        return request
    if request.get("operation") == "create_source":
        if request.keys() != {"operation", "requestId", "expectedOperationId", "base", "description", "files"}:
            fail("invalid_request", "source creation requires an exact base and bounded files")
        key = uuid.UUID(request["requestId"])
        base = request["base"]
        if str(key) != request["requestId"] or not key.int or not isinstance(base, dict) or base.keys() - {"kind", "changeId", "commitId", "treeId", "operationId", "parentCommitIds", "description", "empty"} or base.get("kind") != "resolved" or not re.fullmatch(r"[k-z]{32}", base.get("changeId", "")) or not re.fullmatch(r"[0-9a-f]{128}", request["expectedOperationId"]) or base.get("operationId") != request["expectedOperationId"] or any(not re.fullmatch(r"[0-9a-f]{40}", base.get(k, "")) for k in ("commitId", "treeId")) or not isinstance(base.get("parentCommitIds"), list) or len(base["parentCommitIds"]) > 16 or any(not isinstance(p, str) or not re.fullmatch(r"[0-9a-f]{40}", p) for p in base["parentCommitIds"]):
            fail("invalid_request", "source creation requires exact native identities")
        if not isinstance(request["description"], str) or not request["description"].strip() or len(request["description"].encode()) > 16384 or "\0" in request["description"]:
            fail("invalid_request", "source creation requires a bounded description")
        validate_file_patch(request["files"])
        if any(".smithers" in f["path"].split("/") for f in request["files"]):
            fail("invalid_request", "source creation cannot alter saved repository configuration")
        if type(config.get("repositoryId")) is not int or config["repositoryId"] <= 0 or type(config.get("actorId")) is not int or config["actorId"] <= 0:
            fail("invalid_request", "source creation requires the provisioned owner")
        request.update(workspaceId=config["workspaceId"], repositoryId=config["repositoryId"], requireReporterLock=True)
        return request
    if request.get("operation") == "publish_source":
        if request.keys() - {"operation", "requestId", "source", "creation"} or not {"operation", "requestId", "source"}.issubset(request):
            fail("invalid_request", "source publication requires its exact native source and request identity")
        if "creation" in request:
            proof = request["creation"]
            if not isinstance(proof, dict) or proof.keys() != {"requestId", "requestDigest"} or str(uuid.UUID(proof["requestId"])) != proof["requestId"] or not uuid.UUID(proof["requestId"]).int or not re.fullmatch(r"[0-9a-f]{64}", proof["requestDigest"]):
                fail("invalid_request", "created-source publication requires an exact native creation proof")
        key = uuid.UUID(request["requestId"])
        source = request["source"]
        if str(key) != request["requestId"] or key.int == 0 or not isinstance(source, dict) or source.keys() - {
                "kind", "changeId", "commitId", "treeId", "operationId", "parentCommitIds", "description", "empty"}:
            fail("invalid_request", "invalid source publication identity")
        if source.get("kind") != "resolved" or not re.fullmatch(r"[k-z]{32}", source.get("changeId", "")) or not re.fullmatch(r"[0-9a-f]{128}", source.get("operationId", "")) or any(
                not re.fullmatch(r"[0-9a-f]{40}", source.get(field, "")) for field in ("commitId", "treeId")) or (
                not isinstance(source.get("parentCommitIds"), list) or len(source["parentCommitIds"]) > 16 or any(not isinstance(parent, str) or not re.fullmatch(r"[0-9a-f]{40}", parent) for parent in source["parentCommitIds"])):
            fail("invalid_request", "source publication requires exact resolved native identities")
        if not config.get("repositoryId") or not config.get("apiBaseUrl") or not config.get("gitUrl") or not config.get("credentialSocket"):
            fail("source_publication_unavailable", "Source publication requires the current cloud workspace provisioning")
        request.update(workspaceId=config["workspaceId"], repositoryId=config["repositoryId"], requireReporterLock=True)
        return request
    if request.get("operation") == "read":
        ids = request.get("changeIds", [])
        if request.keys() - {"operation", "changeIds", "historyLimit"} or not isinstance(ids, list) or len(ids) > 100 or any(
                not isinstance(value, str) or not re.fullmatch(r"[k-z]{32}", value) for value in ids):
            fail("invalid_request", "read requires at most 100 full native change IDs")
        if "historyLimit" in request and (type(request["historyLimit"]) is not int or not 1 <= request["historyLimit"] <= 1024):
            fail("invalid_request", "historyLimit must be an integer from 1 to 1024")
    else:
        op = request.get("operation")
        required = {"operation", "requestId", "expectedOperationId", "target"}
        if op in ("create", "describe"):
            required.add("description")
        elif op == "amend":
            required.add("source")
        elif op == "reorder":
            required.add("after")
        elif op == "apply_files":
            required.add("files")
            validate_file_patch(request.get("files"))
        elif op not in ("edit", "snapshot"):
            fail("invalid_request", "unsupported coding operation")
        if request.keys() != required:
            fail("invalid_request", "operation fields do not match its native command")
        key = uuid.UUID(request["requestId"])
        if str(key) != request["requestId"] or key.int == 0 or not re.fullmatch(r"[0-9a-f]{128}", request["expectedOperationId"]):
            fail("invalid_request", "exact operation ID and canonical request UUID are required")
        for field in ("target", "source", "after"):
            if field not in request:
                continue
            revision = request[field]
            if not isinstance(revision, dict) or revision.keys() - {
                    "kind", "changeId", "commitId", "treeId", "operationId", "parentCommitIds", "description", "empty"}:
                fail("invalid_request", "unsupported expected revision fields")
            if revision.get("kind", "resolved") != "resolved" or revision.get("operationId") != request["expectedOperationId"] or (
                    not re.fullmatch(r"[k-z]{32}", revision.get("changeId", ""))) or any(
                    not re.fullmatch(r"[0-9a-f]{40}", revision.get(key, "")) for key in ("commitId", "treeId")) or (
                    len(revision.get("parentCommitIds", [])) != 1 or not re.fullmatch(r"[0-9a-f]{40}", revision["parentCommitIds"][0])):
                fail("invalid_request", "expected revision must contain exact resolved native IDs and one parent")
        description = request.get("description", "")
        if not isinstance(description, str) or len(description.encode()) > 16 << 10 or "\0" in description:
            fail("invalid_request", "description is not a bounded native commit message")
        request.update(actorId=config["actorId"], workspaceId=config["workspaceId"], reportProvenance=True)
    request["requireReporterLock"] = True
    return request


def run_local(config_path="/etc/smithers/workspace-coding.json", engine=False):
    import pwd
    with open(config_path) as config_file:
        config = json.load(config_file)
    # JSON can escape each character into six bytes; decoded file edits retain
    # their independent 256 KiB bound in validate_file_patch.
    raw = sys.stdin.buffer.read((2 << 20) + 1)
    if len(raw) > 2 << 20:
        fail("invalid_request", "coding request exceeds 2 MiB")
    try:
        request = local_request(raw, config, engine=engine)
    except (ValueError, KeyError, TypeError):
        fail("invalid_request", "invalid native coding request fields")
    user = pwd.getpwnam(config["username"])
    if os.geteuid() == 0:
        os.initgroups(user.pw_name, user.pw_gid)
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
    elif os.geteuid() != user.pw_uid:
        fail("invalid_request", "coding must execute as the provisioned workspace user")
    os.environ.pop("JJ_CONFIG", None)
    os.environ.update(HOME=user.pw_dir, XDG_CONFIG_HOME=os.path.join(user.pw_dir, ".config"),
                      USER=user.pw_name, LOGNAME=user.pw_name)
    return Coding(config["repositoryPath"], request).run(engine=engine)


if __name__ == "__main__":
    try:
        if sys.argv[1] == "--local":
            result = run_local()
        elif sys.argv[1] == "--engine":
            result = run_local(engine=True)
        elif sys.argv[1] == "--projections":
            result = Coding(sys.argv[2], {}).projections(sys.argv[3], sys.argv[4])
        else:
            request = json.loads(base64.b64decode(sys.argv[2], validate=True))
            result = Coding(sys.argv[1], request).run()
        print(json.dumps(result, separators=(",", ":")))
    except CodingError as error:
        detail = {"code": error.code, "message": error.message}
        if error.recovery is not None:
            detail["recovery"] = error.recovery
        print(json.dumps({"error": detail}))
        sys.exit(1)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error": {"code": "guest_failure", "message": str(error)[-1000:]}}))
        sys.exit(1)

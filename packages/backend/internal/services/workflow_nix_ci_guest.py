#!/usr/bin/env python3
"""smithers-ci: workflow cache and artifact client for one NixOS CI job.

The sandbox scheduler installs this file in every CI guest (see
workflow_nix_ci.go) together with a per-job credential:

  SMITHERS_CI_API_URL     the control plane's /internal base URL
  SMITHERS_CI_JOB_TOKEN   the job's bearer token (valid only while it runs)
  SMITHERS_WORKFLOW_RUN_ID

  smithers-ci cache restore DESCRIPTORS STATE
  smithers-ci cache save DESCRIPTORS STATE
  smithers-ci artifact upload NAME PATH [--content-type TYPE]
  smithers-ci artifact download NAME PATH

Cache behaviour, archive format and restore limits match the retired runner's
execute-step/cache.ts: a cache failure is logged and never fails the job, a
restore is bounded in bytes, entries and time, archives hold only regular
files and directories inside the repository, and save runs only after every
step succeeded. Artifact commands are explicit user commands, so they exit
non-zero on failure.
"""

import glob
import gzip
import hashlib
import json
import os
import stat
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

RESTORE_MAX_BYTES = 1024 * 1024 * 1024
RESTORE_MAX_ENTRIES = 100_000
RESTORE_MAX_ENTRY_BYTES = 1024 * 1024 * 1024
RESTORE_MAX_SECONDS = 10 * 60
HTTP_TIMEOUT_SECONDS = 300
CHUNK = 1024 * 1024


class CIError(Exception):
    pass


def env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise CIError(name + " is not set")
    return value


def api_url(path):
    return env("SMITHERS_CI_API_URL").rstrip("/") + path


def request(method, url, body=None, headers=None, auth=True, timeout=HTTP_TIMEOUT_SECONDS):
    headers = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if auth:
        headers["Authorization"] = "Bearer " + env("SMITHERS_CI_JOB_TOKEN")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace").strip()
        raise CIError(detail or "request failed with status %d" % err.code) from None
    except urllib.error.URLError as err:
        raise CIError("request failed: %s" % err.reason) from None
    if not raw:
        return None
    return json.loads(raw)


def put_file(url, path, size, headers):
    headers = dict(headers or {})
    headers.setdefault("Content-Type", "application/octet-stream")
    headers["Content-Length"] = str(size)
    with open(path, "rb") as body:
        req = urllib.request.Request(url, data=body, method="PUT", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
                resp.read()
        except urllib.error.HTTPError as err:
            raise CIError("upload failed with status %d" % err.code) from None
        except urllib.error.URLError as err:
            raise CIError("upload failed: %s" % err.reason) from None


def open_download(url):
    try:
        return urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=HTTP_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as err:
        raise CIError("download failed with status %d" % err.code) from None
    except urllib.error.URLError as err:
        raise CIError("download failed: %s" % err.reason) from None


# ------------------------------------------------------------------ paths


def has_glob_magic(value):
    return any(ch in value for ch in "*?[]{")


def safe_relative(root, candidate):
    """Resolve a repository-relative path lexically, refusing escapes."""
    trimmed = candidate.strip().replace("\\", "/")
    if trimmed == "" or trimmed.startswith("/") or "\0" in trimmed:
        raise CIError("unsafe cache path: " + candidate)
    absolute = os.path.normpath(os.path.join(root, trimmed))
    rel = os.path.relpath(absolute, root)
    if rel == ".." or rel.startswith("../"):
        raise CIError("cache path escapes repository root: " + candidate)
    return absolute, rel.replace(os.sep, "/")


def expand_braces(pattern):
    start = pattern.find("{")
    if start < 0:
        return [pattern]
    end = pattern.find("}", start)
    if end < 0:
        return [pattern]
    out = []
    for option in pattern[start + 1 : end].split(","):
        out.extend(expand_braces(pattern[:start] + option + pattern[end + 1 :]))
    return out


def glob_matches(root, pattern):
    matches = set()
    for expanded in expand_braces(pattern):
        try:
            found = glob.glob(expanded, root_dir=root, recursive=True, include_hidden=True)
        except TypeError:  # Python < 3.11
            found = glob.glob(expanded, root_dir=root, recursive=True)
        matches.update(found)
    return sorted(matches)


def pattern_matches(root, pattern, only_files):
    trimmed = pattern.strip()
    if trimmed == "":
        return []
    candidates = glob_matches(root, trimmed) if has_glob_magic(trimmed) else [trimmed]
    out = []
    for candidate in candidates:
        absolute, rel = safe_relative(root, candidate)
        try:
            info = os.lstat(absolute)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            continue
        if only_files and not stat.S_ISREG(info.st_mode):
            continue
        out.append(rel)
    return sorted(set(out))


def hash_files_version(root, patterns):
    files = set()
    for pattern in patterns or []:
        files.update(pattern_matches(root, pattern, True))
    if not files:
        return "static"
    digest = hashlib.sha256()
    for rel in sorted(files):
        digest.update(rel.encode())
        digest.update(b"\n")
        with open(os.path.join(root, rel), "rb") as handle:
            for chunk in iter(lambda: handle.read(CHUNK), b""):
                digest.update(chunk)
        digest.update(b"\n")
    return digest.hexdigest()


# ---------------------------------------------------------------- archive


def collect_entries(root, patterns):
    entries = {}

    def add(absolute, rel):
        info = os.lstat(absolute)
        if stat.S_ISLNK(info.st_mode):
            return
        if stat.S_ISDIR(info.st_mode):
            if rel not in ("", "."):
                entries[rel] = ("dir", absolute, 0, False)
            for child in sorted(os.listdir(absolute)):
                add(os.path.join(absolute, child), child if rel in ("", ".") else rel + "/" + child)
            return
        if stat.S_ISREG(info.st_mode):
            entries[rel] = ("file", absolute, info.st_size, bool(info.st_mode & 0o111))

    for pattern in patterns or []:
        for rel in pattern_matches(root, pattern, False):
            absolute, rel = safe_relative(root, rel)
            add(absolute, rel)
    return [(rel,) + entries[rel] for rel in sorted(entries)]


def create_archive(root, patterns, destination):
    entries = collect_entries(root, patterns)
    if not entries:
        return 0
    with open(destination, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for rel, kind, absolute, size, executable in entries:
                    info = tarfile.TarInfo(rel)
                    info.mtime = 0
                    if kind == "dir":
                        info.type = tarfile.DIRTYPE
                        info.mode = 0o755
                        archive.addfile(info)
                        continue
                    info.type = tarfile.REGTYPE
                    info.mode = 0o755 if executable else 0o644
                    info.size = size
                    with open(absolute, "rb") as handle:
                        archive.addfile(info, handle)
    return os.path.getsize(destination)


def sanitize_entry_name(name):
    normalized = name.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = normalized.rstrip("/")
    if normalized in ("", "."):
        return ""
    if normalized.startswith("/") or "\0" in normalized:
        raise CIError("cache archive entry uses an absolute path: " + name)
    for part in normalized.split("/"):
        if part == "..":
            raise CIError("cache archive entry escapes repository root: " + name)
    return "/".join(part for part in normalized.split("/") if part not in ("", "."))


def ensure_safe_directory(root, rel):
    current = root
    for part in [p for p in rel.split("/") if p]:
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            os.mkdir(current, 0o755)
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise CIError("cache restore would traverse non-directory path: " + rel)
    return current


def ensure_safe_file_target(root, rel):
    parent = os.path.dirname(rel)
    if parent:
        ensure_safe_directory(root, parent)
    target = os.path.join(root, rel)
    try:
        info = os.lstat(target)
    except FileNotFoundError:
        return target
    if stat.S_ISLNK(info.st_mode) or stat.S_ISDIR(info.st_mode):
        raise CIError("cache restore target is not a regular file: " + rel)
    return target


class LimitedReader:
    """Counts decompressed bytes and enforces the restore byte and time limits."""

    def __init__(self, inner, deadline):
        self.inner = inner
        self.deadline = deadline
        self.total = 0

    def read(self, size=-1):
        if time.monotonic() > self.deadline:
            raise CIError("cache archive restore exceeded time limit (%d ms)" % (RESTORE_MAX_SECONDS * 1000))
        chunk = self.inner.read(size)
        self.total += len(chunk)
        if self.total > RESTORE_MAX_BYTES:
            raise CIError("cache archive exceeds restore decompressed size limit (%d bytes)" % RESTORE_MAX_BYTES)
        return chunk


def extract_archive(root, stream):
    deadline = time.monotonic() + RESTORE_MAX_SECONDS
    limited = LimitedReader(gzip.GzipFile(fileobj=stream, mode="rb"), deadline)
    entries = 0
    with tarfile.open(fileobj=limited, mode="r|") as archive:
        for member in archive:
            entries += 1
            if entries > RESTORE_MAX_ENTRIES:
                raise CIError("cache archive exceeds restore entry limit (%d entries)" % RESTORE_MAX_ENTRIES)
            name = sanitize_entry_name(member.name)
            if member.isdir():
                if name:
                    ensure_safe_directory(root, name)
                continue
            if not member.isreg():
                continue
            if member.size < 0 or member.size > RESTORE_MAX_ENTRY_BYTES:
                raise CIError("cache archive file entry exceeds restore size limit (%d bytes): %s" % (RESTORE_MAX_ENTRY_BYTES, name))
            if not name:
                continue
            target = ensure_safe_file_target(root, name)
            source = archive.extractfile(member)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, member.mode & 0o777)
            with os.fdopen(fd, "wb") as out:
                while True:
                    chunk = source.read(CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
            os.chmod(target, member.mode & 0o777)


# ------------------------------------------------------------------ cache


def load_descriptors(path):
    with open(path) as handle:
        descriptors = json.load(handle) or []
    return [d for d in descriptors if isinstance(d, dict) and str(d.get("key", "")).strip()]


def load_state(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (FileNotFoundError, ValueError):
        return {"versions": {}, "exact_hits": {}}


def cache_restore(descriptors_path, state_path):
    root = os.getcwd()
    descriptors = load_descriptors(descriptors_path)
    state = {"versions": {}, "exact_hits": {}}
    for descriptor in descriptors:
        key = descriptor["key"]
        if key in state["versions"]:
            continue
        if descriptor.get("action") == "restore":
            try:
                state["versions"][key] = hash_files_version(root, descriptor.get("hash_files"))
            except (OSError, CIError) as err:
                print("[cache] restore failed %s: %s" % (key, err), flush=True)
                state["versions"][key] = "static"
        else:
            state["versions"][key] = "static"
    for descriptor in descriptors:
        if descriptor.get("action") != "restore":
            continue
        key = descriptor["key"]
        version = state["versions"].get(key, "static")
        try:
            restore = request("POST", api_url("/caches/restore"), {"key": key, "cache_version": version})
            if not restore or not restore.get("hit") or not restore.get("download_url"):
                print("[cache] miss " + key, flush=True)
                continue
            with open_download(restore["download_url"]) as body:
                extract_archive(root, body)
            if restore.get("cache_key") == key and restore.get("cache_version") == version:
                state["exact_hits"][key] = version
            print("[cache] hit %s (%s)" % (key, restore.get("bookmark_name") or "unknown"), flush=True)
        except (OSError, CIError, tarfile.TarError, EOFError, ValueError) as err:
            print("[cache] restore failed %s: %s" % (key, err), flush=True)
    with open(state_path, "w") as handle:
        json.dump(state, handle)


def cache_save(descriptors_path, state_path):
    root = os.getcwd()
    state = load_state(state_path)
    saves = [d for d in load_descriptors(descriptors_path) if d.get("action") == "save"]
    workdir = tempfile.mkdtemp(prefix="smithers-cache-")
    try:
        for index, descriptor in enumerate(saves):
            key = descriptor["key"]
            version = state.get("versions", {}).get(key, "static")
            archive_path = os.path.join(workdir, "cache-%d.tgz" % index)
            reservation = None
            try:
                if state.get("exact_hits", {}).get(key) == version:
                    print("[cache] already exists " + key, flush=True)
                    continue
                size = create_archive(root, descriptor.get("paths"), archive_path)
                if size <= 0:
                    print("[cache] skipped %s (no files)" % key, flush=True)
                    continue
                reservation = request(
                    "POST",
                    api_url("/caches/save"),
                    {"key": key, "cache_version": version, "object_size_bytes": size},
                )
                if reservation.get("already_exists") or not reservation.get("upload_url"):
                    print("[cache] already exists " + key, flush=True)
                    continue
                if size > int(reservation.get("archive_max_bytes") or 0):
                    abort_reservation(reservation)
                    print("[cache] skipped %s (archive too large)" % key, flush=True)
                    continue
                if os.path.getsize(archive_path) != size:
                    raise CIError("cache archive changed after reservation")
                headers = dict(reservation.get("upload_headers") or {})
                headers.setdefault("Content-Type", "application/gzip")
                put_file(reservation["upload_url"], archive_path, size, headers)
                request("POST", api_url("/caches/%d/finalize" % reservation["cache_id"]), {"object_size_bytes": size})
                print("[cache] saved " + key, flush=True)
            except (OSError, CIError, tarfile.TarError, ValueError, KeyError) as err:
                if reservation and reservation.get("cache_id") is not None:
                    abort_reservation(reservation)
                print("[cache] save failed %s: %s" % (key, err), flush=True)
            finally:
                try:
                    os.remove(archive_path)
                except FileNotFoundError:
                    pass
    finally:
        try:
            os.rmdir(workdir)
        except OSError:
            pass


def abort_reservation(reservation):
    try:
        request("POST", api_url("/caches/%d/abort" % reservation["cache_id"]), {})
    except (CIError, KeyError, ValueError):
        pass


# --------------------------------------------------------------- artifacts


def run_path(suffix):
    return api_url("/runs/%s/artifacts%s" % (urllib.parse.quote(env("SMITHERS_WORKFLOW_RUN_ID"), safe=""), suffix))


def artifact_upload(name, path, content_type):
    size = os.path.getsize(path)
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk)
    issued = request(
        "POST",
        run_path("/upload-url"),
        {"name": name, "size": size, "content_type": content_type or "application/octet-stream"},
    )
    headers = dict(issued.get("upload_headers") or {})
    headers.setdefault("Content-Type", issued.get("content_type") or "application/octet-stream")
    put_file(issued["upload_url"], path, size, headers)
    confirmed = request("POST", run_path("/confirm"), {"name": name, "sha256": digest.hexdigest()})
    print("[artifact] uploaded %s (%d bytes)" % (confirmed.get("name", name), confirmed.get("size", size)), flush=True)


def artifact_download(name, path):
    issued = request("GET", run_path("/" + urllib.parse.quote(name, safe="") + "/download"))
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, partial = tempfile.mkstemp(prefix=".smithers-artifact-", dir=parent)
    try:
        with os.fdopen(fd, "wb") as out, open_download(issued["download_url"]) as body:
            while True:
                chunk = body.read(CHUNK)
                if not chunk:
                    break
                out.write(chunk)
        os.replace(partial, path)
    except BaseException:
        try:
            os.remove(partial)
        except FileNotFoundError:
            pass
        raise
    print("[artifact] downloaded " + name, flush=True)


USAGE = """usage:
  smithers-ci cache restore DESCRIPTORS STATE
  smithers-ci cache save DESCRIPTORS STATE
  smithers-ci artifact upload NAME PATH [--content-type TYPE]
  smithers-ci artifact download NAME PATH"""


def main(argv):
    if len(argv) >= 4 and argv[0] == "cache" and argv[1] in ("restore", "save"):
        # Cache failures never fail the job, exactly as on the retired runner.
        try:
            (cache_restore if argv[1] == "restore" else cache_save)(argv[2], argv[3])
        except (OSError, CIError, ValueError) as err:
            print("[cache] %s failed: %s" % (argv[1], err), flush=True)
        return 0
    if len(argv) in (4, 6) and argv[:2] == ["artifact", "upload"]:
        content_type = ""
        if len(argv) == 6:
            if argv[4] != "--content-type":
                print(USAGE, file=sys.stderr)
                return 2
            content_type = argv[5]
        try:
            artifact_upload(argv[2], argv[3], content_type)
        except (OSError, CIError, ValueError, KeyError) as err:
            print("[artifact] upload %s failed: %s" % (argv[2], err), file=sys.stderr, flush=True)
            return 1
        return 0
    if len(argv) == 4 and argv[:2] == ["artifact", "download"]:
        try:
            artifact_download(argv[2], argv[3])
        except (OSError, CIError, ValueError, KeyError) as err:
            print("[artifact] download %s failed: %s" % (argv[2], err), file=sys.stderr, flush=True)
            return 1
        return 0
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

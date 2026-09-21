import base64
import copy
import http.server
import json
import os
import pathlib
import select
import signal
import socket
import ssl
import stat
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
import uuid
from unittest import mock

from coding import Coding, CodingError, local_request, managed_source_file, managed_source_transport


class ManagedSourceTransportTest(unittest.TestCase):
    def bundle(self, **overrides):
        values = {key: "http://host.microsandbox.internal:41023" for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")}
        values.update({key: "/etc/smithers/egress-ca.pem" for key in ("SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO")})
        values.update(overrides)
        return "\n".join("export " + key + "='" + value + "'" for key, value in values.items()).encode()

    def test_only_managed_route_and_trust_enter_the_isolated_transport(self):
        injected = dict(HTTPS_PROXY="http://attacker.invalid:9999", ALL_PROXY="http://attacker.invalid", GIT_SSL_NO_VERIFY="1",
                        GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="http.extraHeader", GIT_CONFIG_VALUE_0="Authorization: injected",
                        SSL_CERT_FILE="/workspace/fake-ca", GIT_TRACE="1", GIT_CONFIG_SYSTEM="/workspace/fake-config")
        with mock.patch("coding.managed_source_file", side_effect=[self.bundle(), b"fixture-ca"]) as read, mock.patch.dict(os.environ, injected):
            env = Coding("/fixture", {"credentialSocket": "/fixed/cache/socket"}).source_git_env(transport=True)
        settings = [(env["GIT_CONFIG_KEY_" + str(i)], env["GIT_CONFIG_VALUE_" + str(i)]) for i in range(int(env["GIT_CONFIG_COUNT"]))]
        self.assertIn(("http.proxy", "http://host.microsandbox.internal:41023"), settings)
        self.assertIn(("http.sslCAInfo", "/etc/smithers/egress-ca.pem"), settings)
        self.assertIn(("http.sslVerify", "true"), settings)
        self.assertIn(("http.followRedirects", "false"), settings)
        self.assertIn(("credential.helper", "cache --socket /fixed/cache/socket"), settings)
        self.assertNotIn("attacker", json.dumps(env)); self.assertNotIn("injected", json.dumps(env))
        self.assertNotIn("GIT_SSL_NO_VERIFY", env); self.assertNotIn("GIT_TRACE", env)
        self.assertEqual(read.call_args_list, [mock.call("/etc/smithers/egress.env", 16384), mock.call("/etc/smithers/egress-ca.pem", 1 << 20)])

    def test_unmanaged_local_transport_does_not_inherit_a_proxy(self):
        with mock.patch("coding.managed_source_file", side_effect=FileNotFoundError()), mock.patch.dict(os.environ, HTTPS_PROXY="http://attacker.invalid"):
            self.assertEqual(managed_source_transport(), [])
        with mock.patch("coding.managed_source_transport") as managed:
            Coding("/fixture", {}).source_git_env()
            managed.assert_not_called()

    def test_malformed_or_alternate_managed_routes_fail_closed(self):
        for change in ({"HTTPS_PROXY": "http://other.internal:41023"}, {"HTTPS_PROXY": "http://user:secret@host.microsandbox.internal:41023"},
                       {"HTTPS_PROXY": "http://host.microsandbox.internal:41023/redirect"}, {"GIT_SSL_CAINFO": "/workspace/ca.pem"}):
            with self.subTest(change=next(iter(change))), mock.patch("coding.managed_source_file", return_value=self.bundle(**change)):
                with self.assertRaises(CodingError) as caught: managed_source_transport()
                self.assertEqual(caught.exception.code, "source_import_unavailable")
                self.assertNotIn("secret", caught.exception.message)
        for content in (self.bundle() + b"\nexport HTTPS_PROXY='http://host.microsandbox.internal:41023'", b"source /workspace/custom.sh", b"export HTTPS_PROXY=$(touch /tmp/injected)"):
            with mock.patch("coding.managed_source_file", return_value=content), self.assertRaises(CodingError): managed_source_transport()
        with mock.patch("coding.managed_source_file", side_effect=[self.bundle(), PermissionError()]), self.assertRaises(CodingError): managed_source_transport()

    def test_nonroot_or_writable_provisioning_is_rejected_before_read(self):
        root = mock.Mock(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
        for unsafe in (mock.Mock(st_uid=1000, st_mode=stat.S_IFDIR | 0o755), mock.Mock(st_uid=0, st_mode=stat.S_IFDIR | 0o777),
                       mock.Mock(st_uid=1000, st_mode=stat.S_IFREG | 0o644, st_size=10), mock.Mock(st_uid=0, st_mode=stat.S_IFREG | 0o666, st_size=10)):
            stats = [root, unsafe] if stat.S_ISDIR(unsafe.st_mode) else [root, root, unsafe]
            with mock.patch("coding.os.lstat"), mock.patch("coding.os.open", return_value=10), mock.patch("coding.os.close"), mock.patch("coding.os.fstat", side_effect=stats), mock.patch("coding.os.read") as read:
                with self.assertRaises(CodingError): managed_source_file("/etc/smithers/egress.env", 16384)
                read.assert_not_called()


class NativeSourceImportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="smithers-source-test-")
        self.root = self.temp.name
        self.repo, self.source = [os.path.join(self.root, name) for name in ("owned", "foreign")]
        for repo in (self.repo, self.source):
            self.command("jj", "git", "init", repo)
            self.command("jj", "-R", repo, "config", "set", "--repo", "user.name", "Source Test")
            self.command("jj", "-R", repo, "config", "set", "--repo", "user.email", "source@example.invalid")
        pathlib.Path(self.source, "code.txt").write_text("before\n")
        self.command("jj", "-R", self.source, "describe", "-m", "foreign base")
        self.base = self.jj(self.source, "log", "--no-graph", "-r", "@", "-T", "commit_id").strip()
        self.command("jj", "-R", self.source, "new")
        pathlib.Path(self.source, "code.txt").write_text("after\n")
        self.command("jj", "-R", self.source, "describe", "-m", "foreign head")
        self.head = self.jj(self.source, "log", "--no-graph", "-r", "@", "-T", "commit_id").strip()
        self.workspace = str(uuid.uuid4())
        self.commits = [{"commitId": sha, "ref": "refs/smithers/workspaces/" + self.workspace + "/sources/" + sha} for sha in (self.head, self.base)]
        self.mirror = os.path.join(self.root, "local", "mirror.git")
        os.makedirs(os.path.dirname(self.mirror))
        self.command("git", "init", "--bare", self.mirror)
        native_source = self.jj(self.source, "git", "root").strip()
        self.command("git", "--git-dir", self.mirror, "fetch", "--no-tags", native_source, *[c["commitId"] + ":" + c["ref"] for c in self.commits])
        self.authorized_requests = []
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self): self.handle_git()
            def do_POST(self): self.handle_git()
            def handle_git(self):
                if self.headers.get("Authorization") != "Basic " + base64.b64encode(b"smithers:fixture-only-token").decode():
                    self.send_response(401); self.send_header("WWW-Authenticate", 'Basic realm="source-test"'); self.send_header("Content-Length", "0"); self.end_headers(); return
                owner.authorized_requests.append(self.path)
                url = urllib.parse.urlsplit(self.path)
                env = dict(os.environ, GIT_PROJECT_ROOT=owner.root, GIT_HTTP_EXPORT_ALL="1", PATH_INFO=url.path,
                           QUERY_STRING=url.query, REQUEST_METHOD=self.command, CONTENT_TYPE=self.headers.get("Content-Type", ""),
                           REMOTE_USER="smithers", CONTENT_LENGTH=self.headers.get("Content-Length", "0"))
                result = subprocess.run(["git", "http-backend"], input=self.rfile.read(int(env["CONTENT_LENGTH"])), capture_output=True, env=env)
                headers, body = result.stdout.split(b"\r\n\r\n", 1)
                parsed = [line.decode().split(":", 1) for line in headers.split(b"\r\n")]
                status = next((int(value.strip().split()[0]) for key, value in parsed if key == "Status"), 200)
                self.send_response(status)
                for key, value in parsed:
                    if key != "Status": self.send_header(key, value.strip())
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        base = "http://127.0.0.1:" + str(self.server.server_port)
        self.socket = os.path.join(self.root, "credential", "socket")
        os.makedirs(os.path.dirname(self.socket), mode=0o700)
        self.config = dict(version=1, workspaceId=self.workspace, repositoryId=42, actorId=42,
                           repositoryPath=self.repo, repositorySlug="local/mirror", apiBaseUrl=base+"/api",
                           gitUrl=base+"/local/mirror.git", credentialSocket=self.socket)
        subprocess.run(["git", "credential-cache", "--socket", self.socket, "store"], input="url="+self.config["gitUrl"]+"\nusername=smithers\npassword=fixture-only-token\n\n", text=True, check=True)
        self.request = dict(operation="import_source", requestId=str(uuid.uuid4()), repositoryPath=self.repo, commits=self.commits)

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        subprocess.run(["git", "credential-cache", "--socket", self.socket, "exit"], capture_output=True)
        self.temp.cleanup()

    def command(self, *args):
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def jj(self, repo, *args):
        return self.command("jj", "-R", repo, "--no-pager", "--ignore-working-copy", "--at-op=@", *args)

    def adapter(self):
        request = local_request(json.dumps(self.request), self.config)
        request.pop("requireReporterLock")  # The suite owns its throwaway native lock; no installed system reporter.
        return Coding(self.repo, request)

    def test_exact_foreign_ancestry_diff_dirty_bytes_bookmarks_and_retry(self):
        self.command("jj", "-R", self.repo, "bookmark", "create", "user-bookmark")
        self.jj(self.repo, "git", "export")
        before = Coding(self.repo, {"operation": "read"}).run()
        pathlib.Path(self.repo, "unsaved.txt").write_text("user unsaved bytes\n")
        native = self.jj(self.repo, "git", "root").strip()
        # The repository's transport rewrites and helpers must never run.
        self.command("git", "--git-dir", native, "config", "url.http://127.0.0.1:1/.insteadOf", self.config["gitUrl"])
        result = self.adapter().run()
        self.assertTrue(self.authorized_requests)
        self.assertEqual(result["head"]["commitId"], before["head"]["commitId"])
        self.assertEqual(result["revisions"][0]["parentCommitIds"], [self.base])
        self.assertEqual([r["commitId"] for r in result["revisions"]], [self.head, self.base])
        merge = self.jj(self.repo, "log", "--no-graph", "-r", 'heads(::commit_id("'+self.base+'") & ::commit_id("'+self.head+'"))', "-T", "commit_id").strip()
        self.assertEqual(merge, self.base)
        diff = Coding(self.repo, {"operation": "diff", "from": self.base, "to": self.head}).run(engine=True)["diff"]
        self.assertIn("-before", diff); self.assertIn("+after", diff)
        self.assertEqual(pathlib.Path(self.repo, "unsaved.txt").read_text(), "user unsaved bytes\n")
        self.assertNotIn("smithers-source-import", self.command("git", "--git-dir", native, "for-each-ref"))
        replay = self.adapter().run()
        self.assertEqual(replay, result)

    def test_pending_user_git_changes_refuse_before_transfer_or_mutation(self):
        native = self.jj(self.repo, "git", "root").strip()
        before = Coding(self.repo, {"operation": "read"}).run()
        self.command("git", "--git-dir", native, "update-ref", "refs/heads/pending-user", before["head"]["commitId"])
        with self.assertRaises(CodingError) as caught: self.adapter().run()
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertFalse(self.authorized_requests)
        self.assertEqual(Coding(self.repo, {"operation": "read"}).run(), before)

    def test_config_and_reserved_ref_are_bound_before_network(self):
        for field, value in (("workspaceId", self.workspace), ("gitUrl", self.config["gitUrl"]), ("token", "anything")):
            with self.assertRaises(CodingError): local_request(json.dumps(dict(self.request, **{field: value})), self.config)
        bad = copy.deepcopy(self.request); bad["commits"][0]["ref"] = self.commits[0]["ref"].replace(self.workspace, str(uuid.uuid4()))
        with self.assertRaises(CodingError): local_request(json.dumps(bad), self.config)
        self.assertFalse(self.authorized_requests)

    def test_missing_source_and_wrong_retained_hash_have_typed_errors(self):
        for mode in ("missing", "changed"):
            c = self.commits[0]
            if mode == "missing": self.command("git", "--git-dir", self.mirror, "update-ref", "-d", c["ref"], c["commitId"])
            else: self.command("git", "--git-dir", self.mirror, "update-ref", c["ref"], self.base)
            with self.assertRaises(CodingError) as caught: self.adapter().run()
            self.assertEqual(caught.exception.code, "source_" + mode)

    def test_interrupted_import_seed_is_recovered_without_pruning_user_refs(self):
        adapter = self.adapter(); original = adapter.source_git
        def interrupt(args, *rest, **kwargs):
            if "update-ref" in args and "-d" in args:
                raise CodingError("source_import_unavailable", "fixture interruption after indexing")
            return original(args, *rest, **kwargs)
        with mock.patch.object(adapter, "source_git", side_effect=interrupt):
            with self.assertRaises(CodingError): adapter.run()
        result = self.adapter().run()
        self.assertEqual(result["revisions"][0]["commitId"], self.head)
        native = self.jj(self.repo, "git", "root").strip()
        self.assertNotIn("smithers-source-import", self.command("git", "--git-dir", native, "for-each-ref"))

    def test_transport_timeout_kills_descendants_and_redacts_errors(self):
        adapter = self.adapter(); adapter.import_deadline = time.monotonic() + 10
        process = mock.Mock(pid=1234); process.communicate.side_effect = subprocess.TimeoutExpired("git", 10, stderr="secret-remote-message")
        with mock.patch("coding.subprocess.Popen", return_value=process), mock.patch("coding.os.killpg") as kill:
            with self.assertRaises(CodingError) as caught: adapter.source_git(["fetch"])
            self.assertEqual(caught.exception.code, "source_import_unavailable")
            self.assertNotIn("secret", caught.exception.message)
            kill.assert_called_once_with(1234, signal.SIGKILL); process.wait.assert_called_once()

    def test_https_managed_proxy_import_preserves_source_and_validates_tls(self):
        cert, key = [os.path.join(self.root, name) for name in ("proxy-ca.pem", "proxy-key.pem")]
        self.command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                     "-subj", "/CN=native-source.invalid", "-addext", "subjectAltName=DNS:native-source.invalid",
                     "-keyout", key, "-out", cert)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self.server.RequestHandlerClass)
        origin.socket = context.wrap_socket(origin.socket, server_side=True)
        origin_thread = threading.Thread(target=origin.serve_forever, daemon=True); origin_thread.start()
        tunnels = []
        class Proxy(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_CONNECT(self):
                tunnels.append(dict(target=self.path, credentials=bool(self.headers.get("Authorization") or self.headers.get("Proxy-Authorization"))))
                if self.path != "native-source.invalid:443":
                    self.send_error(403); return
                with socket.create_connection(("127.0.0.1", origin.server_port), timeout=5) as upstream:
                    self.send_response(200); self.end_headers(); self.wfile.flush()
                    peers = (self.connection, upstream)
                    try:
                        while True:
                            ready, _, _ = select.select(peers, [], [], 10)
                            if not ready: return
                            for peer in ready:
                                data = peer.recv(65536)
                                if not data: return
                                (upstream if peer is self.connection else self.connection).sendall(data)
                    except OSError: return
        proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True); proxy_thread.start()
        try:
            self.config.update(apiBaseUrl="https://native-source.invalid/api", gitUrl="https://native-source.invalid/local/mirror.git")
            subprocess.run(["git", "credential-cache", "--socket", self.socket, "store"], input="url="+self.config["gitUrl"]+"\nusername=smithers\npassword=fixture-only-token\n\n", text=True, check=True)
            before = Coding(self.repo, {"operation": "read"}).run()
            pathlib.Path(self.repo, "unsaved.txt").write_text("preserve during proxied import\n")
            route = [("http.proxy", "http://127.0.0.1:" + str(proxy.server_port)), ("http.sslCAInfo", cert), ("http.sslVerify", "true")]
            # Only the root-bundle reader is replaced by fixture routing. Git,
            # CONNECT, TLS, credential cache, retained refs and JJ are real.
            with mock.patch("coding.managed_source_transport", return_value=route[:-2] + [("http.sslVerify", "true")]):
                with self.assertRaises(CodingError) as caught: self.adapter().run()
                self.assertEqual(caught.exception.code, "source_import_unavailable")
                self.assertFalse(self.authorized_requests)
                self.assertEqual(Coding(self.repo, {"operation": "read"}).run(), before)
            with mock.patch("coding.managed_source_transport", return_value=route), mock.patch.dict(os.environ, HTTPS_PROXY="http://127.0.0.1:1", ALL_PROXY="http://127.0.0.1:1", GIT_SSL_NO_VERIFY="1", SSL_CERT_FILE="/missing/ambient-ca"):
                result = self.adapter().run()
            self.assertGreaterEqual(len(tunnels), 3)
            self.assertTrue(all(t == {"target": "native-source.invalid:443", "credentials": False} for t in tunnels))
            self.assertTrue(any(path.endswith("/git-upload-pack") for path in self.authorized_requests))
            self.assertEqual(result["head"]["commitId"], before["head"]["commitId"])
            self.assertEqual([r["commitId"] for r in result["revisions"]], [self.head, self.base])
            self.assertEqual(result["revisions"][0]["parentCommitIds"], [self.base])
            diff = Coding(self.repo, {"operation": "diff", "from": self.base, "to": self.head}).run(engine=True)["diff"]
            self.assertIn("-before", diff); self.assertIn("+after", diff)
            self.assertEqual(pathlib.Path(self.repo, "unsaved.txt").read_text(), "preserve during proxied import\n")
        finally:
            proxy.shutdown(); proxy.server_close(); proxy_thread.join()
            origin.shutdown(); origin.server_close(); origin_thread.join()

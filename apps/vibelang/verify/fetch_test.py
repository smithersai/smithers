"""Regression: the pinned Dafny archive comes from a shared, checksum-checked cache, and a failed download retries.

Three lanes hit HTTP 504 from GitHub in one night because every install downloaded the archive again. A local HTTP
server stands in for the release host; it answers 504 a chosen number of times before serving the archive."""
import hashlib, http.server, os, pathlib, socketserver, subprocess, tempfile, threading, unittest
ROOT = pathlib.Path(__file__).resolve().parent
ARCHIVE = b'pinned release archive\n' * 1000
SHA256 = hashlib.sha256(ARCHIVE).hexdigest()

class Release(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests += 1
        if self.server.failures > 0:
            self.server.failures -= 1
            self.send_response(504)
            self.end_headers()
            return
        if self.server.stalls > 0:
            self.server.stalls -= 1
            if self.server.stall_mode == 'body':
                self.send_response(200)
                self.send_header('content-length', str(len(ARCHIVE)))
                self.end_headers()
                self.wfile.write(ARCHIVE[:10])
                self.wfile.flush()
            self.server.release.wait(10)
            return
        self.send_response(200)
        self.send_header('content-length', str(len(ARCHIVE)))
        self.end_headers()
        self.wfile.write(ARCHIVE)
    def log_message(self, *args):
        pass

class Fetch(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Release)
        self.server.requests = 0
        self.server.failures = 0
        self.server.stalls = 0
        self.server.stall_mode = 'headers'
        self.server.release = threading.Event()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.folder = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.folder.name)
        self.cache = self.home / 'cache'
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/dafny.zip'
    def tearDown(self):
        self.server.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.folder.cleanup()
    def fetch(self, destination, attempts=4, **settings):
        environment = {**os.environ, 'VIBELANG_VERIFY_CACHE': str(self.cache), 'VIBELANG_VERIFY_FETCH_ATTEMPTS': str(attempts), 'VIBELANG_VERIFY_FETCH_BACKOFF': '0'}
        environment.update(settings)
        return subprocess.run(['bash', str(ROOT / 'fetch.sh'), self.url, SHA256, str(destination)], capture_output=True, text=True, env=environment, timeout=5)
    def cached(self):
        return sorted(path.name for path in self.cache.iterdir()) if self.cache.exists() else []

    def test_retries_a_504_then_caches_the_verified_archive(self):
        self.server.failures = 2
        result = self.fetch(self.home / 'a' / 'dafny.zip')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / 'a' / 'dafny.zip').read_bytes(), ARCHIVE)
        self.assertEqual(self.server.requests, 3)
        self.assertEqual(self.cached(), [f'{SHA256}-dafny.zip'])

    def test_a_second_install_reuses_the_cache_while_the_host_is_down(self):
        self.assertEqual(self.fetch(self.home / 'a' / 'dafny.zip').returncode, 0)
        self.server.failures = 1000
        result = self.fetch(self.home / 'b' / 'dafny.zip')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / 'b' / 'dafny.zip').read_bytes(), ARCHIVE)
        self.assertEqual(self.server.requests, 1)

    def test_a_cached_copy_with_the_wrong_checksum_is_downloaded_again(self):
        self.cache.mkdir()
        (self.cache / f'{SHA256}-dafny.zip').write_bytes(b'truncated')
        result = self.fetch(self.home / 'a' / 'dafny.zip')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.server.requests, 1)
        self.assertEqual((self.cache / f'{SHA256}-dafny.zip').read_bytes(), ARCHIVE)
        self.assertEqual((self.home / 'a' / 'dafny.zip').read_bytes(), ARCHIVE)

    def test_gives_up_after_its_attempts_and_caches_nothing(self):
        self.server.failures = 1000
        result = self.fetch(self.home / 'a' / 'dafny.zip', attempts=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.server.requests, 3)
        self.assertFalse((self.home / 'a' / 'dafny.zip').exists())
        self.assertEqual(self.cached(), [])

    def test_stalled_headers_and_body_exhaust_retries_without_replacing_destination(self):
        for mode in ('headers', 'body'):
            with self.subTest(mode=mode):
                self.server.stall_mode = mode
                self.server.stalls = 2
                self.server.requests = 0
                destination = self.home / 'dafny.zip'
                destination.write_bytes(b'existing archive')
                result = self.fetch(destination, attempts=2, VIBELANG_VERIFY_FETCH_TIMEOUT='0.25',
                                    VIBELANG_VERIFY_FETCH_CONNECT_TIMEOUT='0.25')
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn('Download 1 of 2 failed', result.stderr)
                self.assertIn('Download 2 of 2 failed', result.stderr)
                self.assertIn('after 2 attempts', result.stderr)
                self.assertEqual(self.server.requests, 2)
                self.assertEqual(destination.read_bytes(), b'existing archive')
                self.assertEqual(self.cached(), [])

    def test_a_stalled_attempt_can_recover_on_the_next_attempt(self):
        self.server.stalls = 1
        result = self.fetch(self.home / 'dafny.zip', attempts=2, VIBELANG_VERIFY_FETCH_TIMEOUT='0.25')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.server.requests, 2)
        self.assertEqual((self.home / 'dafny.zip').read_bytes(), ARCHIVE)
        self.assertEqual(self.cached(), [f'{SHA256}-dafny.zip'])

    def test_stalled_tls_handshakes_use_the_connection_deadline(self):
        class StalledTLS(socketserver.BaseRequestHandler):
            def handle(connection):
                connection.server.requests += 1
                connection.server.release.wait(10)
        server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), StalledTLS)
        server.daemon_threads = True
        server.requests = 0
        server.release = threading.Event()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            self.url = f'https://127.0.0.1:{server.server_address[1]}/dafny.zip'
            result = self.fetch(self.home / 'dafny.zip', attempts=2,
                                VIBELANG_VERIFY_FETCH_CONNECT_TIMEOUT='0.25',
                                VIBELANG_VERIFY_FETCH_TIMEOUT='10')
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertIn('Download 2 of 2 failed', result.stderr)
            self.assertEqual(server.requests, 2)
            self.assertFalse((self.home / 'dafny.zip').exists())
            self.assertEqual(self.cached(), [])
        finally:
            server.release.set()
            server.shutdown()
            server.server_close()

    def test_timeouts_cannot_disable_the_deadline(self):
        for name in ('VIBELANG_VERIFY_FETCH_TIMEOUT', 'VIBELANG_VERIFY_FETCH_CONNECT_TIMEOUT'):
            for value in ('0', '0.0', '0.00001', '0.0001', '-1', 'infinity', 'invalid'):
                with self.subTest(name=name, value=value):
                    result = self.fetch(self.home / 'dafny.zip', **{name: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('positive seconds', result.stderr)
                    self.assertEqual(self.server.requests, 0)
                    self.assertEqual(self.cached(), [])

if __name__ == '__main__':
    unittest.main()

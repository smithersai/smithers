"""Regression: the pinned Dafny archive comes from a shared, checksum-checked cache, and a failed download retries.

Three lanes hit HTTP 504 from GitHub in one night because every install downloaded the archive again. A local HTTP
server stands in for the release host; it answers 504 a chosen number of times before serving the archive."""
import hashlib, http.server, os, pathlib, subprocess, tempfile, threading, unittest
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
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.folder = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.folder.name)
        self.cache = self.home / 'cache'
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/dafny.zip'
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.folder.cleanup()
    def fetch(self, destination, attempts=4):
        environment = {**os.environ, 'VIBELANG_VERIFY_CACHE': str(self.cache), 'VIBELANG_VERIFY_FETCH_ATTEMPTS': str(attempts), 'VIBELANG_VERIFY_FETCH_BACKOFF': '0'}
        return subprocess.run(['bash', str(ROOT / 'fetch.sh'), self.url, SHA256, str(destination)], capture_output=True, text=True, env=environment)
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

if __name__ == '__main__':
    unittest.main()

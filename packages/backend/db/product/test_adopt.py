"""Real PostgreSQL coverage for the one-time product baseline adoption."""

import json
import os
from pathlib import Path
import subprocess
import unittest
import uuid
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parent
BASELINE = ROOT / "migrations" / "0001_product_baseline.sql"
ADOPT = ROOT / "adopt.py"


def latest_migration_version() -> int:
    versions = [int(path.name[:4]) for path in (ROOT / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql")]
    if not versions:
        raise AssertionError("product migration directory is empty")
    return max(versions)


def database_url(admin_url: str, name: str) -> str:
    parts = urlsplit(admin_url)
    return urlunsplit((parts.scheme, parts.netloc, "/" + name, parts.query, parts.fragment))


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=True)


@unittest.skipUnless(os.environ.get("L8_ADOPTION_TEST_ADMIN_URL"), "requires PostgreSQL")
class AdoptionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.admin = os.environ["L8_ADOPTION_TEST_ADMIN_URL"]
        suffix = uuid.uuid4().hex[:12]
        self.expected_name = "l8_expected_" + suffix
        self.target_name = "l8_target_" + suffix
        for name in (self.expected_name, self.target_name):
            run("createdb", "--maintenance-db", self.admin, name)
        self.expected = database_url(self.admin, self.expected_name)
        self.target = database_url(self.admin, self.target_name)
        run("psql", "-X", "-1", "-v", "ON_ERROR_STOP=1", "-d", self.target, "-f", str(BASELINE))

    def tearDown(self) -> None:
        for name in (self.expected_name, self.target_name):
            run("dropdb", "--maintenance-db", self.admin, "--force", name)

    def adopt(self, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ("python3", str(ADOPT), "--baseline-url", self.expected,
             "--target-url", self.target, *extra),
            text=True, capture_output=True,
        )

    def test_changed_product_column_blocks_ledger(self) -> None:
        run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-d", self.target,
            "-c", "ALTER TABLE public.users ADD COLUMN adoption_drift text")
        result = self.adopt("--apply")
        self.assertEqual(result.returncode, 2, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(any("users" in item["object"] for item in report["drift"]))
        ledger = run("psql", "-X", "-At", "-d", self.target,
                     "-c", "SELECT to_regclass('public.smithers_product_migrations') IS NULL")
        self.assertEqual(ledger.stdout.strip(), "t")

    def test_exact_baseline_adopts_once(self) -> None:
        run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-d", self.target,
            "-c", "INSERT INTO public.users(username, lower_username) VALUES ('before_adoption', 'before_adoption')")
        result = self.adopt("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["drift"], [])
        ledger = run("psql", "-X", "-At", "-d", self.target,
                     "-c", "SELECT version, (SELECT count(*) FROM public.users WHERE username='before_adoption') "
                           "FROM public.smithers_product_migrations")
        self.assertEqual(ledger.stdout.strip(), "1|1")
        migrate_env = os.environ.copy()
        migrate_env["SMITHERS_DATABASE_URL"] = self.target
        migrated = subprocess.run(("go", "run", "./apps/backend", "migrate", "apply"),
                                  cwd=ROOT.parents[3], env=migrate_env,
                                  text=True, capture_output=True)
        self.assertEqual(migrated.returncode, 0, migrated.stderr)
        latest = run("psql", "-X", "-At", "-d", self.target,
                     "-c", "SELECT max(version), (SELECT count(*) FROM public.users "
                           "WHERE username='before_adoption') FROM public.smithers_product_migrations")
        self.assertEqual(latest.stdout.strip(), f"{latest_migration_version()}|1")

    def test_preexisting_later_migration_is_verified_before_ledger_write(self) -> None:
        later = ROOT / "migrations" / "0010_branch_lock_and_workflow_invocations.sql"
        run("psql", "-X", "-1", "-v", "ON_ERROR_STOP=1", "-d", self.target, "-f", str(later))
        result = self.adopt("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["preexisting_migrations"], [10])
        ledger = run("psql", "-X", "-At", "-d", self.target,
                     "-c", "SELECT string_agg(version::text, ',' ORDER BY version) "
                           "FROM public.smithers_product_migrations")
        self.assertEqual(ledger.stdout.strip(), "1,10")
        migrate_env = os.environ.copy()
        migrate_env["SMITHERS_DATABASE_URL"] = self.target
        migrated = subprocess.run(("go", "run", "./apps/backend", "migrate", "apply"),
                                  cwd=ROOT.parents[3], env=migrate_env,
                                  text=True, capture_output=True)
        self.assertEqual(migrated.returncode, 0, migrated.stderr)
        ledger = run("psql", "-X", "-At", "-d", self.target,
                     "-c", "SELECT count(*), max(version) FROM public.smithers_product_migrations")
        self.assertEqual(ledger.stdout.strip(), f"{latest_migration_version()}|{latest_migration_version()}")

    def test_preexisting_coding_receipt_is_adopted(self) -> None:
        later = ROOT / "migrations" / "0012_workflow_run_coding_hosts.sql"
        run("psql", "-X", "-1", "-v", "ON_ERROR_STOP=1", "-d", self.target, "-f", str(later))
        result = self.adopt("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["preexisting_migrations"], [12])
        ledger = run("psql", "-X", "-At", "-d", self.target,
                     "-c", "SELECT string_agg(version::text, ',' ORDER BY version) "
                           "FROM public.smithers_product_migrations")
        self.assertEqual(ledger.stdout.strip(), "1,12")

    def test_preexisting_chat_turn_erasures_is_adopted(self) -> None:
        later = ROOT / "migrations" / "0013_chat_turn_erasures.sql"
        run("psql", "-X", "-1", "-v", "ON_ERROR_STOP=1", "-d", self.target, "-f", str(later))
        result = self.adopt("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["preexisting_migrations"], [13])
        ledger = run("psql", "-X", "-At", "-d", self.target,
                     "-c", "SELECT string_agg(version::text, ',' ORDER BY version) "
                           "FROM public.smithers_product_migrations")
        self.assertEqual(ledger.stdout.strip(), "1,13")

    def test_partial_later_migration_refuses_ledger_write(self) -> None:
        run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-d", self.target,
            "-c", "ALTER TABLE public.branch_locks "
                  "ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid()")
        result = self.adopt("--apply")
        self.assertEqual(result.returncode, 2, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(any(item["object"] == "PRODUCT MIGRATION 10" for item in report["drift"]))
        ledger = run("psql", "-X", "-At", "-d", self.target,
                     "-c", "SELECT to_regclass('public.smithers_product_migrations') IS NULL")
        self.assertEqual(ledger.stdout.strip(), "t")


if __name__ == "__main__":
    unittest.main()

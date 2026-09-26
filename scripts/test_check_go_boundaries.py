"""Exercise the boundary gate against real source and Go dependency graphs."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("boundaries", Path(__file__).with_name("check-go-boundaries.py"))
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def test_internal_topology_is_checked(self):
        self.write("packages/backend/internal/compose/main.go", 'package compose\nconst role = "hosted_worker"\n')
        self.assertEqual(len(boundaries.source_imports(self.root)), 1)

    def test_every_deleted_package_root_is_rejected(self):
        self.assertEqual(boundaries.source_imports(self.root), [])
        for package in boundaries.PRIVATE_PACKAGE_ROOTS:
            with self.subTest(package=package):
                target = self.root / package
                target.mkdir(parents=True)
                self.assertEqual(boundaries.source_imports(self.root), [
                    f"{package}: private package belongs to Plue",
                ])
                target.rmdir()

    def test_all_hosted_topology_spellings_are_rejected(self):
        for identifier in ("HostedRollout", "RoleHostedAPI", "RoleHostedWorker", "hosted_api", "hosted_worker", "PLUE_BACKEND_ROLE", "PLUE_CLI_VERSION"):
            with self.subTest(identifier=identifier):
                self.write("packages/backend/app/contract.go", f'package app\nconst value = "{identifier}"\n')
                self.assertEqual(len(boundaries.source_imports(self.root)), 1)
        self.write("packages/backend/app/contract.go", 'package app\nconst value = "http"\n')
        self.assertEqual(boundaries.source_imports(self.root), [])

    def test_testkit_cannot_enter_production_through_helper_package(self):
        self.write("packages/helper/helper.go", f'package helper\nimport "{boundaries.TESTKIT_IMPORT}"\n')
        self.assertEqual(boundaries.source_imports(self.root), [
            "packages/helper/helper.go: production source imports testkit",
        ])
        (self.root / "packages/helper/helper.go").rename(self.root / "packages/helper/helper_test.go")
        self.assertEqual(boundaries.source_imports(self.root), [])

    def test_testkit_subpackages_are_testkit(self):
        self.write("packages/helper/helper.go", f'package helper\nimport "{boundaries.TESTKIT_IMPORT}/testdb"\n')
        self.assertEqual(boundaries.source_imports(self.root), [
            "packages/helper/helper.go: production source imports testkit",
        ])
        (self.root / "packages/helper/helper.go").unlink()
        self.write(f"{boundaries.TESTKIT_ROOT}/postgresfixture/product.go", f'package postgresfixture\nimport "{boundaries.TESTKIT_IMPORT}/testdb"\n')
        self.assertEqual(boundaries.source_imports(self.root), [])

    def test_test_imports_cannot_reintroduce_cloud_sdks(self):
        self.write("packages/backend/auth_test.go", 'package backend\nimport crypto "github.com/ethereum/go-ethereum/crypto"\n')
        self.assertEqual(len(boundaries.source_imports(self.root)), 1)

    def test_private_schema_cannot_be_restored(self):
        self.write("packages/backend/db/cluster/sqlc_schema.sql", "CREATE TABLE private_placement (id bigint);\n")
        self.assertEqual(boundaries.source_imports(self.root), [
            "packages/backend/db/cluster: private schema belongs to Plue",
        ])

    def test_production_private_sql_mutations_are_rejected(self):
        # Mutate an otherwise valid production source, then remove the actual
        # SQL mutation and prove the same boundary check passes again.
        path = "packages/backend/internal/services/provisioning.go"
        baseline = 'package services\n// repository_provisioning_operations is supplied through a Store.\ntype RepositoryProvisioningStore interface {}\n'
        for table in boundaries.PRIVATE_SQL_TABLES:
            for expression in (f'`SELECT * FROM {table} FOR UPDATE`', f'"UPDATE public.{table}\\nSET enabled=true"', f'`INSERT INTO "public"."{table}" DEFAULT VALUES`'):
                with self.subTest(table=table, expression=expression):
                    self.write(path, baseline + f"const query = {expression}\n")
                    self.assertEqual(boundaries.source_imports(self.root), [f"{path}: SQL table {table} belongs to Plue"])
                    self.write(path, baseline)
                    self.assertEqual(boundaries.source_imports(self.root), [])

    def test_private_table_names_in_docs_and_interfaces_are_allowed(self):
        self.write("packages/backend/internal/services/provisioning.go", 'package services\n// SELECT * FROM repository_provisioning_operations\ntype RepositoryProvisioningStore interface {}\nconst message = "repository_provisioning_operations unavailable"\n')
        self.assertEqual(boundaries.source_imports(self.root), [])

    def test_dependency_resolution_failure_is_not_a_pass(self):
        self.assertTrue(boundaries.local_graph(self.root))

    def test_transitive_dependency_is_checked(self):
        self.write("go.mod", "module example.test/product\n\ngo 1.26.8\n\nrequire github.com/stripe/stripe-go v0.0.0\nreplace github.com/stripe/stripe-go => ./provider\n")
        self.write("provider/go.mod", "module github.com/stripe/stripe-go\n\ngo 1.26.8\n")
        self.write("provider/provider.go", "package stripe\n")
        self.write("packages/adapter/adapter.go", 'package adapter\nimport _ "github.com/stripe/stripe-go"\n')
        self.write("apps/backend/main.go", 'package main\nimport _ "example.test/product/packages/adapter"\nfunc main() {}\n')
        self.assertEqual(boundaries.local_graph(self.root), ["default backend imports deployment SDK github.com/stripe/stripe-go"])

    def test_neutral_backend_passes(self):
        self.write("go.mod", "module example.test/product\n\ngo 1.26.8\n")
        self.write("apps/backend/main.go", "package main\nfunc main() {}\n")
        self.assertEqual(boundaries.source_imports(self.root), [])
        self.assertEqual(boundaries.local_graph(self.root), [])


if __name__ == "__main__":
    unittest.main()

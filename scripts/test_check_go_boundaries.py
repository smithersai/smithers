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

    def test_test_imports_cannot_reintroduce_cloud_sdks(self):
        self.write("packages/backend/auth_test.go", 'package backend\nimport crypto "github.com/ethereum/go-ethereum/crypto"\n')
        self.assertEqual(len(boundaries.source_imports(self.root)), 1)

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

"""Safe receipt parsing through real subprocess boundaries; no provider or network requests."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location("gate", pathlib.Path(__file__).with_name("check-electric-deploy.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Receipts(unittest.TestCase):
    def emit(self, value):
        return gate.snapshot([sys.executable, "-c", "print(" + repr(json.dumps(value)) + ")"])

    def test_provider_receipt(self):
        receipt = {"instanceId": "actor", "startedAt": "2026-10-26T00:00:00Z"}
        self.assertEqual(self.emit(receipt), receipt)

    def test_rejects_raw_payloads_and_absent_lifecycle(self):
        for receipt in [{}, {"instanceId": "actor"}, {"instanceId": "", "startedAt": 1},
                        {"instanceId": "actor", "startedAt": None},
                        {"instanceId": "actor", "startedAt": 1, "url": "private-sentinel"}]:
            with self.subTest(receipt=receipt), self.assertRaises(ValueError):
                self.emit(receipt)

    def test_faulty_provider_command(self):
        with self.assertRaises(subprocess.CalledProcessError):
            gate.snapshot([sys.executable, "-c", "raise SystemExit(7)"])

    def test_non_json_provider_output(self):
        with self.assertRaises(ValueError):
            gate.snapshot([sys.executable, "-c", "print('invalid')"])


if __name__ == "__main__":
    unittest.main()

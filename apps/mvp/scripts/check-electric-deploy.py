#!/usr/bin/env python3
"""Lander gate: compare safe lifecycle receipts and run the private production health probe for 15 minutes.

A snapshot command prints only {"instanceId": "...", "startedAt": ...}, from the hosting provider's
container placement/start record (not Worker creation time). It must not print URLs or credentials.
The same command runs before and after the observation window. Deployment is deliberately a separate step.
"""
import argparse
import json
import subprocess
import time


def snapshot(command):
    result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
    value = json.loads(result.stdout)
    # Reject accidentally supplied API payloads rather than forwarding their contents to logs.
    if set(value) != {"instanceId", "startedAt"} or not value["instanceId"] or not value["startedAt"]:
        raise ValueError("expected only instanceId and startedAt")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, help="safe JSON receipt taken after the migration deploy warmed up")
    parser.add_argument("--health-check", required=True, help="private prod-health/check.py")
    parser.add_argument("snapshot_command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.snapshot_command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("a provider snapshot command is required")
    baseline = json.load(open(args.baseline))
    if snapshot(command) != baseline:
        raise SystemExit("FAIL: Electric restarted during deploy")
    deadline = time.monotonic() + 15 * 60
    while time.monotonic() < deadline:
        # One device, health only. No load harness or hidden retry of a failed probe.
        subprocess.run(["python3", "-I", args.health_check, "--minutes", "15", "--rounds", "1", "--devices", "1"], check=True, timeout=120)
        if snapshot(command) != baseline:
            raise SystemExit("FAIL: Electric restarted during observation")
        time.sleep(min(30, max(0, deadline - time.monotonic())))
    subprocess.run(["python3", "-I", args.health_check, "--minutes", "15", "--rounds", "1", "--devices", "1"], check=True, timeout=120)
    if snapshot(command) != baseline:
        raise SystemExit("FAIL: Electric restarted at end of observation")
    print("PASS: unchanged Electric start/instance; 15 minutes of health probes without 5xx")


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.SubprocessError, ValueError, KeyError):
        raise SystemExit("FAIL: deployment health or lifecycle receipt unavailable") from None

#!/usr/bin/env python3
"""Check the public Go dependency direction and the default app import graph."""

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
FORBIDDEN_SOURCE = (
    "github.com/smithersai/plue",
    "github.com/smithers-ai/smithers",  # old Plue module identity
)
FORBIDDEN_LOCAL_GRAPH = (
    "cloud.google.com/",
    "github.com/GoogleCloudPlatform/",
    "github.com/aws/aws-sdk",
    "github.com/stripe/stripe-go",
    "github.com/sendgrid/",
    "github.com/ethereum/go-ethereum",
    "google.golang.org/api/",
    "k8s.io/",
    "sigs.k8s.io/controller-runtime",
)
FORBIDDEN_TOPOLOGY = re.compile(
    r"\b(?:HostedRollout|RoleHostedAPI|RoleHostedWorker|hosted_api|hosted_worker|PLUE_BACKEND_ROLE|PLUE_CLI_VERSION)\b"
)


def source_imports(root: Path = ROOT) -> list[str]:
    failures = []
    forbidden = "|".join(re.escape(prefix) for prefix in FORBIDDEN_SOURCE + FORBIDDEN_LOCAL_GRAPH)
    import_pattern = re.compile(r'^\s*(?:import\s+)?(?:[\w.]+\s+)?"(?:' + forbidden + r')')
    for source_root in (root / "packages", root / "apps"):
        if not source_root.exists():
            continue
        for path in source_root.rglob("*.go"):
            for line_number, line in enumerate(path.read_text().splitlines(), 1):
                # Match import declaration lines, including aliased and
                # single-line imports, without treating comments as imports.
                if import_pattern.match(line):
                    failures.append(f"{path.relative_to(root)}:{line_number}: forbidden import: {line.strip()}")
                # Regression tests may assert that a private variable has no effect.
                if not path.name.endswith("_test.go") and FORBIDDEN_TOPOLOGY.search(line):
                    failures.append(f"{path.relative_to(root)}:{line_number}: deployment-only topology: {line.strip()}")
    return failures


def local_graph(root: Path = ROOT) -> list[str]:
    result = subprocess.run(
        ["go", "list", "-deps", "-f", "{{.ImportPath}}", "./apps/backend"],
        cwd=root,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        return ["go list ./apps/backend failed:", result.stderr.strip()]
    return [
        f"default backend imports deployment SDK {name}"
        for name in result.stdout.splitlines()
        if name.startswith(FORBIDDEN_LOCAL_GRAPH)
    ]


def main() -> int:
    failures = source_imports()
    if "--source-only" not in sys.argv[1:]:
        failures.extend(local_graph())
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("Go import boundaries are clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

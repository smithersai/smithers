#!/usr/bin/env python3
"""Check the public Go dependency direction and the default app import graph."""

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOTS = (ROOT / "packages" / "backend", ROOT / "apps" / "backend")
FORBIDDEN_SOURCE = (
    "github.com/smithersai/plue",
    "github.com/smithers-ai/smithers",  # old Plue module identity
)
FORBIDDEN_LOCAL_GRAPH = (
    "cloud.google.com/",
    "github.com/GoogleCloudPlatform/",
    "google.golang.org/api/",
    "k8s.io/",
    "sigs.k8s.io/controller-runtime",
)


def source_imports() -> list[str]:
    failures = []
    for source_root in SOURCE_ROOTS:
        if not source_root.exists():
            continue
        for path in source_root.rglob("*.go"):
            for line_number, line in enumerate(path.read_text().splitlines(), 1):
                # Match import declaration lines, including aliased and
                # single-line imports, without treating comments as imports.
                if re.match(
                    r'^\s*(?:import\s+)?(?:[\w.]+\s+)?"(?:github\.com/(?:smithersai/plue|smithers-ai/smithers))(?:/|\")',
                    line,
                ):
                    failures.append(f"{path.relative_to(ROOT)}:{line_number}: forbidden import: {line.strip()}")
    return failures


def local_graph() -> list[str]:
    result = subprocess.run(
        ["go", "list", "-deps", "-f", "{{.ImportPath}}", "./apps/backend"],
        cwd=ROOT,
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

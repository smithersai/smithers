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
PRIVATE_PACKAGE_ROOTS = (
    "packages/backend/internal/clusterdb",
    "packages/backend/internal/deploymentdb",
    "packages/backend/internal/clusterservices",
    "packages/backend/internal/microsandbox",
    "packages/backend/internal/runner",
    "packages/backend/internal/runbooks",
    "packages/backend/internal/services/alertregistry",
    "packages/backend/cloud",
)
TESTKIT_IMPORT = "github.com/smithersai/smithers/packages/backend/testkit"

# These journals and placement tables are owned by Plue. Exporting a neutral
# collaborator is fine; embedding SQL against its private schema is not.
PRIVATE_SQL_TABLES = (
    "repository_provisioning_operations",
    "repository_provisioning_control",
    "legacy_mutation_fence_control",
    "repo_storage_sets",
)
GO_LEXEMES = re.compile(r'//[^\n]*|/\*.*?\*/|`[^`]*`|"(?:\\.|[^"\\])*"', re.S)
PRIVATE_SQL_REFERENCE = re.compile(
    r'\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:ONLY\s+)?'
    r'(?:(?:public|"public")\s*\.\s*)?"?('
    + "|".join(PRIVATE_SQL_TABLES) + r')"?\b', re.I
)

def private_sql_references(source: str) -> list[str]:
    failures = []
    for token in GO_LEXEMES.finditer(source):
        literal = token.group()
        if not literal.startswith(('`', '"')):
            continue
        # Interpret ordinary whitespace escapes so multiline quoted SQL is
        # checked too; raw literals need no decoding.
        body = literal[1:-1]
        if literal.startswith('"'):
            body = body.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"')
        for match in PRIVATE_SQL_REFERENCE.finditer(body):
            failures.append(match.group(1).lower())
    return failures



def source_imports(root: Path = ROOT) -> list[str]:
    failures = []
    for relative in (
        "packages/backend/db/cluster",
        "packages/backend/db/generate_schema.py",
        "packages/backend/db/sqlc.yaml",
    ):
        if (root / relative).exists():
            failures.append(f"{relative}: private schema belongs to Plue")
    for relative in PRIVATE_PACKAGE_ROOTS:
        if (root / relative).exists():
            failures.append(f"{relative}: private package belongs to Plue")
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
            if not path.name.endswith("_test.go"):
                for table in private_sql_references(path.read_text()):
                    failures.append(f"{path.relative_to(root)}: SQL table {table} belongs to Plue")
            # A helper package importing testkit could otherwise hide it from
            # a check of executable entry points. Only Go test files may use it.
            if not path.name.endswith("_test.go") and re.search(
                r'"' + re.escape(TESTKIT_IMPORT) + r'"', path.read_text()
            ):
                failures.append(f"{path.relative_to(root)}: production source imports testkit")
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
    failures = [
        f"default backend imports deployment SDK {name}"
        for name in result.stdout.splitlines()
        if name.startswith(FORBIDDEN_LOCAL_GRAPH)
    ]
    if TESTKIT_IMPORT in result.stdout.splitlines():
        failures.append("default backend imports testkit")
    return failures


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

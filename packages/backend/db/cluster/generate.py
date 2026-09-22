#!/usr/bin/env python3
"""Generate one canonical product DTO graph plus private cluster SQL methods.

Run from any directory: python3 packages/backend/db/cluster/generate.py
Requires sqlc v1.30.0 and goimports on PATH.
"""
from pathlib import Path
import re
import subprocess

backend = Path(__file__).resolve().parents[2]
db_root = backend / "db"
product_out = backend / "internal" / "db"
cluster_out = backend / "internal" / "clusterdb"

# sqlc does not delete output files for removed query sources.
for output in (product_out, cluster_out):
    for stale in output.glob("*.sql.go"):
        stale.unlink()

for config in (db_root / "product" / "sqlc.yaml", db_root / "sqlc.yaml"):
    subprocess.run(["sqlc", "generate", "-f", str(config)], check=True)

product_models = set(re.findall(
    r"(?m)^type (\w+) struct \{", (product_out / "models.go").read_text()
))
models = cluster_out / "models.go"
source = models.read_text()
source = re.sub(
    r"(?ms)^type (\w+) struct \{.*?^\}\n",
    lambda match: (
        "type " + match.group(1) + " = db." + match.group(1) + "\n"
        if match.group(1) in product_models else match.group(0)
    ),
    source,
)
source = source.replace(
    "import (",
    'import (\n\t"github.com/smithersai/smithers/packages/backend/internal/db"',
    1,
)
models.write_text(source)
subprocess.run(["goimports", "-w", str(models)], check=True)

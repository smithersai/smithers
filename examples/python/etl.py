# /// script
# dependencies = ["pydantic>=2.0"]
# ///
"""
ETL Pipeline — Extract, transform, load with validation.

Demonstrates: sequence of dependent tasks, conditional logic.
"""
from pydantic import BaseModel
from smithers import workflow, task, sequence, Agent, run


class TableInfo(BaseModel):
    name: str
    row_count: int
    key_fields: list[str]


class Extract(BaseModel):
    tables: list[TableInfo]
    total_rows: int


class Transform(BaseModel):
    record_count: int
    transformations: list[str]
    warnings: list[str]


class Load(BaseModel):
    records_loaded: int
    status: str
    issues: list[str]


claude = Agent("claude")


def build(ctx):
    source = ctx.input.get("source", "database")
    destination = ctx.input.get("destination", "warehouse")
    extract_result = ctx.output_maybe(Extract, "extract")
    transform_result = ctx.output_maybe(Transform, "transform")

    children = [
        task("extract", output=Extract, agent=claude,
             prompt=f"Extract data from {source}. List tables, row counts, key fields."),
    ]

    if extract_result is not None:
        tables = extract_result.get("tables", [])
        children.append(
            task("transform", output=Transform, agent=claude, depends_on=["extract"],
                 prompt=(
                     f"Transform extracted data.\n"
                     f"Tables: {', '.join(t.get('name', '?') for t in tables)}\n"
                     f"Apply: dedup, null handling, normalization."
                 )),
        )

    if transform_result is not None:
        children.append(
            task("load", output=Load, agent=claude, depends_on=["transform"],
                 prompt=(
                     f"Load into {destination}.\n"
                     f"Records: {transform_result.get('recordCount', 0)}\n"
                     f"Validate schema compatibility."
                 )),
        )

    return workflow("etl-pipeline", sequence(*children))


if __name__ == "__main__":
    run(build, outputs=[Extract, Transform, Load])

"""Context wrapper that mirrors SmithersCtx for Python workflows."""

from __future__ import annotations
from typing import Any

from smithers.nodes import _to_snake


class Ctx:
    """Provides access to workflow state: run metadata, input, and task outputs.

    Mirrors the TS SmithersCtx interface, operating on a pre-loaded OutputSnapshot.
    Table arguments accept either a string key or a Pydantic BaseModel class.
    """

    def __init__(self, data: dict[str, Any]) -> None:
        self.run_id: str = data.get("runId", "")
        self.iteration: int = data.get("iteration", 0)
        self.iterations: dict[str, int] = data.get("iterations", {})
        self.input: Any = data.get("input", {})
        self._outputs: dict[str, list[dict]] = data.get("outputs", {})

    @staticmethod
    def _resolve_table(table: Any) -> str:
        if isinstance(table, str):
            return table
        if isinstance(table, type) and hasattr(table, "model_json_schema"):
            return _to_snake(table.__name__)
        return str(table)

    def outputs(self, table: Any) -> list[dict]:
        """Get all output rows for a table. Accepts BaseModel class or str."""
        return self._outputs.get(self._resolve_table(table), [])

    def output(self, table: Any, node_id: str, *, iteration: int | None = None) -> dict:
        """Get a specific output row. Raises KeyError if not found."""
        table_name = self._resolve_table(table)
        it = iteration if iteration is not None else self.iteration
        for row in self._outputs.get(table_name, []):
            if row.get("nodeId") == node_id and row.get("iteration", 0) == it:
                return row
        raise KeyError(
            f"No output for table={table_name!r}, nodeId={node_id!r}, iteration={it}"
        )

    def output_maybe(self, table: Any, node_id: str, *, iteration: int | None = None) -> dict | None:
        """Get a specific output row, or None if not found."""
        try:
            return self.output(table, node_id, iteration=iteration)
        except KeyError:
            return None

    def latest(self, table: Any, node_id: str) -> dict | None:
        """Get the output row with the highest iteration for a given nodeId."""
        table_name = self._resolve_table(table)
        rows = self._outputs.get(table_name, [])
        matching = [r for r in rows if r.get("nodeId") == node_id]
        if not matching:
            return None
        return max(matching, key=lambda r: r.get("iteration", 0))

    def iteration_count(self, table: Any, node_id: str) -> int:
        """Count distinct iterations for a given nodeId in a table."""
        table_name = self._resolve_table(table)
        rows = self._outputs.get(table_name, [])
        iterations = {r.get("iteration", 0) for r in rows if r.get("nodeId") == node_id}
        return len(iterations)

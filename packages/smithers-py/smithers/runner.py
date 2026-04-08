"""Stdin/stdout protocol handler for Smithers Python workflows."""

from __future__ import annotations
import json
import sys
from typing import Callable, Any

from smithers.nodes import _to_snake


def run(
    build_fn: Callable[[Any], dict[str, Any]],
    outputs: list[type] | None = None,
    schemas: dict[str, type] | None = None,
) -> None:
    """Read serialized ctx from stdin, call build_fn, write HostNode JSON to stdout.

    outputs: list of Pydantic BaseModel classes (preferred).
    schemas: dict of name → BaseModel class (backward compat).

    If --schemas is in argv, outputs JSON Schema definitions and exits.
    """
    if "--schemas" in sys.argv and (outputs or schemas):
        resolved: dict[str, Any] = {}
        if outputs:
            for model in outputs:
                if not hasattr(model, "model_json_schema"):
                    raise TypeError(
                        f"{model.__name__} is not a Pydantic BaseModel "
                        f"(missing model_json_schema)"
                    )
                resolved[_to_snake(model.__name__)] = model.model_json_schema()
        elif schemas:
            for name, model in schemas.items():
                if not hasattr(model, "model_json_schema"):
                    raise TypeError(
                        f"Schema '{name}' is not a Pydantic BaseModel "
                        f"(missing model_json_schema). Got: {type(model).__name__}"
                    )
                resolved[name] = model.model_json_schema()
        json.dump(resolved, sys.stdout, separators=(",", ":"))
        sys.stdout.flush()
        return

    from smithers.ctx import Ctx

    raw = sys.stdin.read()
    ctx_data = json.loads(raw)
    ctx = Ctx(ctx_data)
    tree = build_fn(ctx)
    json.dump(tree, sys.stdout, separators=(",", ":"))
    sys.stdout.flush()

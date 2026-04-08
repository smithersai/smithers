"""Builder functions that produce HostNode JSON trees for Smithers workflows."""

from __future__ import annotations
import re
from typing import Any


def _to_snake(name: str) -> str:
    """Convert PascalCase to snake_case."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _resolve_output(output: Any) -> str:
    """Resolve output to a string key. Accepts BaseModel class or str."""
    if isinstance(output, str):
        return output
    if isinstance(output, type) and hasattr(output, "model_json_schema"):
        return _to_snake(output.__name__)
    raise TypeError(
        f"output must be a Pydantic BaseModel class or str, got {type(output).__name__}"
    )


class Agent:
    """Typed reference to a TS-side agent. Use instead of bare strings."""

    def __init__(self, name: str) -> None:
        self.name = name

    def __repr__(self) -> str:
        return f"Agent({self.name!r})"


def _element(tag: str, raw_props: dict[str, Any], children: list[Any] | None = None) -> dict:
    """Create a HostElement JSON node."""
    props: dict[str, str] = {}
    for k, v in raw_props.items():
        if isinstance(v, (str, int, float, bool)):
            props[k] = str(v)
    return {
        "kind": "element",
        "tag": tag,
        "props": props,
        "rawProps": raw_props,
        "children": children or [],
    }


def text(t: str) -> dict:
    """Create a HostText JSON node."""
    return {"kind": "text", "text": t}


def workflow(name: str, *children: dict) -> dict:
    """Create a smithers:workflow node."""
    return _element("smithers:workflow", {"name": name}, list(children))


def task(
    id: str,
    *,
    output: Any,
    agent: Agent | str | None = None,
    prompt: str | None = None,
    payload: Any = None,
    depends_on: list[str] | None = None,
    needs: dict[str, str] | None = None,
    retries: int = 0,
    timeout_ms: int | None = None,
    skip_if: bool = False,
    continue_on_fail: bool = False,
    needs_approval: bool = False,
    label: str | None = None,
    meta: dict[str, Any] | None = None,
) -> dict:
    """Create a smithers:task node.

    output: Pydantic BaseModel class or string key.
    agent: Agent("name"), bare string, or None.

    Three modes:
    - agent mode: set agent= and prompt=
    - static mode: set payload=
    - compute mode: not supported from Python (use agent or static)
    """
    output_key = _resolve_output(output)
    raw_props: dict[str, Any] = {"id": id, "output": output_key}

    # Resolve agent
    agent_name: str | None = None
    if isinstance(agent, Agent):
        agent_name = agent.name
    elif isinstance(agent, str):
        agent_name = agent
    elif agent is not None:
        raise TypeError(f"agent must be Agent, str, or None, got {type(agent).__name__}")

    if agent_name is not None:
        raw_props["agent"] = agent_name
        raw_props["__smithersKind"] = "agent"
    elif payload is not None:
        raw_props["__smithersKind"] = "static"
        raw_props["__smithersPayload"] = payload
    else:
        raw_props["__smithersKind"] = "static"
        raw_props["__smithersPayload"] = {}

    if retries:
        raw_props["retries"] = retries
    if timeout_ms is not None:
        raw_props["timeoutMs"] = timeout_ms
    if skip_if:
        raw_props["skipIf"] = True
    if continue_on_fail:
        raw_props["continueOnFail"] = True
    if needs_approval:
        raw_props["needsApproval"] = True
    if depends_on:
        raw_props["dependsOn"] = depends_on
    if needs:
        raw_props["needs"] = needs
    if label:
        raw_props["label"] = label
    if meta:
        raw_props["meta"] = meta

    children: list[dict] = []
    if prompt is not None:
        children.append(text(prompt))

    return _element("smithers:task", raw_props, children)


def sequence(*children: dict) -> dict:
    """Create a smithers:sequence node."""
    return _element("smithers:sequence", {}, list(children))


def parallel(*children: dict, max_concurrency: int | None = None) -> dict:
    """Create a smithers:parallel node."""
    raw_props: dict[str, Any] = {}
    if max_concurrency is not None:
        raw_props["maxConcurrency"] = max_concurrency
    return _element("smithers:parallel", raw_props, list(children))


def loop(
    id: str,
    *,
    until: bool,
    children: list[dict] | dict,
    max_iterations: int | None = None,
    on_max_reached: str = "return-last",
) -> dict:
    """Create a smithers:ralph (loop) node."""
    raw_props: dict[str, Any] = {
        "id": id,
        "until": until,
    }
    if max_iterations is not None:
        raw_props["maxIterations"] = max_iterations
    raw_props["onMaxReached"] = on_max_reached

    child_list = children if isinstance(children, list) else [children]
    return _element("smithers:ralph", raw_props, child_list)


def branch(
    condition: bool,
    then: dict | None = None,
    otherwise: dict | None = None,
) -> dict:
    """Conditional rendering — returns then or otherwise based on condition."""
    if condition:
        return then if then is not None else _element("smithers:sequence", {}, [])
    return otherwise if otherwise is not None else _element("smithers:sequence", {}, [])

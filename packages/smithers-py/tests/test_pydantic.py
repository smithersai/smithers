"""Tests for Pydantic schema integration."""

import json
import sys
from io import StringIO
from unittest.mock import patch

from pydantic import BaseModel


class Research(BaseModel):
    summary: str
    key_points: list[str]
    confidence: float


class Article(BaseModel):
    content: str
    word_count: int
    notes: str | None = None


def test_schema_discovery_with_outputs_list():
    """outputs=[Research, Article] exports JSON Schema keyed by snake_cased class name."""
    from smithers.runner import run

    captured = StringIO()
    with patch.object(sys, "argv", ["script.py", "--schemas"]):
        with patch.object(sys, "stdout", captured):
            run(lambda ctx: {}, outputs=[Research, Article])

    output = json.loads(captured.getvalue())
    assert "research" in output
    assert "article" in output

    research = output["research"]
    assert research["type"] == "object"
    assert research["properties"]["summary"]["type"] == "string"
    assert research["properties"]["key_points"]["type"] == "array"

    article = output["article"]
    notes = article["properties"]["notes"]
    assert "anyOf" in notes
    null_types = [v.get("type") for v in notes["anyOf"]]
    assert "null" in null_types


def test_schema_discovery_backward_compat_dict():
    """schemas={...} dict still works for backward compat."""
    from smithers.runner import run

    captured = StringIO()
    with patch.object(sys, "argv", ["script.py", "--schemas"]):
        with patch.object(sys, "stdout", captured):
            run(lambda ctx: {}, schemas={"research": Research})

    output = json.loads(captured.getvalue())
    assert "research" in output


def test_schema_discovery_with_nested_model():
    class Author(BaseModel):
        name: str
        email: str

    class Report(BaseModel):
        title: str
        author: Author

    from smithers.runner import run

    captured = StringIO()
    with patch.object(sys, "argv", ["script.py", "--schemas"]):
        with patch.object(sys, "stdout", captured):
            run(lambda ctx: {}, outputs=[Report])

    output = json.loads(captured.getvalue())
    report = output["report"]
    assert "$defs" in report
    assert "Author" in report["$defs"]


def test_normal_mode_unchanged():
    from smithers.runner import run
    from smithers.nodes import workflow, task

    ctx_json = json.dumps({
        "runId": "test", "iteration": 0, "iterations": {},
        "input": {"topic": "test"}, "outputs": {},
    })

    captured = StringIO()
    with patch.object(sys, "argv", ["script.py"]):
        with patch.object(sys, "stdin", StringIO(ctx_json)):
            with patch.object(sys, "stdout", captured):
                run(
                    lambda ctx: workflow("test", task("t1", output=Research, payload={"v": 1})),
                    outputs=[Research],
                )

    output = json.loads(captured.getvalue())
    assert output["tag"] == "smithers:workflow"
    # output key derived from Research → "research"
    assert output["children"][0]["rawProps"]["output"] == "research"


def test_task_with_model_output():
    """task(output=Research) resolves to 'research' string key."""
    from smithers.nodes import task

    node = task("t1", output=Research, payload={"summary": "hi", "key_points": []})
    assert node["rawProps"]["output"] == "research"


def test_ctx_with_model_class():
    """Ctx methods accept BaseModel class as table arg."""
    from smithers.ctx import Ctx

    ctx = Ctx({
        "runId": "test", "iteration": 0, "iterations": {},
        "input": {}, "outputs": {
            "research": [{"nodeId": "r1", "iteration": 0, "summary": "hi"}],
        },
    })
    row = ctx.output_maybe(Research, "r1")
    assert row is not None
    assert row["summary"] == "hi"

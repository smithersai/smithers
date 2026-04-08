"""Tests for smithers node builder functions."""

import pytest
from smithers.nodes import workflow, task, sequence, parallel, loop, text, Agent, _to_snake


# --- Pydantic model stubs (for testing without requiring pydantic at import) ---

class FakeModel:
    """Minimal stub that quacks like a Pydantic BaseModel for output resolution."""
    __name__ = "FakeModel"
    @classmethod
    def model_json_schema(cls):
        return {"type": "object", "properties": {}}


class MyAnalysis(FakeModel):
    __name__ = "MyAnalysis"


class KeyPoints(FakeModel):
    __name__ = "KeyPoints"


# --- _to_snake ---

def test_to_snake():
    assert _to_snake("Research") == "research"
    assert _to_snake("KeyPoints") == "key_points"
    assert _to_snake("MyAnalysis") == "my_analysis"
    assert _to_snake("ETLResult") == "e_t_l_result"
    assert _to_snake("A") == "a"


# --- Agent ---

def test_agent():
    a = Agent("claude")
    assert a.name == "claude"
    assert repr(a) == "Agent('claude')"


# --- task with string output (backward compat) ---

def test_task_string_output():
    node = task("t1", output="analysis", agent="claude", prompt="Analyze this")
    assert node["rawProps"]["output"] == "analysis"
    assert node["rawProps"]["agent"] == "claude"


# --- task with model class output ---

def test_task_model_output():
    node = task("t1", output=MyAnalysis, agent=Agent("claude"), prompt="Analyze")
    assert node["rawProps"]["output"] == "my_analysis"
    assert node["rawProps"]["agent"] == "claude"
    assert node["rawProps"]["__smithersKind"] == "agent"
    assert node["children"] == [{"kind": "text", "text": "Analyze"}]


def test_task_model_output_static():
    node = task("t1", output=KeyPoints, payload={"v": 1})
    assert node["rawProps"]["output"] == "key_points"
    assert node["rawProps"]["__smithersPayload"] == {"v": 1}


def test_task_agent_sentinel():
    """Agent sentinel serializes to string."""
    a = Agent("researcher")
    node = task("t1", output="out", agent=a, prompt="go")
    assert node["rawProps"]["agent"] == "researcher"


def test_task_bad_output_type():
    with pytest.raises(TypeError, match="Pydantic BaseModel class or str"):
        task("t1", output=123)


def test_task_bad_agent_type():
    with pytest.raises(TypeError, match="Agent, str, or None"):
        task("t1", output="out", agent=123)


# --- task with options ---

def test_task_with_options():
    node = task(
        "t1",
        output="out",
        payload={"v": 1},
        retries=3,
        timeout_ms=5000,
        skip_if=True,
        continue_on_fail=True,
        depends_on=["other"],
        needs={"dep": "other"},
        label="My Task",
        meta={"key": "val"},
    )
    assert node["rawProps"]["retries"] == 3
    assert node["rawProps"]["timeoutMs"] == 5000
    assert node["rawProps"]["skipIf"] is True


# --- workflow, sequence, parallel, loop ---

def test_workflow():
    node = workflow("my-wf", task("t1", output="out", payload={"v": 1}))
    assert node["tag"] == "smithers:workflow"
    assert len(node["children"]) == 1


def test_sequence():
    node = sequence(
        task("a", output="outA", payload={"v": 1}),
        task("b", output="outB", payload={"v": 2}),
    )
    assert node["tag"] == "smithers:sequence"
    assert len(node["children"]) == 2


def test_parallel():
    node = parallel(
        task("a", output="outA", payload={"v": 1}),
        task("b", output="outB", payload={"v": 2}),
        max_concurrency=2,
    )
    assert node["tag"] == "smithers:parallel"
    assert node["rawProps"]["maxConcurrency"] == 2


def test_loop():
    node = loop(
        "counter",
        until=False,
        max_iterations=5,
        children=task("step", output="out", payload={"v": 0}),
    )
    assert node["tag"] == "smithers:ralph"
    assert node["rawProps"]["until"] is False
    assert node["rawProps"]["maxIterations"] == 5


def test_text():
    node = text("hello world")
    assert node == {"kind": "text", "text": "hello world"}


def test_nested_workflow():
    tree = workflow(
        "complex",
        sequence(
            task("first", output="a", payload={"v": 1}),
            parallel(
                task("p1", output="b", payload={"v": 2}),
                task("p2", output="c", payload={"v": 3}),
            ),
        ),
    )
    assert tree["tag"] == "smithers:workflow"
    seq = tree["children"][0]
    par = seq["children"][1]
    assert par["tag"] == "smithers:parallel"
    assert len(par["children"]) == 2

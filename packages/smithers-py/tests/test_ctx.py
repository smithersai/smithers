"""Tests for the Ctx context wrapper."""

import pytest
from smithers.ctx import Ctx


class Research:
    """Stub that quacks like a Pydantic BaseModel for table resolution."""
    @classmethod
    def model_json_schema(cls):
        return {}


SAMPLE_DATA = {
    "runId": "run-123",
    "iteration": 0,
    "iterations": {"loop1": 2},
    "input": {"topic": "quantum computing"},
    "outputs": {
        "research": [
            {"nodeId": "r1", "iteration": 0, "summary": "first"},
            {"nodeId": "r1", "iteration": 1, "summary": "second"},
            {"nodeId": "r1", "iteration": 2, "summary": "third"},
        ],
        "report": [
            {"nodeId": "w1", "iteration": 0, "content": "final report"},
        ],
    },
}


def test_basic_properties():
    ctx = Ctx(SAMPLE_DATA)
    assert ctx.run_id == "run-123"
    assert ctx.iteration == 0
    assert ctx.input == {"topic": "quantum computing"}


# --- String-based access (backward compat) ---

def test_outputs_string():
    ctx = Ctx(SAMPLE_DATA)
    assert len(ctx.outputs("research")) == 3


def test_output_string():
    ctx = Ctx(SAMPLE_DATA)
    row = ctx.output("research", "r1", iteration=1)
    assert row["summary"] == "second"


def test_output_maybe_string():
    ctx = Ctx(SAMPLE_DATA)
    assert ctx.output_maybe("research", "r1", iteration=99) is None


def test_latest_string():
    ctx = Ctx(SAMPLE_DATA)
    row = ctx.latest("research", "r1")
    assert row is not None
    assert row["summary"] == "third"


def test_iteration_count_string():
    ctx = Ctx(SAMPLE_DATA)
    assert ctx.iteration_count("research", "r1") == 3


# --- Model class-based access ---

def test_outputs_model_class():
    ctx = Ctx(SAMPLE_DATA)
    # Research.__name__ == "Research" → "research"
    assert len(ctx.outputs(Research)) == 3


def test_output_maybe_model_class():
    ctx = Ctx(SAMPLE_DATA)
    row = ctx.output_maybe(Research, "r1")
    assert row is not None
    assert row["summary"] == "first"


def test_latest_model_class():
    ctx = Ctx(SAMPLE_DATA)
    row = ctx.latest(Research, "r1")
    assert row["summary"] == "third"


def test_iteration_count_model_class():
    ctx = Ctx(SAMPLE_DATA)
    assert ctx.iteration_count(Research, "r1") == 3


# --- Edge cases ---

def test_outputs_missing_table():
    ctx = Ctx(SAMPLE_DATA)
    assert ctx.outputs("nonexistent") == []


def test_output_missing_raises():
    ctx = Ctx(SAMPLE_DATA)
    with pytest.raises(KeyError):
        ctx.output("research", "r1", iteration=99)


def test_empty_data():
    ctx = Ctx({})
    assert ctx.run_id == ""
    assert ctx.iteration == 0
    assert ctx.outputs("anything") == []

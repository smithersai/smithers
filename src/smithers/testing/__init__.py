"""Testing utilities for Smithers workflows.

This module provides fake implementations for testing workflows
without making actual API calls.

Example - Fake provider (predefined responses):
    from smithers.testing import FakeLLMProvider, use_runtime

    async def test_my_workflow():
        fake = FakeLLMProvider(responses=[{"result": "test"}])
        with use_runtime(llm=fake):
            result = await my_workflow()
            assert result.result == "test"

Example - Record/Replay (record real calls, replay deterministically):
    from smithers.testing import use_recording, use_replay

    # Record a real run (requires ANTHROPIC_API_KEY)
    async with use_recording("./recordings.db", "my_test_v1"):
        result = await my_workflow()

    # Replay deterministically (no network calls)
    async with use_replay("./recordings.db", "my_test_v1"):
        result = await my_workflow()
"""

from smithers.testing.fakes import (
    FakeLLMCall,
    FakeLLMProvider,
    FakeToolProvider,
    FakeToolResult,
    get_fake_llm_provider,
    use_fake_llm,
    use_fake_llm_async,
    use_runtime,
    use_runtime_async,
)
from smithers.testing.helpers import (
    WorkflowTestCase,
    assert_graph_has_dependency,
    assert_graph_has_nodes,
    assert_graph_is_dag,
    assert_graph_levels,
    assert_workflow_depends_on,
    assert_workflow_produces,
    create_test_graph,
    mock_output,
    workflow_call_count,
)
from smithers.testing.replay import (
    RecordedCall,
    Recording,
    RecordingLLMProvider,
    RecordingStore,
    ReplayLLMProvider,
    get_recording_provider,
    get_replay_provider,
    use_recording,
    use_recording_or_replay,
    use_replay,
    use_replay_provider,
    use_replay_provider_async,
)

# Alias for backward compatibility
patch_claude = use_fake_llm

__all__ = [
    # Fake providers
    "FakeLLMCall",
    "FakeLLMProvider",
    "FakeToolProvider",
    "FakeToolResult",
    "get_fake_llm_provider",
    "patch_claude",
    "use_fake_llm",
    "use_fake_llm_async",
    "use_runtime",
    "use_runtime_async",
    # Record/Replay
    "RecordedCall",
    "Recording",
    "RecordingLLMProvider",
    "RecordingStore",
    "ReplayLLMProvider",
    "get_recording_provider",
    "get_replay_provider",
    "use_recording",
    "use_recording_or_replay",
    "use_replay",
    "use_replay_provider",
    "use_replay_provider_async",
    # Test helpers
    "WorkflowTestCase",
    "assert_graph_has_dependency",
    "assert_graph_has_nodes",
    "assert_graph_is_dag",
    "assert_graph_levels",
    "assert_workflow_depends_on",
    "assert_workflow_produces",
    "create_test_graph",
    "mock_output",
    "workflow_call_count",
]

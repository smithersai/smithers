"""Fake agent adapter for deterministic testing."""

import asyncio
from collections.abc import AsyncGenerator, Callable
from typing import Any

from agentd.adapters.base import AgentAdapter, Message, ToolSpec
from agentd.protocol.events import Event, EventType


class FakeAgentAdapter(AgentAdapter):
    """
    Fake adapter that returns scripted responses.

    Used for:
    - UI development without API costs
    - Integration tests
    - Golden event log fixtures
    """

    def __init__(self, script: list[dict[str, Any]] | None = None):
        self.script = script or self._default_script()
        self._cancelled = False

    def _default_script(self) -> list[dict[str, Any]]:
        """Default script for demo purposes."""
        return [
            {"type": "assistant.delta", "text": "I'll help you with that. "},
            {"type": "assistant.delta", "text": "Let me analyze the code..."},
            {
                "type": "tool.start",
                "tool_use_id": "t1",
                "name": "Read",
                "input": {"path": "/src/main.py"},
            },
            {"type": "tool.end", "tool_use_id": "t1", "status": "success"},
            {"type": "assistant.delta", "text": "\n\nI found the issue."},
            {"type": "assistant.final", "message_id": "m1"},
        ]

    async def run(
        self,
        messages: list[Message],
        tools: list[ToolSpec],
        emit: Callable[[Event], None],
    ) -> AsyncGenerator[Event, None]:
        """Execute the scripted response."""
        self._cancelled = False

        # Track accumulated text for ASSISTANT_FINAL
        accumulated_text = ""

        for item in self.script:
            if self._cancelled:
                break

            event_type = EventType(item["type"])
            data = {k: v for k, v in item.items() if k != "type"}

            # Track assistant deltas
            if event_type == EventType.ASSISTANT_DELTA:
                accumulated_text += data.get("text", "")

            # Add accumulated text to ASSISTANT_FINAL
            if event_type == EventType.ASSISTANT_FINAL:
                data["text"] = accumulated_text

            event = Event(type=event_type, data=data)

            emit(event)
            yield event

            # Simulate realistic timing
            await asyncio.sleep(0.05)

    async def cancel(self) -> None:
        """Cancel the scripted run."""
        self._cancelled = True

"""Anthropic API adapter using raw anthropic client."""

from typing import Any, AsyncIterator, Callable

from agentd.adapters.base import AgentAdapter, Message, ToolSpec
from agentd.protocol.events import Event, EventType

try:
    import anthropic

    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False


class AnthropicAgentAdapter(AgentAdapter):
    """
    Adapter using the raw Anthropic API client.

    Translates Anthropic stream events into our internal Event types.
    """

    def __init__(self, model: str = "claude-sonnet-4-20250514"):
        if not HAS_ANTHROPIC:
            raise ImportError("anthropic package not installed")

        self.model = model
        self.client = anthropic.AsyncAnthropic()
        self._current_stream = None

    async def run(
        self,
        messages: list[Message],
        tools: list[ToolSpec],
        emit: Callable[[Event], None],
    ) -> AsyncIterator[Event]:
        """Run the agent using Anthropic streaming API."""

        # Convert tools to Anthropic format
        anthropic_tools = self._convert_tools(tools)

        async with self.client.messages.stream(
            model=self.model,
            max_tokens=8192,
            messages=messages,
            tools=anthropic_tools if anthropic_tools else anthropic.NOT_GIVEN,
        ) as stream:
            self._current_stream = stream

            current_tool_use = None

            async for event in stream:
                match event.type:
                    case "content_block_start":
                        if hasattr(event.content_block, "type"):
                            if event.content_block.type == "tool_use":
                                current_tool_use = event.content_block
                                ev = Event(
                                    type=EventType.TOOL_START,
                                    data={
                                        "tool_use_id": current_tool_use.id,
                                        "name": current_tool_use.name,
                                        "input": {},
                                    },
                                )
                                emit(ev)
                                yield ev

                    case "content_block_delta":
                        if hasattr(event.delta, "text"):
                            ev = Event(
                                type=EventType.ASSISTANT_DELTA, data={"text": event.delta.text}
                            )
                            emit(ev)
                            yield ev

                    case "content_block_stop":
                        if current_tool_use:
                            ev = Event(
                                type=EventType.TOOL_END,
                                data={"tool_use_id": current_tool_use.id, "status": "success"},
                            )
                            emit(ev)
                            yield ev
                            current_tool_use = None

                    case "message_stop":
                        ev = Event(
                            type=EventType.ASSISTANT_FINAL,
                            data={"message_id": stream.current_message_snapshot.id},
                        )
                        emit(ev)
                        yield ev

    async def cancel(self) -> None:
        """Cancel the current stream."""
        if self._current_stream:
            # Anthropic doesn't have explicit cancel, but we can stop iteration
            self._current_stream = None

    def _convert_tools(self, tools: list[ToolSpec]) -> list[dict[str, Any]]:
        """Convert internal tool format to Anthropic format."""
        return [
            {
                "name": t["name"],
                "description": t.get("description", ""),
                "input_schema": t.get("input_schema", {"type": "object", "properties": {}}),
            }
            for t in tools
        ]

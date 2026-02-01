"""Anthropic API adapter using raw anthropic client."""
# pyright: reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false

from collections.abc import AsyncGenerator, Callable
from typing import TYPE_CHECKING, Any

from agentd.adapters.base import AgentAdapter, Message, ToolSpec
from agentd.protocol.events import Event, EventType

if TYPE_CHECKING:
    import anthropic

HAS_ANTHROPIC = False
anthropic: Any = None

try:
    import anthropic as _anthropic

    HAS_ANTHROPIC = True  # pyright: ignore[reportConstantRedefinition]
    anthropic = _anthropic
except ImportError:
    pass


class AnthropicAgentAdapter(AgentAdapter):
    """
    Adapter using the raw Anthropic API client.

    Translates Anthropic stream events into our internal Event types.
    """

    def __init__(self, model: str = "claude-sonnet-4-20250514"):
        if not HAS_ANTHROPIC or anthropic is None:
            raise ImportError("anthropic package not installed")

        self.model = model
        self.client = anthropic.AsyncAnthropic()
        self._current_stream: Any = None

    async def run(
        self,
        messages: list[Message],
        tools: list[ToolSpec],
        emit: Callable[[Event], None],
    ) -> AsyncGenerator[Event, None]:
        """Run the agent using Anthropic streaming API."""
        if anthropic is None:
            raise ImportError("anthropic package not installed")

        # Convert tools to Anthropic format
        anthropic_tools = self._convert_tools(tools)

        # Convert messages to proper Anthropic format
        anthropic_messages: list[Any] = [
            {"role": msg["role"], "content": msg["content"]} for msg in messages
        ]

        async with self.client.messages.stream(
            model=self.model,
            max_tokens=8192,
            messages=anthropic_messages,  # type: ignore[arg-type]
            tools=anthropic_tools if anthropic_tools else anthropic.NOT_GIVEN,  # type: ignore[arg-type]
        ) as stream:
            self._current_stream = stream

            current_tool_use = None
            accumulated_text = ""  # Track full assistant response
            tool_input_buffer = ""  # Track accumulated tool input JSON

            async for event in stream:
                event_type = getattr(event, "type", None)
                match event_type:
                    case "content_block_start":
                        if (
                            hasattr(event, "content_block")
                            and hasattr(event.content_block, "type")
                            and event.content_block.type == "tool_use"
                        ):
                            current_tool_use = event.content_block
                            tool_input_buffer = ""  # Reset buffer for new tool

                    case "content_block_delta":
                        # Handle text deltas
                        if hasattr(event, "delta") and hasattr(event.delta, "text"):
                            text = getattr(event.delta, "text", "")
                            accumulated_text += text  # Accumulate text
                            ev = Event(type=EventType.ASSISTANT_DELTA, data={"text": text})
                            emit(ev)
                            yield ev
                        # Handle tool input JSON deltas
                        elif (
                            current_tool_use
                            and hasattr(event, "delta")
                            and hasattr(event.delta, "type")
                            and event.delta.type == "input_json_delta"
                        ):
                            partial_json = getattr(event.delta, "partial_json", "")
                            tool_input_buffer += partial_json

                    case "content_block_stop":
                        if current_tool_use:
                            # Parse the accumulated JSON input
                            import json

                            tool_input = {}
                            if tool_input_buffer:
                                try:
                                    tool_input = json.loads(tool_input_buffer)
                                except json.JSONDecodeError:
                                    # Fall back to empty input if parsing fails
                                    tool_input = {}

                            # Emit TOOL_START with complete input
                            ev_start = Event(
                                type=EventType.TOOL_START,
                                data={
                                    "tool_use_id": current_tool_use.id,
                                    "name": current_tool_use.name,
                                    "input": tool_input,
                                },
                            )
                            emit(ev_start)
                            yield ev_start

                            # Emit TOOL_END
                            ev_end = Event(
                                type=EventType.TOOL_END,
                                data={"tool_use_id": current_tool_use.id, "status": "success"},
                            )
                            emit(ev_end)
                            yield ev_end

                            current_tool_use = None
                            tool_input_buffer = ""

                    case "message_stop":
                        ev = Event(
                            type=EventType.ASSISTANT_FINAL,
                            data={
                                "message_id": stream.current_message_snapshot.id,
                                "text": accumulated_text,  # Include full text
                            },
                        )
                        emit(ev)
                        yield ev
                    case _:
                        # Ignore other event types
                        pass

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

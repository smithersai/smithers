"""Claude LLM integration with automatic call tracking and rate limiting.

This module provides the claude() function for calling the Claude API
with automatic tracking of LLM calls when running within a workflow graph.

When a RuntimeContext is active (set by the ExecutionEngine), all calls
to claude() are automatically recorded to SQLite for observability.

Rate limiting is automatically applied when a rate limiter is configured
via set_rate_limiter() or configure_claude_rate_limits().
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, TypeVar

from anthropic import AsyncAnthropic
from pydantic import BaseModel, TypeAdapter

from smithers.analytics import calculate_cost
from smithers.config import get_config
from smithers.errors import ClaudeError, RateLimitError, ToolError
from smithers.ratelimit import get_rate_limiter
from smithers.runtime import (
    record_llm_call_end,
    record_llm_call_start,
    record_tool_call_end,
    record_tool_call_start,
)
from smithers.tools import get_tool

T = TypeVar("T", bound=BaseModel)


@dataclass
class Usage:
    """Token usage information for a Claude call."""

    input_tokens: int
    output_tokens: int
    cost_usd: float | None = None


@dataclass
class ClaudeStreamChunk:
    """Streaming chunk from claude.stream."""

    partial: str | None
    final: Any


async def claude(
    prompt: str,
    *,
    output: type[T],
    tools: list[str] | None = None,
    system: str | None = None,
    max_turns: int = 10,
    model: str | None = None,
    track_usage: bool = False,
) -> T:
    """
    Call Claude with a prompt and get structured output.

    Args:
        prompt: The prompt to send to Claude
        output: Pydantic model class for structured output
        tools: List of tool names Claude can use (e.g., ["Read", "Edit", "Bash"])
        system: Optional system prompt
        max_turns: Maximum number of tool-use turns
        model: Claude model to use
        track_usage: Attach token usage info to the result

    If a FakeLLMProvider is active (via use_fake_llm context manager),
    it will be used instead of calling the real Claude API.
    """
    config = get_config()
    model_name = model or config.model

    # Apply rate limiting before anything else (including fake providers)
    # This ensures tests can verify rate limiting behavior
    rate_limiter = get_rate_limiter(model_name)
    if rate_limiter is not None:
        await rate_limiter.acquire()

    # Check for fake provider (for testing)
    from smithers.testing.fakes import get_fake_llm_provider

    fake_provider = get_fake_llm_provider()
    if fake_provider is not None:
        return fake_provider.next_response(prompt, output, tools, system)
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ClaudeError("ANTHROPIC_API_KEY is not set")

    client = AsyncAnthropic(api_key=api_key)

    tool_specs = []
    if tools:
        for tool_name in tools:
            spec = get_tool(tool_name)
            if spec is None:
                raise ClaudeError(f"Unknown tool: {tool_name}")
            tool_specs.append(spec)

    system_prompt = _build_system_prompt(system, output)
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    usage_info: Usage | None = None
    total_input_tokens = 0
    total_output_tokens = 0

    # Record LLM call start (if runtime context is active)
    llm_call_id = await record_llm_call_start(
        model=model_name,
        request={
            "prompt": prompt,
            "system": system,
            "tools": tools,
            "output_type": output.__name__,
            "max_turns": max_turns,
        },
    )

    try:
        for _ in range(max_turns):
            try:
                # Build API call kwargs
                create_kwargs: dict[str, Any] = {
                    "model": model_name,
                    "max_tokens": 1024,
                    "system": system_prompt,
                    "messages": messages,
                }
                if tool_specs:
                    create_kwargs["tools"] = [spec.schema() for spec in tool_specs]
                response = await client.messages.create(**create_kwargs)  # type: ignore[arg-type]
            except Exception as exc:
                if exc.__class__.__name__ == "RateLimitError":
                    raise RateLimitError(cause=exc) from exc
                raise ClaudeError("Claude API error", cause=exc) from exc

            usage_info = _extract_usage(response)
            if usage_info:
                total_input_tokens += usage_info.input_tokens
                total_output_tokens += usage_info.output_tokens

            content_blocks = _normalize_content(response.content)
            tool_uses = [block for block in content_blocks if block["type"] == "tool_use"]

            if not tool_uses:
                text = _extract_text(content_blocks)
                result = _parse_output(text, output)

                # Calculate cost using analytics module
                cost = calculate_cost(model_name, total_input_tokens, total_output_tokens)

                if track_usage and usage_info is not None:
                    # Include cost in usage info
                    usage_with_cost = Usage(
                        input_tokens=total_input_tokens,
                        output_tokens=total_output_tokens,
                        cost_usd=cost,
                    )
                    object.__setattr__(result, "_usage", usage_with_cost)

                # Record LLM call completion with cost
                await record_llm_call_end(
                    llm_call_id,
                    input_tokens=total_input_tokens,
                    output_tokens=total_output_tokens,
                    cost_usd=cost,
                    response={"output_type": output.__name__, "success": True},
                )
                return result

            messages.append({"role": "assistant", "content": content_blocks})
            tool_results = []
            for tool_use in tool_uses:
                tool_name = tool_use["name"]
                tool_id = tool_use.get("id") or tool_use.get("tool_use_id")
                tool_input = tool_use.get("input", {})
                spec = get_tool(tool_name)
                if spec is None:
                    raise ClaudeError(f"Tool not registered: {tool_name}")

                # Record tool call start
                tool_call_id = await record_tool_call_start(tool_name, tool_input)

                try:
                    result = await spec.invoke(tool_input)
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": json.dumps(result, default=str),
                        }
                    )
                    # Record tool call success
                    await record_tool_call_end(tool_call_id, output=result)
                except ToolError as exc:
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": str(exc),
                            "is_error": True,
                        }
                    )
                    # Record tool call failure
                    await record_tool_call_end(tool_call_id, error=exc)

            messages.append({"role": "user", "content": tool_results})

        # Max turns exceeded - record as failure
        await record_llm_call_end(
            llm_call_id,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            response={"error": "Max turns exceeded"},
        )
        raise ClaudeError("Max turns exceeded")

    except Exception as exc:
        # Record any unhandled errors
        if llm_call_id is not None:
            await record_llm_call_end(
                llm_call_id,
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                response={"error": str(exc), "error_type": type(exc).__name__},
            )
        raise


async def _stream(
    prompt: str,
    *,
    output: type[T],
    tools: list[str] | None = None,
    system: str | None = None,
    max_turns: int = 10,
    model: str | None = None,
    track_usage: bool = False,
) -> AsyncIterator[ClaudeStreamChunk]:
    result = await claude(
        prompt,
        output=output,
        tools=tools,
        system=system,
        max_turns=max_turns,
        model=model,
        track_usage=track_usage,
    )
    yield ClaudeStreamChunk(partial=None, final=result)


claude.stream = _stream  # type: ignore[attr-defined]


def _build_system_prompt(system: str | None, output: type[BaseModel]) -> str:
    schema = output.model_json_schema()
    json_schema = json.dumps(schema, indent=2)
    base = system or ""
    return (
        f"{base}\n\n"
        "You must respond with JSON that matches this schema:\n"
        f"{json_schema}\n"
        "Respond with JSON only."
    ).strip()


def _normalize_content(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    blocks: list[dict[str, Any]] = []
    for block in content:
        if isinstance(block, dict):
            blocks.append(block)
        else:
            block_type = getattr(block, "type", None)
            if block_type:
                blocks.append(block.__dict__)
            else:
                blocks.append({"type": "text", "text": str(block)})
    return blocks


def _extract_text(blocks: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for block in blocks:
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts).strip()


def _parse_output(text: str, output: type[T]) -> T:
    json_text = _extract_json(text)
    adapter = TypeAdapter(output)
    return adapter.validate_json(json_text)


def _extract_json(text: str) -> str:
    text = text.strip()
    if text.startswith("{") and text.endswith("}"):
        return text
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise ClaudeError("Claude response did not contain JSON")
    return text[start : end + 1]


def _extract_usage(response: Any) -> Usage | None:
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    input_tokens = getattr(usage, "input_tokens", 0) or 0
    output_tokens = getattr(usage, "output_tokens", 0) or 0
    return Usage(input_tokens=input_tokens, output_tokens=output_tokens)

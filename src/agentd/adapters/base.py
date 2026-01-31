"""Base class for agent adapters."""

from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, Callable, TypeAlias

from agentd.protocol.events import Event

Message: TypeAlias = dict[str, Any]
ToolSpec: TypeAlias = dict[str, Any]


class AgentAdapter(ABC):
    """
    Abstract base for agent backends.

    All adapters must translate their native events into
    our internal Event types.
    """

    @abstractmethod
    def run(
        self,
        messages: list[Message],
        tools: list[ToolSpec],
        emit: Callable[[Event], None],
    ) -> AsyncIterator[Event]:
        """
        Run the agent with given messages and tools.

        Yields events as they occur.
        """
        pass

    @abstractmethod
    async def cancel(self) -> None:
        """Cancel the current run."""
        pass

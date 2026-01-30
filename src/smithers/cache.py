"""SQLite-based caching for workflow results."""

from __future__ import annotations

import asyncio
import pickle
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import aiosqlite

from smithers.config import get_config
from smithers.types import CacheStats


class Cache(ABC):
    """Abstract base class for caches."""

    @abstractmethod
    async def get(self, key: str) -> Any | None:
        """Get a cached value by key."""
        ...

    @abstractmethod
    async def set(self, key: str, value: Any) -> None:
        """Set a cached value."""
        ...

    @abstractmethod
    async def has(self, key: str) -> bool:
        """Check if a key exists in the cache."""
        ...

    @abstractmethod
    async def stats(self) -> CacheStats:
        """Get cache statistics."""
        ...


class SqliteCache(Cache):
    """SQLite-based cache for workflow results."""

    def __init__(self, path: str | Path, *, ttl: timedelta | None = None) -> None:
        """
        Initialize SQLite cache.

        Args:
            path: Path to the SQLite database file
        """
        self.path = Path(path)
        self.ttl = ttl
        self._initialized = False
        self._hits = 0
        self._misses = 0
        self._lock = asyncio.Lock()

    @classmethod
    def default(cls) -> SqliteCache:
        """Create a cache using the default location."""
        cache_dir = get_config().cache_dir or (Path.home() / ".smithers")
        default_path = cache_dir / "cache.db"
        return cls(default_path)

    async def _ensure_initialized(self) -> None:
        """Ensure the database is initialized."""
        if self._initialized:
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS cache (
                    key TEXT PRIMARY KEY,
                    value BLOB,
                    created_at TEXT,
                    accessed_at TEXT,
                    workflow_name TEXT,
                    input_hash TEXT
                )
                """
            )
            await db.commit()
        self._initialized = True

    async def get(self, key: str) -> Any | None:
        """Get a cached value by key."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT value, created_at FROM cache WHERE key = ?",
                (key,),
            ) as cursor:
                row = await cursor.fetchone()
            if row is None:
                self._misses += 1
                return None

            created_at = _parse_timestamp(row["created_at"])
            if self._is_expired(created_at):
                await db.execute("DELETE FROM cache WHERE key = ?", (key,))
                await db.commit()
                self._misses += 1
                return None

            await db.execute(
                "UPDATE cache SET accessed_at = ? WHERE key = ?",
                (_timestamp_now(), key),
            )
            await db.commit()

            try:
                value = pickle.loads(row["value"])
            except Exception:
                await db.execute("DELETE FROM cache WHERE key = ?", (key,))
                await db.commit()
                self._misses += 1
                return None

            self._hits += 1
            return value

    async def set(
        self,
        key: str,
        value: Any,
        *,
        workflow_name: str | None = None,
        input_hash: str | None = None,
    ) -> None:
        """Set a cached value."""
        await self._ensure_initialized()
        payload = pickle.dumps(value)
        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    INSERT OR REPLACE INTO cache
                        (key, value, created_at, accessed_at, workflow_name, input_hash)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                (
                    key,
                    payload,
                    _timestamp_now(),
                    _timestamp_now(),
                    workflow_name,
                    input_hash,
                ),
            )
            await db.commit()

    async def has(self, key: str) -> bool:
        """Check if a key exists in the cache."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT created_at FROM cache WHERE key = ?",
                (key,),
            ) as cursor:
                row = await cursor.fetchone()
            if row is None:
                return False
            created_at = _parse_timestamp(row["created_at"])
            if self._is_expired(created_at):
                await db.execute("DELETE FROM cache WHERE key = ?", (key,))
                await db.commit()
                return False
            return True

    async def stats(self) -> CacheStats:
        """Get cache statistics."""
        await self._ensure_initialized()
        async with (
            self._lock,
            aiosqlite.connect(self.path) as db,
            db.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(value)), 0) FROM cache") as cursor,
        ):
            row = await cursor.fetchone()
            entries = int(row[0]) if row else 0
            size_bytes = int(row[1]) if row else 0
        return CacheStats(
            entries=entries,
            hits=self._hits,
            misses=self._misses,
            size_bytes=size_bytes,
        )

    async def list(self) -> list[CacheEntry]:
        """List cache entries."""
        await self._ensure_initialized()
        async with self._lock:  # noqa: SIM117
            async with aiosqlite.connect(self.path) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute(
                    "SELECT key, workflow_name, created_at, accessed_at, input_hash, LENGTH(value) as size "
                    "FROM cache"
                ) as cursor:
                    rows = await cursor.fetchall()
        entries: list[CacheEntry] = []
        for row in rows:
            entries.append(
                CacheEntry(
                    key=row["key"],
                    workflow_name=row["workflow_name"],
                    created_at=_parse_timestamp(row["created_at"]),
                    accessed_at=_parse_timestamp(row["accessed_at"]),
                    input_hash=row["input_hash"],
                    size_bytes=int(row["size"]),
                )
            )
        return entries

    async def clear(
        self,
        *,
        workflow: str | None = None,
        older_than: timedelta | None = None,
    ) -> None:
        """Clear cached values."""
        await self._ensure_initialized()
        clauses: list[str] = []
        params: list[Any] = []
        if workflow is not None:
            clauses.append("workflow_name = ?")
            params.append(workflow)
        if older_than is not None:
            cutoff = datetime.now(UTC) - older_than
            clauses.append("created_at < ?")
            params.append(cutoff.isoformat())

        query = "DELETE FROM cache"
        if clauses:
            query += " WHERE " + " AND ".join(clauses)

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(query, params)
            await db.commit()

    def _is_expired(self, created_at: datetime | None) -> bool:
        if self.ttl is None or created_at is None:
            return False
        # Ensure created_at is timezone-aware for comparison
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        return datetime.now(UTC) - created_at > self.ttl


@dataclass
class CacheEntry:
    """Representation of a cache entry."""

    key: str
    workflow_name: str | None
    created_at: datetime | None
    accessed_at: datetime | None
    input_hash: str | None
    size_bytes: int


def _timestamp_now() -> str:
    return datetime.now(UTC).isoformat()


def _parse_timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None

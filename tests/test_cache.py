"""Tests for SqliteCache."""

from datetime import timedelta
from pathlib import Path

from pydantic import BaseModel

from smithers import SqliteCache, build_graph, claude, run_graph, workflow
from smithers.testing import FakeLLMProvider, use_fake_llm


class OutputModel(BaseModel):
    value: str


class TestSqliteCache:
    """Tests for SqliteCache operations."""

    async def test_cache_set_and_get(self, tmp_path: Path):
        cache = SqliteCache(tmp_path / "test.db")

        await cache.set("key1", {"data": "value"})
        result = await cache.get("key1")

        assert result == {"data": "value"}

    async def test_cache_miss_returns_none(self, tmp_path: Path):
        cache = SqliteCache(tmp_path / "test.db")

        result = await cache.get("nonexistent")

        assert result is None

    async def test_cache_has(self, tmp_path: Path):
        cache = SqliteCache(tmp_path / "test.db")

        assert await cache.has("key1") is False

        await cache.set("key1", "value")

        assert await cache.has("key1") is True

    async def test_cache_stats(self, tmp_path: Path):
        cache = SqliteCache(tmp_path / "test.db")

        # Initial stats
        stats = await cache.stats()
        assert stats.entries == 0
        assert stats.hits == 0
        assert stats.misses == 0

        # After miss
        await cache.get("missing")
        stats = await cache.stats()
        assert stats.misses == 1

        # After set and hit
        await cache.set("key1", "value")
        await cache.get("key1")
        stats = await cache.stats()
        assert stats.entries == 1
        assert stats.hits == 1

    async def test_cache_with_pydantic_model(self, tmp_path: Path):
        cache = SqliteCache(tmp_path / "test.db")
        model = OutputModel(value="test")

        await cache.set("model_key", model)
        result = await cache.get("model_key")

        assert isinstance(result, OutputModel)
        assert result.value == "test"

    async def test_cache_clear(self, tmp_path: Path):
        cache = SqliteCache(tmp_path / "test.db")

        await cache.set("key1", "value1")
        await cache.set("key2", "value2")

        stats = await cache.stats()
        assert stats.entries == 2

        await cache.clear()

        stats = await cache.stats()
        assert stats.entries == 0

    async def test_cache_clear_by_workflow(self, tmp_path: Path):
        cache = SqliteCache(tmp_path / "test.db")

        await cache.set("key1", "value1", workflow_name="wf1")
        await cache.set("key2", "value2", workflow_name="wf2")

        await cache.clear(workflow="wf1")

        # Only wf1 entries should be cleared
        assert await cache.has("key1") is False
        assert await cache.has("key2") is True

    async def test_cache_list_entries(self, tmp_path: Path):
        cache = SqliteCache(tmp_path / "test.db")

        await cache.set("key1", "value1", workflow_name="wf1", input_hash="hash1")
        await cache.set("key2", "value2", workflow_name="wf2", input_hash="hash2")

        entries = await cache.list()

        assert len(entries) == 2
        keys = {e.key for e in entries}
        assert "key1" in keys
        assert "key2" in keys


class TestCacheTTL:
    """Tests for cache TTL functionality."""

    async def test_cache_ttl_expired(self, tmp_path: Path):
        # Very short TTL for testing
        cache = SqliteCache(tmp_path / "test.db", ttl=timedelta(milliseconds=1))

        await cache.set("key1", "value")

        # Wait for TTL to expire
        import asyncio

        await asyncio.sleep(0.01)

        result = await cache.get("key1")
        assert result is None

    async def test_cache_ttl_not_expired(self, tmp_path: Path):
        # Long TTL
        cache = SqliteCache(tmp_path / "test.db", ttl=timedelta(hours=1))

        await cache.set("key1", "value")
        result = await cache.get("key1")

        assert result == "value"


class TestCacheWithWorkflows:
    """Tests for cache integration with workflow execution."""

    async def test_workflow_result_cached(self, tmp_path: Path):
        @workflow
        async def analyze() -> OutputModel:
            return await claude("Analyze", output=OutputModel)

        cache = SqliteCache(tmp_path / "test.db")

        fake = FakeLLMProvider(
            responses=[
                {"value": "first_run"},
                {"value": "second_run"},  # Should not be used
            ]
        )

        with use_fake_llm(fake):
            graph = build_graph(analyze)

            # First run - executes workflow
            result1 = await run_graph(graph, cache=cache)
            assert result1.value == "first_run"
            assert len(fake.calls) == 1

            # Second run - should use cache
            fake.reset()
            fake.responses = [{"value": "second_run"}]
            result2 = await run_graph(graph, cache=cache)
            assert result2.value == "first_run"  # Cached value
            assert len(fake.calls) == 0  # No LLM call

    async def test_workflow_invalidation(self, tmp_path: Path):
        @workflow
        async def analyze() -> OutputModel:
            return await claude("Analyze", output=OutputModel)

        cache = SqliteCache(tmp_path / "test.db")

        fake = FakeLLMProvider(responses=[{"value": "first"}, {"value": "second"}])

        with use_fake_llm(fake):
            graph = build_graph(analyze)

            # First run
            result1 = await run_graph(graph, cache=cache)
            assert result1.value == "first"

            # Second run with invalidation
            result2 = await run_graph(graph, cache=cache, invalidate=["analyze"])
            assert result2.value == "second"

    async def test_workflow_invalidation_accepts_workflow_objects(self, tmp_path: Path):
        @workflow
        async def analyze() -> OutputModel:
            return await claude("Analyze", output=OutputModel)

        cache = SqliteCache(tmp_path / "test.db")

        fake = FakeLLMProvider(
            responses=[
                {"value": "first"},
                {"value": "second"},
                {"value": "third"},
            ]
        )

        with use_fake_llm(fake):
            graph = build_graph(analyze)

            result1 = await run_graph(graph, cache=cache)
            assert result1.value == "first"

            result2 = await run_graph(graph, cache=cache, invalidate=analyze)
            assert result2.value == "second"

            result3 = await run_graph(graph, cache=cache, invalidate=[analyze])
            assert result3.value == "third"

    async def test_wildcard_invalidation(self, tmp_path: Path):
        @workflow
        async def analyze() -> OutputModel:
            return await claude("Analyze", output=OutputModel)

        cache = SqliteCache(tmp_path / "test.db")

        fake = FakeLLMProvider(responses=[{"value": "first"}, {"value": "second"}])

        with use_fake_llm(fake):
            graph = build_graph(analyze)

            result1 = await run_graph(graph, cache=cache)
            assert result1.value == "first"

            # Invalidate all with "*"
            result2 = await run_graph(graph, cache=cache, invalidate="*")
            assert result2.value == "second"

    async def test_cache_stats_after_execution(self, tmp_path: Path):
        @workflow
        async def analyze() -> OutputModel:
            return await claude("Analyze", output=OutputModel)

        cache = SqliteCache(tmp_path / "test.db")

        fake = FakeLLMProvider(responses=[{"value": "test"}])

        with use_fake_llm(fake):
            graph = build_graph(analyze)

            # First run
            await run_graph(graph, cache=cache, return_all=True)
            stats1 = await cache.stats()
            assert stats1.entries == 1

            # Second run (cached)
            result = await run_graph(graph, cache=cache, return_all=True)
            assert result.stats.workflows_cached == 1
            assert result.stats.workflows_executed == 0


class TestCacheSecurity:
    """Security tests for cache serialization."""

    async def test_cache_rejects_arbitrary_pickle_objects(self, tmp_path: Path):
        """Test that cache does not allow deserialization of arbitrary pickle objects.

        This tests for CVE-like vulnerabilities where malicious pickle data could
        execute arbitrary code during deserialization. The cache should only accept
        JSON-serializable data structures.
        """
        import sqlite3

        cache = SqliteCache(tmp_path / "test.db")
        await cache._ensure_initialized()

        # Create a malicious pickle payload that would execute code if deserialized
        # This is a simplified example - real attacks could be more sophisticated
        class MaliciousClass:
            def __reduce__(self):
                # This would execute arbitrary code if pickle.loads() is called
                import os
                return (os.system, ("echo pwned",))

        malicious_obj = MaliciousClass()

        # Directly insert malicious pickle data into the database
        # (simulating a compromised cache file)
        import pickle

        malicious_pickle = pickle.dumps(malicious_obj)

        conn = sqlite3.connect(tmp_path / "test.db")
        conn.execute(
            "INSERT INTO cache (key, value, created_at, accessed_at) VALUES (?, ?, ?, ?)",
            ("malicious", malicious_pickle, "2024-01-01T00:00:00", "2024-01-01T00:00:00"),
        )
        conn.commit()
        conn.close()

        # Attempt to retrieve the malicious data
        # With the fix, this should either:
        # 1. Return None (safe handling)
        # 2. Raise an exception that's caught (safe handling)
        # 3. Not execute the malicious code (safe deserialization)
        result = await cache.get("malicious")

        # The key assertion: we should get None, not execute arbitrary code
        assert result is None

    async def test_cache_handles_corrupted_data(self, tmp_path: Path):
        """Test that cache handles corrupted/invalid serialized data gracefully."""
        import sqlite3

        cache = SqliteCache(tmp_path / "test.db")
        await cache._ensure_initialized()

        # Insert invalid data directly
        conn = sqlite3.connect(tmp_path / "test.db")
        conn.execute(
            "INSERT INTO cache (key, value, created_at, accessed_at) VALUES (?, ?, ?, ?)",
            ("corrupted", b"invalid data that cannot be deserialized", "2024-01-01T00:00:00", "2024-01-01T00:00:00"),
        )
        conn.commit()
        conn.close()

        # Should return None, not crash
        result = await cache.get("corrupted")
        assert result is None

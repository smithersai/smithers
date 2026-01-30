"""Global configuration for Smithers."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class SmithersConfig:
    """Global configuration values."""

    model: str = "claude-sonnet-4-20250514"
    max_concurrency: int | None = None
    cache_dir: Path | None = None
    log_level: str | None = None


def _get_max_concurrency() -> int | None:
    """Parse SMITHERS_MAX_CONCURRENCY environment variable."""
    value = os.getenv("SMITHERS_MAX_CONCURRENCY")
    if value is not None:
        return int(value)
    return None


def _get_cache_dir() -> Path | None:
    """Parse SMITHERS_CACHE_DIR environment variable."""
    value = os.getenv("SMITHERS_CACHE_DIR")
    if value is not None:
        return Path(value)
    return None


_CONFIG = SmithersConfig(
    model=os.getenv("SMITHERS_MODEL", "claude-sonnet-4-20250514"),
    max_concurrency=_get_max_concurrency(),
    cache_dir=_get_cache_dir(),
    log_level=os.getenv("SMITHERS_LOG_LEVEL"),
)


def configure(
    *,
    model: str | None = None,
    max_concurrency: int | None = None,
    cache_dir: str | Path | None = None,
    log_level: str | None = None,
) -> None:
    """Update global configuration values."""
    if model is not None:
        _CONFIG.model = model
    if max_concurrency is not None:
        _CONFIG.max_concurrency = max_concurrency
    if cache_dir is not None:
        _CONFIG.cache_dir = Path(cache_dir)
    if log_level is not None:
        _CONFIG.log_level = log_level


def get_config() -> SmithersConfig:
    """Return the current configuration."""
    return _CONFIG

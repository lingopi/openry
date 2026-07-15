"""Utility functions: timestamps, output truncation, encoding safety."""

from __future__ import annotations

import sys
from datetime import datetime, timezone


def utc_now_iso() -> str:
    """Return current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def safe_decode(data: bytes) -> str:
    """Decode bytes to string, using surrogateescape for undecodable bytes."""
    return data.decode(sys.getfilesystemencoding(), errors="surrogateescape")


def truncate_output(text: str, max_chars: int = 102400) -> str:
    """Truncate a string to max_chars, appending a notice if truncated."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n\n... [output truncated at {max_chars} characters]"


def ensure_str(value: str | bytes | None) -> str:
    """Convert bytes or None to str safely."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return safe_decode(value)
    return value

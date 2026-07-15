"""Configuration loading: YAML config file with sensible defaults."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import yaml


# Hardcoded defaults — these are the base values.
DEFAULTS: dict[str, Any] = {
    "shell": {
        "windows": "pwsh",
        "linux": "/bin/sh",
        "macos": "/bin/zsh",
    },
    "output": {
        "max_stdout_chars": 102400,
        "max_stderr_chars": 102400,
    },
    "timeout": {
        "default": 300,
    },
}


def _get_openry_dir() -> Path:
    """Locate or create the .openry directory.

    Priority: OPENRY_HOME env var > current working directory .openry
    """
    if env_home := os.environ.get("OPENRY_HOME"):
        p = Path(env_home)
    else:
        p = Path.cwd() / ".openry"
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_db_path() -> Path:
    """Return the path to the SQLite database."""
    return _get_openry_dir() / "openry.db"


def load_config() -> dict[str, Any]:
    """Load configuration, merging YAML over hardcoded defaults.

    Priority: env var OPENRY_CONFIG > .openry/config.yaml > DEFAULTS
    """
    config = dict(DEFAULTS)  # shallow copy is fine for our structure

    config_path = os.environ.get("OPENRY_CONFIG")
    if config_path is None:
        config_path = _get_openry_dir() / "config.yaml"

    config_path = Path(config_path)
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                user_config = yaml.safe_load(f) or {}
            _deep_merge(config, user_config)
        except yaml.YAMLError:
            print(
                f"Warning: failed to parse {config_path}, using defaults.",
                file=sys.stderr,
            )

    return config


def _deep_merge(base: dict, override: dict) -> None:
    """Recursively merge override into base (mutates base)."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value

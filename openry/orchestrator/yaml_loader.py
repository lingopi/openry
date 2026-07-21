"""YAML loader for workflow and composition configurations."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml


def _find_config_dir() -> Path:
    """Find the .openry config directory.

    Priority: OPENRY_HOME env var > ~/.openry (default)
    """
    if env_home := os.environ.get("OPENRY_HOME"):
        config_dir = Path(env_home)
    else:
        config_dir = Path.home() / ".openry"
    if not config_dir.exists():
        raise FileNotFoundError(
            f".openry/ directory not found at {config_dir}. "
            "Run 'openry' first to initialize, or set OPENRY_HOME."
        )
    return config_dir


def load_big_step(name: str) -> dict[str, Any]:
    """Load a big step YAML definition from .openry/workflows/{name}.yaml."""
    config_dir = _find_config_dir()
    yaml_path = config_dir / "workflows" / f"{name}.yaml"
    if not yaml_path.exists():
        raise FileNotFoundError(f"Workflow not found: {yaml_path}")
    with open(yaml_path) as f:
        return yaml.safe_load(f)


def load_composition(name: str) -> dict[str, Any]:
    """Load a composition YAML from .openry/compositions/{name}.yaml."""
    config_dir = _find_config_dir()
    yaml_path = config_dir / "compositions" / f"{name}.yaml"
    if not yaml_path.exists():
        raise FileNotFoundError(f"Composition not found: {yaml_path}")
    with open(yaml_path) as f:
        return yaml.safe_load(f)


def get_sub_step_config(big_step: dict, sub_step_id: str) -> dict[str, Any] | None:
    """Get a specific sub_step config from a loaded big_step YAML."""
    for ss in big_step.get("sub_steps", []):
        if ss.get("id") == sub_step_id:
            return ss
    return None


def get_first_sub_step(big_step: dict) -> dict[str, Any] | None:
    """Get the first sub_step in a big_step definition."""
    sub_steps = big_step.get("sub_steps", [])
    if not sub_steps:
        return None
    return sub_steps[0]


def get_next_sub_step(big_step: dict, current_id: str, route: str) -> dict[str, Any] | None:
    """Resolve the next sub_step based on routing.

    Args:
        big_step: The loaded big_step YAML
        current_id: Current sub_step ID
        route: Routing target - 'done', 'abort', 'retry', or a sub_step ID
    """
    if route == "done":
        return None  # Big step complete
    if route == "abort":
        return None  # Big step failed
    # route is a sub_step ID
    return get_sub_step_config(big_step, route)


def list_available_workflows() -> list[str]:
    """List all available big_step YAML files."""
    config_dir = _find_config_dir()
    workflows_dir = config_dir / "workflows"
    if not workflows_dir.exists():
        return []
    return sorted(
        p.stem for p in workflows_dir.glob("*.yaml")
    )


def list_available_compositions() -> list[str]:
    """List all available composition YAML files."""
    config_dir = _find_config_dir()
    comp_dir = config_dir / "compositions"
    if not comp_dir.exists():
        return []
    return sorted(
        p.stem for p in comp_dir.glob("*.yaml")
    )


# ── Phase 3a: validation_routing helpers ─────────────────────


def has_validation_routing(step_config: dict[str, Any]) -> bool:
    """Check if a sub_step config uses Phase 3a conditional routing."""
    entries = step_config.get("validation_routing")
    return bool(entries)


def get_validation_routing_entries(step_config: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract validation_routing entries from sub_step config."""
    return step_config.get("validation_routing", [])

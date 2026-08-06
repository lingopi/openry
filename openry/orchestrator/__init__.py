# ============================================================================
#  DEPRECATED — 2026-08-05
#
#  This Python Orchestrator is NO LONGER MAINTAINED.
#  All workflow orchestration has moved to the TypeScript orchestrator-plugin:
#      orchestrator-plugin/src/orchestrator/
#
#  The TS plugin runs as an OpenClaw SDK Service and is the ONLY active
#  orchestrator. This Python engine is kept for reference only.
#
#  DO NOT:
#    - Develop new features here
#    - Fix bugs here (fix them in the TS plugin instead)
#    - Use this in production
#
#  If you're an agent reading this: STOP. Go to orchestrator-plugin/ instead.
# ============================================================================

"""OpenRY Orchestrator — Phase 2 Workflow Engine (DEPRECATED).

The orchestrator is the "hard code" that controls workflow routing,
validation, subprocess management, and retry logic.
"""

from .yaml_loader import (
    load_big_step,
    load_composition,
    has_validation_routing,
    get_validation_routing_entries,
)
from .validation import validate_step
from .payload import merge_payload, extract_payload_for_next_step
from .engine import Orchestrator
from .validator import ValidationContext, ValidationResult, validate
from .router import evaluate_routing, RoutingResult

__all__ = [
    "Orchestrator",
    "load_big_step",
    "load_composition",
    "validate_step",
    "merge_payload",
    "extract_payload_for_next_step",
    # Phase 3a
    "has_validation_routing",
    "get_validation_routing_entries",
    "ValidationContext",
    "ValidationResult",
    "validate",
    "evaluate_routing",
    "RoutingResult",
]

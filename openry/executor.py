"""Platform-aware command execution with shell detection and fallback."""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from typing import Any

from .config import DEFAULTS, load_config
from .utils import ensure_str, safe_decode, truncate_output


def detect_shell(config: dict[str, Any] | None = None) -> str:
    """Detect the best available shell for the current platform.

    Returns the shell name (e.g. 'pwsh', 'zsh', 'sh', 'cmd', 'bash').
    """
    if config is None:
        config = load_config()

    system = platform.system().lower()
    shell_map = config.get("shell", DEFAULTS["shell"])

    if system == "windows":
        primary = shell_map.get("windows", "pwsh")
    elif system == "darwin":
        primary = shell_map.get("macos", "/bin/zsh")
    else:
        primary = shell_map.get("linux", "/bin/sh")

    # On Windows we check via shutil.which; on Unix check if executable exists
    if shutil.which(primary) or (primary.startswith("/") and os.path.exists(primary)):
        return primary

    # Fallback
    fallback = shell_map.get("windows_fallback", "cmd") if system == "windows" else "/bin/bash"
    msg = f"Warning: '{primary}' not found, falling back to '{fallback}'"
    print(msg, file=sys.stderr)
    return fallback


def run_command(
    command: str,
    *,
    cwd: str | None = None,
    timeout: int = 300,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Execute a shell command and return structured result.

    Args:
        command: The shell command string to execute.
        cwd: Working directory (default: current directory).
        timeout: Timeout in seconds.
        extra_env: Additional environment variables to inject.

    Returns:
        dict with keys: exit_code, stdout, stderr, duration_ms,
                        shell, cwd, timeout, command
    """
    config = load_config()
    shell = detect_shell(config)
    output_cfg = config.get("output", DEFAULTS["output"])

    if cwd is None:
        cwd = os.getcwd()
    cwd = os.path.abspath(cwd)

    if not os.path.isdir(cwd):
        return {
            "exit_code": 3,
            "stdout": "",
            "stderr": f"cwd not found: {cwd}",
            "duration_ms": 0,
            "shell": shell,
            "cwd": cwd,
            "timeout": False,
            "command": command,
        }

    merged_env = os.environ.copy()
    if extra_env:
        merged_env.update(extra_env)

    try:
        if shell in ("pwsh", "powershell"):
            # PowerShell: use list-based invocation
            proc = subprocess.run(
                [shell, "-NoProfile", "-NonInteractive", "-Command", command],
                cwd=cwd,
                timeout=timeout,
                capture_output=True,
                env=merged_env,
            )
        else:
            # Unix shells: use shell=True with explicit executable
            proc = subprocess.run(
                command,
                shell=True,
                executable=shell,
                cwd=cwd,
                timeout=timeout,
                capture_output=True,
                env=merged_env,
            )

        stdout_raw = ensure_str(proc.stdout)
        stderr_raw = ensure_str(proc.stderr)

        from time import perf_counter

        return {
            "exit_code": proc.returncode,
            "stdout": truncate_output(stdout_raw, output_cfg["max_stdout_chars"]),
            "stderr": truncate_output(stderr_raw, output_cfg["max_stderr_chars"]),
            "duration_ms": 0,  # filled by caller with actual timing
            "shell": shell,
            "cwd": cwd,
            "timeout": False,
            "command": command,
        }

    except subprocess.TimeoutExpired:
        return {
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Command timed out after {timeout} seconds",
            "duration_ms": timeout * 1000,
            "shell": shell,
            "cwd": cwd,
            "timeout": True,
            "command": command,
        }

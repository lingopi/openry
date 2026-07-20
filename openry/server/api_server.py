"""Lightweight HTTP API server for the OpenRY dashboard.

Uses only Python standard library (http.server). No external dependencies.
Serves both the REST API and static frontend files.
"""

from __future__ import annotations

import json
import os
import re
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from openry.db import _get_conn
from openry.orchestrator.yaml_loader import list_available_compositions, list_available_workflows

from .event_bus import get_event_bus

# ── Path to the web/ static directory ──────────────────────────
_WEB_DIR = Path(__file__).resolve().parent.parent / "web"


# ── Response Helpers ────────────────────────────────────────────

def _send_json(handler: SimpleHTTPRequestHandler, obj: Any, status: int = 200) -> None:
    """Send a JSON response using proper handler methods."""
    body = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Cache-Control", "no-cache")
    handler.end_headers()
    handler.wfile.write(body)


def _send_error(handler: SimpleHTTPRequestHandler, message: str, status: int = 400) -> None:
    _send_json(handler, {"error": message}, status)


def _send_static(handler: SimpleHTTPRequestHandler, path: str) -> bool:
    """Serve a static file from web/. Returns True if file was served."""
    safe_path = os.path.normpath(path.lstrip("/"))
    if safe_path.startswith(".."):
        return False

    file_path = _WEB_DIR / safe_path
    if not file_path.is_file():
        # SPA fallback: serve index.html for non-API paths
        if not safe_path.startswith("api/"):
            index_path = _WEB_DIR / "index.html"
            if index_path.is_file():
                return _send_static(handler, "/index.html")
        return False

    _MIME: dict[str, str] = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
    }
    ext = file_path.suffix.lower()
    mime = _MIME.get(ext, "application/octet-stream")
    content = file_path.read_bytes()

    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(len(content)))
    handler.send_header("Cache-Control", "no-cache")
    handler.end_headers()
    handler.wfile.write(content)
    return True



# ── API Route Handlers ──────────────────────────────────────────

def _api_list_compositions(handler, query: dict) -> None:
    conn = _get_conn()
    conn.row_factory = None
    status_filter = query.get("status", [None])[0]

    # Pagination: page (1-based) + per_page, or raw limit/offset for backward compat
    page = int(query.get("page", ["1"])[0])
    per_page = int(query.get("per_page", ["10"])[0])
    per_page = min(max(per_page, 1), 100)

    if "limit" in query or "offset" in query:
        # Raw mode (backward compat)
        limit = min(int(query.get("limit", ["20"])[0]), 200)
        offset = int(query.get("offset", ["0"])[0])
    else:
        # Page mode
        limit = per_page
        offset = (page - 1) * per_page

    # Total count for pagination
    if status_filter:
        total = conn.execute(
            "SELECT COUNT(*) FROM workflow_instances WHERE status = ?", (status_filter,)
        ).fetchone()[0]
        rows = conn.execute(
            "SELECT id, composition, status, current_big_step, big_step_started_at, "
            "timeout_minutes, created_at, updated_at "
            "FROM workflow_instances WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (status_filter, limit, offset),
        ).fetchall()
    else:
        total = conn.execute("SELECT COUNT(*) FROM workflow_instances").fetchone()[0]
        rows = conn.execute(
            "SELECT id, composition, status, current_big_step, big_step_started_at, "
            "timeout_minutes, created_at, updated_at "
            "FROM workflow_instances ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()

    cols = ["id", "composition", "status", "current_big_step",
            "big_step_started_at", "timeout_minutes", "created_at", "updated_at"]
    conn.close()
    _send_json(handler, {
        "compositions": [dict(zip(cols, r)) for r in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": max(1, (total + per_page - 1) // per_page),
    })


def _api_get_composition(handler, composition_id: str) -> None:
    conn = _get_conn()
    conn.row_factory = None
    row = conn.execute(
        "SELECT id, composition, status, current_big_step, big_step_started_at, "
        "timeout_minutes, created_at, updated_at "
        "FROM workflow_instances WHERE id = ?", (composition_id,)
    ).fetchone()
    if not row:
        conn.close()
        _send_error(handler, f"Composition {composition_id} not found", 404)
        return
    cols = ["id", "composition", "status", "current_big_step",
            "big_step_started_at", "timeout_minutes", "created_at", "updated_at"]
    comp = dict(zip(cols, row))

    task_rows = conn.execute(
        "SELECT ts.run_id, ts.workflow, ts.step_id, ts.sub_step_id, ts.status, ts.payload, "
        "ts.big_step_ref, ts.big_step_retry_count, ts.max_retries, ts.sub_step_retry_count, "
        "ts.max_sub_step_retries, ts.max_tool_calls, ts.validation_status, ts.cancel_requested, "
        "ts.output_overflow, ts.created_at, ts.updated_at, "
        "COALESCE(cl.call_count, 0) as tool_calls "
        "FROM task_state ts "
        "LEFT JOIN ("
        "  SELECT run_id, COUNT(*) as call_count FROM commands_log GROUP BY run_id"
        ") cl ON ts.run_id = cl.run_id "
        "WHERE ts.workflow_instance_id = ? ORDER BY ts.created_at ASC",
        (composition_id,),
    ).fetchall()
    task_cols = ["run_id", "workflow", "step_id", "sub_step_id", "status", "payload",
                 "big_step_ref", "big_step_retry_count", "max_retries",
                 "sub_step_retry_count", "max_sub_step_retries", "max_tool_calls",
                 "validation_status", "cancel_requested", "output_overflow",
                 "created_at", "updated_at", "tool_calls"]
    comp["steps"] = [dict(zip(task_cols, t)) for t in task_rows]
    conn.close()
    _send_json(handler, {"composition": comp})


def _api_get_payload(handler, composition_id: str) -> None:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT run_id, payload FROM task_state WHERE workflow_instance_id = ? ORDER BY created_at DESC",
        (composition_id,),
    ).fetchall()
    conn.close()
    payloads = {}
    for run_id, payload_str in rows:
        try:
            payloads[run_id] = json.loads(payload_str) if payload_str else {}
        except (json.JSONDecodeError, TypeError):
            payloads[run_id] = {"_raw": str(payload_str)}
    _send_json(handler, {"payloads": payloads})


def _api_list_commands(handler, query: dict) -> None:
    conn = _get_conn()
    conn.row_factory = None
    run_id = query.get("run_id", [None])[0]
    status = query.get("status", [None])[0]

    # Pagination
    page = int(query.get("page", ["1"])[0])
    per_page = int(query.get("per_page", ["20"])[0])
    per_page = min(max(per_page, 1), 100)

    # Backward compat: raw limit/offset override
    if "limit" in query:
        limit = min(int(query.get("limit", ["50"])[0]), 500)
        offset = int(query.get("offset", ["0"])[0])
    else:
        limit = per_page
        offset = (page - 1) * per_page

    where = []
    params = []
    if run_id:
        where.append("run_id = ?")
        params.append(run_id)
    if status:
        if status == "success":
            where.append("exit_code = 0")
        elif status == "failed":
            where.append("exit_code > 0")
    where_clause = ("WHERE " + " AND ".join(where)) if where else ""

    # Total count
    count_params = params[:]  # copy before adding limit/offset
    total = conn.execute(
        f"SELECT COUNT(*) FROM commands_log {where_clause}", count_params
    ).fetchone()[0]

    params.extend([limit, offset])
    rows = conn.execute(
        f"SELECT id, run_id, workflow, step_id, command, shell, cwd, "
        f"exit_code, stdout, stderr, duration_ms, timeout, timestamp "
        f"FROM commands_log {where_clause} ORDER BY id DESC LIMIT ? OFFSET ?",
        params,
    ).fetchall()
    cols = ["id", "run_id", "workflow", "step_id", "command", "shell", "cwd",
            "exit_code", "stdout", "stderr", "duration_ms", "timeout", "timestamp"]
    conn.close()
    _send_json(handler, {
        "commands": [dict(zip(cols, r)) for r in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": max(1, (total + per_page - 1) // per_page),
    })


def _api_list_workflows(handler) -> None:
    try:
        big_steps = list_available_workflows()
        compositions = list_available_compositions()
    except FileNotFoundError:
        big_steps, compositions = [], []
    _send_json(handler, {"workflows": big_steps, "compositions": compositions})


def _api_metrics(handler) -> None:
    conn = _get_conn()
    total = conn.execute("SELECT COUNT(*) FROM workflow_instances").fetchone()[0]
    running = conn.execute(
        "SELECT COUNT(*) FROM workflow_instances WHERE status = 'running'"
    ).fetchone()[0]
    completed = conn.execute(
        "SELECT COUNT(*) FROM workflow_instances WHERE status = 'completed'"
    ).fetchone()[0]
    failed = conn.execute(
        "SELECT COUNT(*) FROM workflow_instances WHERE status = 'failed'"
    ).fetchone()[0]
    total_commands = conn.execute("SELECT COUNT(*) FROM commands_log").fetchone()[0]
    wf_rows = conn.execute(
        "SELECT composition, COUNT(*) as cnt FROM workflow_instances GROUP BY composition"
    ).fetchall()
    conn.close()
    _send_json(handler, {
        "total_runs": total,
        "running": running,
        "completed": completed,
        "failed": failed,
        "success_rate": round(completed / total * 100, 1) if total > 0 else 0,
        "total_commands": total_commands,
        "by_workflow": [{"workflow": r[0], "count": r[1]} for r in wf_rows],
    })


def _api_trigger(handler, body: dict) -> None:
    composition_name = body.get("workflow", "").strip()
    if not composition_name:
        _send_error(handler, "Missing 'workflow' field")
        return
    try:
        from openry.orchestrator.engine import Orchestrator
        orch = Orchestrator()
        instance_id = orch.start_workflow(composition_name)
        _send_json(handler, {
            "composition_id": instance_id,
            "message": f"Workflow '{composition_name}' started",
        }, 201)
    except FileNotFoundError as e:
        _send_error(handler, str(e), 404)
    except Exception as e:
        _send_error(handler, str(e), 500)


# ── Transcript API ──────────────────────────────────────────────

def _find_session_id(run_id: str) -> str | None:
    """Find the openclaw sessionId for a given OpenRY run_id.

    Reads ~/.openclaw/agents/openry-worker/sessions/sessions.json
    and matches the sessionKey containing the run_id.
    """
    sessions_json = Path.home() / ".openclaw" / "agents" / "openry-worker" / "sessions" / "sessions.json"
    if not sessions_json.exists():
        return None
    try:
        data = json.loads(sessions_json.read_text())
    except (json.JSONDecodeError, OSError):
        return None

    needle = f":run:{run_id}"
    for key, val in data.items():
        if isinstance(val, dict) and needle in key:
            return val.get("sessionId")
    return None


def _parse_transcript(jsonl_path: Path, after_line: int = 0) -> tuple[list[dict], int]:
    """Parse a JSONL transcript file into a list of structured messages.

    Args:
        jsonl_path: Path to the .jsonl file
        after_line: If > 0, skip the first `after_line` lines (for incremental polling)

    Returns:
        (messages, total_lines) — messages is the parsed list, total_lines is the line count
    """
    messages: list[dict] = []
    if not jsonl_path.exists():
        return messages, 0

    try:
        all_lines = jsonl_path.read_text().splitlines()
    except OSError:
        return messages, 0

    total_lines = len(all_lines)
    lines = all_lines[after_line:] if after_line > 0 else all_lines

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        entry_type = entry.get("type", "")
        if entry_type == "session":
            continue

        msg = entry.get("message", {})
        if not msg or not isinstance(msg, dict):
            continue

        role = msg.get("role", entry.get("role", "assistant"))
        ts = entry.get("timestamp", "")

        if role == "assistant":
            content = msg.get("content", [])
            if isinstance(content, str):
                messages.append({"role": "assistant", "type": "text", "text": content, "timestamp": ts})
            elif isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "text":
                        text = item.get("text", "")
                        if text.strip():
                            messages.append({"role": "assistant", "type": "text", "text": text, "timestamp": ts})
                    elif item.get("type") == "toolCall":
                        fn = item.get("function", item.get("name", ""))
                        args = item.get("arguments", item.get("input", {}))
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except json.JSONDecodeError:
                                pass
                        messages.append({
                            "role": "assistant", "type": "tool_call",
                            "toolName": fn if isinstance(fn, str) else (fn.get("name", "") if isinstance(fn, dict) else str(fn)),
                            "toolArgs": args,
                            "timestamp": ts,
                        })

        elif role == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                text = " ".join(item.get("text", "") for item in content if isinstance(item, dict) and item.get("type") == "text")
            else:
                text = str(content) if content else ""
            if text.strip():
                messages.append({"role": "user", "type": "text", "text": text, "timestamp": ts})

        elif role in ("toolResult", "tool"):
            content = msg.get("content", [])
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        text = item.get("text", "")
                        is_error = "error" in text.lower() or "failed" in text.lower()
                        messages.append({
                            "role": "tool", "type": "tool_result",
                            "text": text,
                            "isError": is_error,
                            "toolCallId": msg.get("toolCallId", entry.get("toolCallId", "")),
                            "timestamp": ts,
                        })

    return messages, total_lines


def _api_transcript(handler, query: dict) -> None:
    """Serve the session transcript for a given run_id.

    Supports incremental polling via ?after_line=N parameter.
    """
    run_id = (query.get("run_id", [None])[0] or "").strip()
    if not run_id:
        _send_error(handler, "Missing run_id parameter")
        return

    after_line = int(query.get("after_line", ["0"])[0])

    session_id = _find_session_id(run_id)
    if not session_id:
        _send_json(handler, {"transcript": [], "session_id": None, "total_lines": 0, "note": "No session found for this run_id"})
        return

    jsonl_path = Path.home() / ".openclaw" / "agents" / "openry-worker" / "sessions" / f"{session_id}.jsonl"
    messages, total_lines = _parse_transcript(jsonl_path, after_line=after_line)

    _send_json(handler, {
        "transcript": messages,
        "session_id": session_id,
        "run_id": run_id,
        "message_count": len(messages),
        "total_lines": total_lines,
    })



# ── SSE Handler ─────────────────────────────────────────────────

def _handle_sse(handler) -> str:
    """Begin an SSE stream. Returns subscriber_id."""
    event_bus = get_event_bus()
    sub_id, q = event_bus.subscribe()
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    # Flush headers immediately so client sees the 200
    handler.wfile.flush()
    return sub_id


# ── Request Router ──────────────────────────────────────────────

class APIHandler(SimpleHTTPRequestHandler):
    """Custom HTTP handler that routes /api/* to handlers and /* to static files."""

    # Suppress request logging
    def log_message(self, format, *args):
        pass

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = {k: v for k, v in parse_qs(parsed.query).items()}

        try:
            # SSE endpoint
            if path == "/api/v1/events":
                sub_id = _handle_sse(self)
                self._stream_sse(sub_id)
                return

            # API routes
            if path == "/api/v1/compositions":
                _api_list_compositions(self, query)
                return
            if m := re.match(r"^/api/v1/compositions/(\d+)$", path):
                _api_get_composition(self, m.group(1))
                return
            if m := re.match(r"^/api/v1/compositions/(\d+)/payload$", path):
                _api_get_payload(self, m.group(1))
                return
            if path == "/api/v1/commands":
                _api_list_commands(self, query)
                return
            if path == "/api/v1/workflows":
                _api_list_workflows(self)
                return
            if path == "/api/v1/metrics":
                _api_metrics(self)
                return
            if path == "/api/v1/transcript":
                _api_transcript(self, query)
                return

            # Static files
            if _send_static(self, self.path):
                return

            # 404
            _send_error(self, "Not found", 404)

        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                _send_error(self, f"Internal error: {e}", 500)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_raw = self.rfile.read(content_length) if content_length else b"{}"
            body = json.loads(body_raw) if body_raw else {}

            if path == "/api/v1/trigger":
                _api_trigger(self, body)
                return

            _send_error(self, "Not found", 404)

        except json.JSONDecodeError:
            _send_error(self, "Invalid JSON body")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                _send_error(self, f"Internal error: {e}", 500)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_OPTIONS(self) -> None:
        """CORS preflight."""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _stream_sse(self, sub_id: str) -> None:
        """Stream SSE events to the client."""
        event_bus = get_event_bus()
        q = None
        for sid, sq in event_bus._subscribers.items():
            if sid == sub_id:
                q = sq
                break
        if q is None:
            return

        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {msg}\n\n".encode())
                    self.wfile.flush()
                except Exception:
                    # Timeout or empty — send heartbeat
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            event_bus.unsubscribe(sub_id)


# ── Server Launcher ─────────────────────────────────────────────

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """HTTPServer with threading support so SSE doesn't block other requests."""
    daemon_threads = True


def run_server(host: str = "127.0.0.1", port: int = 9100) -> None:
    """Start the HTTP API server (blocking)."""
    server = ThreadingHTTPServer((host, port), APIHandler)
    print(f"\n  🚀 OpenRY Dashboard running at http://{host}:{port}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  👋 Shutting down...")
        server.shutdown()

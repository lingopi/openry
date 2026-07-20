"""Event bus for SSE streaming: publish/subscribe via queue.Queue."""

from __future__ import annotations

import json
import queue
import threading
import uuid


class EventBus:
    """Simple in-process publish/subscribe event bus.

    Subscribers get a queue.Queue; publishers push dict events.
    Each subscriber has a unique ID for cleanup.
    """

    def __init__(self) -> None:
        self._subscribers: dict[str, queue.Queue] = {}
        self._lock = threading.Lock()

    def subscribe(self) -> tuple[str, queue.Queue]:
        """Register a new subscriber. Returns (subscriber_id, queue)."""
        q: queue.Queue = queue.Queue()
        sub_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._subscribers[sub_id] = q
        return sub_id, q

    def unsubscribe(self, sub_id: str) -> None:
        """Remove a subscriber."""
        with self._lock:
            self._subscribers.pop(sub_id, None)

    def publish(self, event: str, data: dict) -> None:
        """Push an event to all subscribers."""
        payload = json.dumps({"event": event, "data": data})
        with self._lock:
            dead: list[str] = []
            for sub_id, q in self._subscribers.items():
                try:
                    q.put_nowait(payload)
                except queue.Full:
                    dead.append(sub_id)
            for sub_id in dead:
                self._subscribers.pop(sub_id, None)

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)


# Singleton instance
_event_bus: EventBus | None = None


def get_event_bus() -> EventBus:
    global _event_bus
    if _event_bus is None:
        _event_bus = EventBus()
    return _event_bus

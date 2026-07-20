/* global EventSource */
// ── API module ──────────────────────────────────────
const API = {
  _base: '',

  async _fetch(path) {
    const res = await fetch(this._base + path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async _post(path, body) {
    const res = await fetch(this._base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  getCompositions(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this._fetch('/api/v1/compositions' + (qs ? '?' + qs : ''));
  },

  getComposition(id) {
    return this._fetch(`/api/v1/compositions/${id}`);
  },

  getCompositionPayload(id) {
    return this._fetch(`/api/v1/compositions/${id}/payload`);
  },

  getCommands(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this._fetch('/api/v1/commands' + (qs ? '?' + qs : ''));
  },

  getWorkflows() {
    return this._fetch('/api/v1/workflows');
  },

  getMetrics() {
    return this._fetch('/api/v1/metrics');
  },

  triggerWorkflow(workflow, payload) {
    return this._post('/api/v1/trigger', { workflow, payload });
  },

  // SSE events
  connectEvents() {
    const es = new EventSource(this._base + '/api/v1/events');
    return es;
  }
};

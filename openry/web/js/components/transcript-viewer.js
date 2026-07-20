/* global API */
// ── Transcript Viewer Component ──────────────────────

const TranscriptViewer = {
  _timer: null,
  _currentRunId: null,
  _currentContainer: null,
  _totalLines: 0,
  _pollIntervalMs: 2000,

  _escape(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  },

  /** Load transcript for the first time, then start polling. */
  async load(container, runId) {
    this.stop();
    this._currentRunId = runId;
    this._currentContainer = container;
    this._totalLines = 0;
    container.innerHTML = '<div class="transcript-loading">Loading transcript...</div>';

    try {
      const data = await API._fetch(`/api/v1/transcript?run_id=${encodeURIComponent(runId)}`);
      this._totalLines = data.total_lines || 0;
      if (!data.transcript || data.transcript.length === 0) {
        container.innerHTML = '<div class="transcript-header">📝 Session Transcript</div><div class="transcript-empty">Waiting for agent to start...</div>';
      } else {
        this._renderFull(container, data.transcript);
      }
      // Always start polling — data may arrive later
      this._startPolling();
    } catch (e) {
      container.innerHTML = '<div class="transcript-header">📝 Session Transcript</div><div class="transcript-empty">Failed to load transcript</div>';
      // Still poll in case it's a transient error
      this._startPolling();
    }
  },

  /** Stop polling timer. */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  _startPolling() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._timer = setInterval(() => this._poll(), this._pollIntervalMs);
  },

  async _poll() {
    if (!this._currentRunId || !this._currentContainer) { this.stop(); return; }
    try {
      const url = `/api/v1/transcript?run_id=${encodeURIComponent(this._currentRunId)}&after_line=${this._totalLines}`;
      const data = await API._fetch(url);
      const newTotal = data.total_lines || 0;
      if (newTotal <= this._totalLines) return;
      const newMessages = data.transcript || [];
      if (newMessages.length === 0) return;

      if (this._totalLines === 0) {
        this._renderFull(this._currentContainer, newMessages);
      } else {
        this._appendMessages(newMessages);
      }
      this._totalLines = newTotal;
    } catch (_) {}
  },

  _renderFull(container, messages) {
    container.innerHTML = '<div class="transcript-header">📝 Session Transcript <span class="t-live-dot" title="Live updating"></span></div>'
      + this._messagesHtml(messages);
    container.scrollTop = container.scrollHeight;
  },

  _appendMessages(messages) {
    const container = this._currentContainer;
    if (!container) return;
    container.insertAdjacentHTML('beforeend', this._messagesHtml(messages));
    container.scrollTop = container.scrollHeight;
  },

  _messagesHtml(messages) {
    let html = '';
    messages.forEach((msg) => {
      switch (msg.type) {
        case 'text':
          if (msg.role === 'user') {
            html += `<div class="t-msg t-user"><div class="t-role">👤 User</div><div class="t-text">${this._escape(msg.text)}</div></div>`;
          } else if (msg.role === 'assistant') {
            html += `<div class="t-msg t-assistant"><div class="t-role">🤖 Assistant</div><div class="t-text">${this._escape(msg.text)}</div></div>`;
          }
          break;
        case 'tool_call':
          html += `<div class="t-msg t-tool-call"><div class="t-role">🔧 Tool Call</div><div class="t-tool-name">${this._escape(msg.toolName)}</div>${msg.toolArgs && Object.keys(msg.toolArgs).length ? `<div class="t-tool-args"><pre>${this._escape(JSON.stringify(msg.toolArgs, null, 2))}</pre></div>` : ''}</div>`;
          break;
        case 'tool_result':
          const errClass = msg.isError ? ' t-error' : '';
          html += `<div class="t-msg t-tool-result${errClass}"><div class="t-role">📤 Result ${msg.isError ? '❌' : '✅'}</div><div class="t-text">${this._escape(msg.text)}</div></div>`;
          break;
      }
    });
    return html;
  }
};

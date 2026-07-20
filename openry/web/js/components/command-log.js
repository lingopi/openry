/* global API */
// ── Command Log Component ───────────────────────────

const CommandLog = {
  async load(params = {}) {
    const container = document.getElementById('commandList');
    container.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';

    try {
      const data = await API.getCommands(params);
      this._render(data.commands || []);
      return { total: data.total || 0, totalPages: data.total_pages || 1, page: data.page || 1 };
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p>⚠️ ${e.message}</p></div>`;
      return { total: 0, totalPages: 1, page: 1 };
    }
  },

  _render(commands) {
    const container = document.getElementById('commandList');
    if (commands.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>No commands found</p></div>';
      return;
    }

    container.innerHTML = commands.map((cmd, i) => {
      const exitOk = cmd.exit_code === 0;
      return `<div class="command-item">
        <div class="command-item-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span class="command-index">#${cmd.id}</span>
          <span class="command-cmd">${this._esc(cmd.command)}</span>
          <span class="command-exit ${exitOk ? 'success' : 'failed'}">${exitOk ? '✅' : '❌'} ${cmd.exit_code}</span>
          <span class="command-duration">${cmd.duration_ms}ms</span>
          <span style="font-size:10px;color:var(--text-muted);font-family:monospace">${cmd.run_id ? cmd.run_id.substring(0,8) : '-'}</span>
        </div>
        <div class="command-item-body">
          <div class="command-label">Run ID: ${cmd.run_id || 'N/A'} · Shell: ${cmd.shell} · CWD: ${cmd.cwd} · ${cmd.timestamp}</div>
          <div class="command-label">stdout</div>
          <div class="command-output">${this._esc(cmd.stdout || '(empty)')}</div>
          ${cmd.stderr ? `<div class="command-label" style="color:var(--red)">stderr</div><div class="command-output" style="color:var(--red)">${this._esc(cmd.stderr)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  },

  _esc(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
};

/* global API, WorkflowTree, CommandLog, TriggerPanel, MetricsCards */
// ── Main App Controller ─────────────────────────────

const App = {
  _currentView: 'workflows',
  _events: null,
  _historyPage: 1,
  _historyPerPage: 10,
  _historyStatus: '',
  _historyTotalPages: 1,
  _cmdPage: 1,
  _cmdPerPage: 10,

  init() {
    // Navigation
    document.getElementById('navTabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.nav-tab');
      if (!tab) return;
      this._switchView(tab.dataset.view);
    });

    // Refresh buttons
    document.getElementById('btnRefreshWorkflows').addEventListener('click', () => {
      WorkflowTree.loadWorkflows();
    });
    document.getElementById('btnRefreshCommands').addEventListener('click', () => {
      this._cmdPage = 1;
      this._loadCommands();
    });

    // Commands filter: reset to page 1 on change
    document.getElementById('cmdStatusFilter').addEventListener('change', () => {
      this._cmdPage = 1;
      this._loadCommands();
    });
    document.getElementById('cmdRunIdFilter').addEventListener('change', () => {
      this._cmdPage = 1;
      this._loadCommands();
    });

    // History filter
    document.getElementById('historyStatusFilter').addEventListener('change', () => {
      this._historyPage = 1;
      this._historyStatus = document.getElementById('historyStatusFilter').value;
      this._loadHistory();
    });

    // Initialize components
    TriggerPanel.init();
    WorkflowTree.init('workflowDetail');

    // Load initial data
    this._switchView('workflows');

    // Delay SSE connection to avoid blocking initial page render
    setTimeout(() => this._connectEvents(), 1000);
  },

  _switchView(view) {
    this._currentView = view;

    // Update tabs
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const tab = document.querySelector(`[data-view="${view}"]`);
    if (tab) tab.classList.add('active');

    // Update views
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    // Load data
    switch (view) {
      case 'workflows': WorkflowTree.loadWorkflows(); break;
      case 'history': this._loadHistory(); break;
      case 'commands': this._loadCommands(); break;
      case 'metrics': MetricsCards.load(); break;
    }
  },

  async _loadHistory() {
    const tbody = document.getElementById('historyBody');
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Loading...</td></tr>';
    document.getElementById('historyDetail').classList.add('hidden');

    const params = { page: this._historyPage, per_page: this._historyPerPage };
    if (this._historyStatus) params.status = this._historyStatus;

    try {
      const data = await API.getCompositions(params);
      const comps = data.compositions || [];
      this._historyTotalPages = data.total_pages || 1;

      if (comps.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No runs found</td></tr>';
      } else {
        tbody.innerHTML = comps.map(c => {
          const icon = c.status === 'completed' ? '✅' : c.status === 'failed' ? '❌' : c.status === 'running' ? '🔄' : '⏳';
          return `<tr onclick="App._showHistoryDetail(${c.id})" data-comp-id="${c.id}">
            <td style="font-family:monospace;color:var(--accent)">#${c.id}</td>
            <td>${c.composition}</td>
            <td>${icon} ${c.status}</td>
            <td style="color:var(--text-muted)">${c.current_big_step || '-'}</td>
            <td style="font-size:11px;color:var(--text-muted)">${c.created_at || '-'}</td>
          </tr>`;
        }).join('');
      }
      this._renderPagination();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">⚠️ ${e.message}</td></tr>`;
    }
  },

  _renderPagination() {
    const pg = document.getElementById('historyPagination');
    if (this._historyTotalPages <= 1) { pg.innerHTML = ''; return; }

    let html = `<span class="pg-info">Page ${this._historyPage} / ${this._historyTotalPages}</span>`;
    html += `<button class="btn btn-sm" ${this._historyPage <= 1 ? 'disabled' : ''} onclick="App._goPage(${this._historyPage - 1})">◀ Prev</button>`;
    html += `<button class="btn btn-sm" ${this._historyPage >= this._historyTotalPages ? 'disabled' : ''} onclick="App._goPage(${this._historyPage + 1})">Next ▶</button>`;
    pg.innerHTML = html;
  },

  _goPage(p) {
    if (p < 1 || p > this._historyTotalPages) return;
    this._historyPage = p;
    this._loadHistory();
  },

  async _showHistoryDetail(id) {
    document.querySelectorAll('#historyBody tr').forEach(r => r.classList.remove('active'));
    const row = document.querySelector(`#historyBody tr[data-comp-id="${id}"]`);
    if (row) row.classList.add('active');

    const detail = document.getElementById('historyDetail');
    detail.classList.remove('hidden');
    detail.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';

    try {
      const data = await API.getComposition(id);
      const comp = data.composition;
      const steps = comp.steps || [];

      let html = `<h3 style="margin-bottom:12px">📋 ${comp.composition} <span style="font-weight:400;font-size:13px">#${comp.id}</span> — ${comp.status}</h3>`;

      const groups = {};
      steps.forEach(s => {
        const ref = s.big_step_ref || 'default';
        if (!groups[ref]) groups[ref] = [];
        groups[ref].push(s);
      });

      for (const [ref, groupSteps] of Object.entries(groups)) {
        html += `<div class="big-step"><div class="big-step-header" onclick="this.parentElement.classList.toggle('collapsed')"><span class="big-step-arrow">▼</span><span>📦 ${ref}</span></div><div class="big-step-body">`;
        groupSteps.forEach((s) => {
          const icon = s.status === 'completed' || s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'in_progress' ? '🔄' : '⏳';
          html += `<div class="sub-step" data-run-id="${s.run_id}" onclick="App._loadHistoryTranscript(event, '${s.run_id}')" style="cursor:pointer">
            <span class="sub-step-id">${s.sub_step_id || s.step_id || '—'}</span>
            <span class="sub-step-desc">${icon} ${s.status}</span>
            <span class="sub-step-stats" style="color:var(--accent)">${s.run_id ? s.run_id.substring(0,12) : ''}</span>
          </div>
          <div class="transcript-inline" id="ht-${s.run_id}" style="display:none"></div>`;
        });
        html += `</div></div>`;
      }

      detail.innerHTML = html;
    } catch (e) {
      detail.innerHTML = `<div class="empty-state"><p>⚠️ ${e.message}</p></div>`;
    }
  },

  _loadHistoryTranscript(event, runId) {
    event.stopPropagation();
    const container = document.getElementById('ht-' + runId);
    if (!container) return;

    const wasHidden = container.style.display === 'none';
    document.querySelectorAll('.transcript-inline').forEach(el => el.style.display = 'none');
    if (wasHidden) {
      container.style.display = 'block';
      if (typeof TranscriptViewer !== 'undefined') {
        TranscriptViewer.load(container, runId);
      }
    }
  },

  async _loadCommands() {
    const params = { page: this._cmdPage, per_page: this._cmdPerPage };
    const runId = document.getElementById('cmdRunIdFilter').value.trim();
    const status = document.getElementById('cmdStatusFilter').value;
    if (runId) params.run_id = runId;
    if (status) params.status = status;

    const result = await CommandLog.load(params);
    this._renderCmdPagination(result.totalPages, result.page);
  },

  _renderCmdPagination(totalPages, currentPage) {
    const pg = document.getElementById('cmdPagination');
    if (totalPages <= 1) { pg.innerHTML = ''; return; }
    pg.innerHTML = `
      <span class="pg-info">Page ${currentPage} / ${totalPages}</span>
      <button class="btn btn-sm" ${currentPage <= 1 ? 'disabled' : ''} onclick="App._goCmdPage(${currentPage - 1})">◀ Prev</button>
      <button class="btn btn-sm" ${currentPage >= totalPages ? 'disabled' : ''} onclick="App._goCmdPage(${currentPage + 1})">Next ▶</button>
    `;
  },

  _goCmdPage(p) {
    this._cmdPage = p;
    this._loadCommands();
  },

  reloadCurrentView() {
    this._switchView(this._currentView);
  },

  _connectEvents() {
    try {
      this._events = API.connectEvents();
      this._events.onopen = () => {
        document.getElementById('connectionDot').classList.remove('disconnected');
        document.getElementById('connectionText').textContent = 'connected';
      };
      this._events.onerror = () => {
        document.getElementById('connectionDot').classList.add('disconnected');
        document.getElementById('connectionText').textContent = 'disconnected';
      };
      this._events.addEventListener('step_started', (e) => {
        this._onEvent(JSON.parse(e.data));
      });
      this._events.addEventListener('step_completed', (e) => {
        this._onEvent(JSON.parse(e.data));
      });
    } catch (_) {
      document.getElementById('connectionDot').classList.add('disconnected');
      document.getElementById('connectionText').textContent = 'disconnected';
    }
  },

  _onEvent(data) {
    // Auto-refresh current view when events arrive
    // Debounce: refresh at most once every 2 seconds
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.reloadCurrentView();
    }, 2000);
  }
};

// ── Boot ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());

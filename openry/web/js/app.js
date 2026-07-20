/* global API, WorkflowTree, CommandLog, TriggerPanel, MetricsCards */
// ── Main App Controller ─────────────────────────────

const App = {
  _currentView: 'workflows',
  _events: null,

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
      this._loadCommands();
    });

    // History filter
    document.getElementById('historyStatusFilter').addEventListener('change', () => {
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

    const status = document.getElementById('historyStatusFilter').value;
    try {
      const data = await API.getCompositions({ limit: 50, ...(status ? { status } : {}) });
      const comps = data.compositions || [];

      if (comps.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No runs found</td></tr>';
        return;
      }

      tbody.innerHTML = comps.map(c => {
        const statusIcon = c.status === 'completed' ? '✅' : c.status === 'failed' ? '❌' : c.status === 'running' ? '🔄' : '⏳';
        return `<tr onclick="App._showHistoryDetail(${c.id})" data-comp-id="${c.id}">
          <td style="font-family:monospace;color:var(--accent)">#${c.id}</td>
          <td>${c.composition}</td>
          <td>${statusIcon} ${c.status}</td>
          <td style="color:var(--text-muted)">${c.current_big_step || '-'}</td>
          <td style="font-size:11px;color:var(--text-muted)">${c.created_at || '-'}</td>
        </tr>`;
      }).join('');

    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">⚠️ ${e.message}</td></tr>`;
    }
  },

  async _showHistoryDetail(id) {
    // Highlight row
    document.querySelectorAll('#historyBody tr').forEach(r => r.classList.remove('active'));
    const row = document.querySelector(`#historyBody tr[data-comp-id="${id}"]`);
    if (row) row.classList.add('active');

    // Show detail
    const detail = document.getElementById('historyDetail');
    detail.classList.remove('hidden');
    detail.innerHTML = '<div class="empty-state"><p>Loading detail...</p></div>';

    try {
      const data = await API.getComposition(id);
      const comp = data.composition;
      const steps = comp.steps || [];

      let html = `<h3 style="margin-bottom:12px">📋 ${comp.composition} <span style="font-weight:400;font-size:13px">#${comp.id}</span></h3>`;

      // Group by big_step_ref
      const groups = {};
      steps.forEach(s => {
        const ref = s.big_step_ref || 'default';
        if (!groups[ref]) groups[ref] = [];
        groups[ref].push(s);
      });

      for (const [ref, groupSteps] of Object.entries(groups)) {
        html += `<div class="big-step"><div class="big-step-header" onclick="this.parentElement.classList.toggle('collapsed')"><span class="big-step-arrow">▼</span><span>📦 ${ref}</span></div><div class="big-step-body">`;
        groupSteps.forEach((s, i) => {
          const icon = s.status === 'completed' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'in_progress' ? '🔄' : '⏳';
          html += `<div class="sub-step">
            <span class="sub-step-id">${s.sub_step_id || `step-${i+1}`}</span>
            <span class="sub-step-desc">${icon} ${s.status}</span>
            <span class="sub-step-stats">${s.run_id ? s.run_id.substring(0,12) : ''}</span>
          </div>`;
        });
        html += `</div></div>`;
      }

      detail.innerHTML = html;
    } catch (e) {
      detail.innerHTML = `<div class="empty-state"><p>⚠️ ${e.message}</p></div>`;
    }
  },

  _loadCommands() {
    const params = {};
    const runId = document.getElementById('cmdRunIdFilter').value.trim();
    const status = document.getElementById('cmdStatusFilter').value;
    if (runId) params.run_id = runId;
    if (status) params.status = status;
    CommandLog.load(params);
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

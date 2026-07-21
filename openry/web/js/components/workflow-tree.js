/* global API */
// ── Workflow Tree Component ─────────────────────────

const WorkflowTree = {
  _container: null,
  _compositions: [],
  _stepTimer: null,
  _currentStepRunId: null,
  _compTimer: null,
  _currentCompId: null,

  init(containerId) {
    this._container = document.getElementById(containerId);
  },

  async loadWorkflows() {
    const sidebar = document.getElementById('workflowList');
    sidebar.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';

    try {
      const data = await API.getWorkflows();
      this._renderSidebar(data);
    } catch (e) {
      sidebar.innerHTML = `<div class="empty-state"><p>⚠️ Failed to load: ${e.message}</p></div>`;
    }
  },

  _renderSidebar(data) {
    const sidebar = document.getElementById('workflowList');
    const all = [...(data.compositions || [])];
    if (all.length === 0) {
      sidebar.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>No workflows found</p><p style="font-size:11px;margin-top:4px">Add .yaml files to ~/.openry/workflows/</p></div>';
      return;
    }

    sidebar.innerHTML = all.map(name => `
      <div class="card" data-workflow="${name}" onclick="WorkflowTree.selectWorkflow('${name}')">
        <div class="card-header">
          <span class="card-title">📋 ${name}</span>
        </div>
      </div>
    `).join('');
  },

  async selectWorkflow(name) {
    // Stop any active polling
    this._stopStepPolling();
    this._stopCompPolling();
    this._currentCompId = null;
    if (typeof TranscriptViewer !== 'undefined') TranscriptViewer.stop();
    const tp = document.getElementById('transcriptContent');
    if (tp) tp.innerHTML = '<div class="empty-state"><div class="empty-icon">💬</div><p>点击一个 step 查看对话记录</p></div>';

    // Highlight
    document.querySelectorAll('#workflowList .card').forEach(c => c.classList.remove('active'));
    const card = document.querySelector(`#workflowList .card[data-workflow="${name}"]`);
    if (card) card.classList.add('active');

    try {
      const data = await API.getCompositions({ limit: 5 });
      const matches = data.compositions.filter(c => c.composition === name);
      if (matches.length > 0) {
        this._currentCompId = matches[0].id;
        await this.showCompositionDetail(this._currentCompId);
        this._startCompPolling();
      } else {
        document.getElementById('workflowDetail').innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📋</div>
            <p>Workflow: <strong>${name}</strong></p>
            <p style="font-size:11px;color:var(--text-muted)">尚未运行过，点击右下角 ▶ 触发</p>
          </div>`;
      }
    } catch (e) {
      document.getElementById('workflowDetail').innerHTML = `<div class="empty-state"><p>⚠️ ${e.message}</p></div>`;
    }
  },

  async showCompositionDetail(id) {
    try {
      const data = await API.getComposition(id);
      const comp = data.composition;
      const steps = comp.steps || [];
      if (steps.length === 0) {
        document.getElementById('workflowDetail').innerHTML = `<div class="empty-state"><p>No steps data</p></div>`;
        return;
      }

      // Group by big_step_ref
      const groups = {};
      steps.forEach(s => {
        const ref = s.big_step_ref || 'default';
        if (!groups[ref]) groups[ref] = [];
        groups[ref].push(s);
      });

      let html = `<div class="detail-section">
        <h3>${comp.composition} <span style="font-weight:400;color:${this._statusColor(comp.status)}">${this._statusIcon(comp.status)} ${comp.status}</span></h3>
        <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">#${comp.id}</span></div>
        <div class="detail-row"><span class="detail-label">开始</span><span class="detail-value">${comp.created_at || '-'}</span></div>
      </div>
      <div class="comp-tree">`;

      for (const [ref, groupSteps] of Object.entries(groups)) {
        html += `<div class="big-step" data-ref="${ref}">
          <div class="big-step-header" onclick="WorkflowTree._toggleBigStep(this)">
            <span class="big-step-arrow">▼</span>
            <span>📦 ${ref}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${groupSteps.length} steps</span>
          </div>
          <div class="big-step-body">`;

        groupSteps.forEach((s, i) => {
          const isCurrent = s.status === 'in_progress';
          const cls = isCurrent ? 'current pulse' : '';
          html += `<div class="sub-step ${cls}" onclick="WorkflowTree._showStepDetail(event, '${s.run_id}')">
            <span class="sub-step-id">${s.sub_step_id || s.step_id || `step-${i+1}`}</span>
            <span class="sub-step-desc">${s.workflow || ''}</span>
            <span class="sub-step-stats">
              ${this._statusIcon(s.status)} ${s.status}
              ${s.max_tool_calls ? ` · ${s.tool_calls||0}/${s.max_tool_calls} calls` : ''}
            </span>
          </div>`;
        });

        html += `</div></div>`;
      }
      html += '</div>';  // close .comp-tree

      document.getElementById('workflowDetail').innerHTML = html;

      // Reload payloads
      try {
        const pdata = await API.getCompositionPayload(id);
        this._appendPayloads(pdata.payloads);
      } catch (_) {}

    } catch (e) {
      document.getElementById('workflowDetail').innerHTML = `<div class="empty-state"><p>⚠️ ${e.message}</p></div>`;
    }
  },

  _appendPayloads(payloads) {
    const detail = document.getElementById('workflowDetail');
    // Avoid duplicate payload sections
    detail.querySelectorAll('.payloads-section').forEach(el => el.remove());
    let html = '<div class="detail-section payloads-section"><h3>Payloads</h3>';
    for (const [runId, payload] of Object.entries(payloads)) {
      const content = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      html += `<div style="margin-bottom:8px">
        <span style="font-size:11px;color:var(--text-muted);font-family:monospace">${runId}</span>
        <div class="payload-viewer"><pre>${this._escape(content)}</pre></div>
      </div>`;
    }
    html += '</div>';
    detail.insertAdjacentHTML('beforeend', html);
  },

  _toggleBigStep(header) {
    const bigStep = header.parentElement;
    bigStep.classList.toggle('collapsed');
  },

  async _showStepDetail(event, runId) {
    event.stopPropagation();
    // Stop any previous step polling
    this._stopStepPolling();
    this._currentStepRunId = runId;

    // Remove any previously appended step detail or payload sections
    const detail = document.getElementById('workflowDetail');
    detail.querySelectorAll('.step-detail, .payloads-section').forEach(el => el.remove());

    await this._refreshStepCommands(runId);

    // Load transcript into the right-side panel
    const tc = document.getElementById('transcriptContent');
    if (tc && typeof TranscriptViewer !== 'undefined') {
      TranscriptViewer.load(tc, runId);
    }

    // Start polling for new commands
    this._startStepPolling(runId);
  },

  _stopStepPolling() {
    if (this._stepTimer) { clearInterval(this._stepTimer); this._stepTimer = null; }
    this._currentStepRunId = null;
  },

  _startStepPolling(runId) {
    this._stopStepPolling();
    this._stepTimer = setInterval(() => this._refreshStepCommands(runId), 2000);
  },

  _stopCompPolling() {
    if (this._compTimer) { clearInterval(this._compTimer); this._compTimer = null; }
  },

  _startCompPolling() {
    this._stopCompPolling();
    if (!this._currentCompId) return;
    this._compTimer = setInterval(() => this._refreshCompTree(), 2000);
  },

  async _refreshCompTree() {
    if (!this._currentCompId) { this._stopCompPolling(); return; }
    try {
      const data = await API.getComposition(this._currentCompId);
      const comp = data.composition;
      const steps = comp.steps || [];
      const detail = document.getElementById('workflowDetail');

      const existingTree = detail.querySelector('.comp-tree');
      if (!existingTree) return;

      // Save collapsed state before replacing
      const collapsedRefs = new Set();
      existingTree.querySelectorAll('.big-step.collapsed').forEach(el => {
        collapsedRefs.add(el.dataset.ref);
      });

      // Group by big_step_ref
      const groups = {};
      steps.forEach(s => {
        const ref = s.big_step_ref || 'default';
        if (!groups[ref]) groups[ref] = [];
        groups[ref].push(s);
      });

      let html = '';
      for (const [ref, groupSteps] of Object.entries(groups)) {
        const collapsed = collapsedRefs.has(ref) ? ' collapsed' : '';
        html += `<div class="big-step${collapsed}" data-ref="${ref}">
          <div class="big-step-header" onclick="WorkflowTree._toggleBigStep(this)">
            <span class="big-step-arrow">▼</span>
            <span>📦 ${ref}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${groupSteps.length} steps</span>
          </div>
          <div class="big-step-body">`;

        groupSteps.forEach((s, i) => {
          const isCurrent = s.status === 'in_progress';
          const cls = isCurrent ? 'current pulse' : '';
          html += `<div class="sub-step ${cls}" onclick="WorkflowTree._showStepDetail(event, '${s.run_id}')">
            <span class="sub-step-id">${s.sub_step_id || s.step_id || `step-${i+1}`}</span>
            <span class="sub-step-desc">${s.workflow || ''}</span>
            <span class="sub-step-stats">
              ${this._statusIcon(s.status)} ${s.status}
              ${s.max_tool_calls ? ` · ${s.tool_calls||0}/${s.max_tool_calls} calls` : ''}
            </span>
          </div>`;
        });
        html += `</div></div>`;
      }
      existingTree.innerHTML = html;
    } catch (_) {}
  },

  async _refreshStepCommands(runId) {
    const detail = document.getElementById('workflowDetail');
    // Find existing step-detail container
    let stepEl = detail.querySelector('.step-detail');
    try {
      const data = await API.getCommands({ run_id: runId, limit: 20 });
      const commands = data.commands || [];
      if (commands.length === 0) return;

      let html = `<div class="detail-section">
        <h3>Step: <code style="font-size:12px">${runId}</code></h3>
        <p style="font-size:12px;color:var(--text-muted)">${commands.length} commands</p>
      </div>`;

      commands.forEach((cmd, i) => {
        html += `<div class="command-item expanded">
          <div class="command-item-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="command-index">#${commands.length - i}</span>
            <span class="command-cmd">${this._escape(cmd.command)}</span>
            <span class="command-exit ${cmd.exit_code === 0 ? 'success' : 'failed'}">${cmd.exit_code === 0 ? '✅' : '❌'} ${cmd.exit_code}</span>
            <span class="command-duration">${cmd.duration_ms}ms</span>
          </div>
          <div class="command-item-body">
            <div class="command-label">stdout</div>
            <div class="command-output">${this._escape(cmd.stdout || '(empty)')}</div>
            ${cmd.stderr ? `<div class="command-label">stderr</div><div class="command-output" style="color:var(--red)">${this._escape(cmd.stderr)}</div>` : ''}
          </div>
        </div>`;
      });

      if (stepEl) {
        stepEl.innerHTML = html;
      } else {
        html = `<div class="step-detail">${html}</div>`;
        detail.insertAdjacentHTML('beforeend', html);
      }
    } catch (_) {}
  },

  _statusIcon(status) {
    switch (status) {
      case 'completed': case 'validated': case 'done': return '✅';
      case 'failed': case 'cancelled': case 'dropped': return '❌';
      case 'in_progress': case 'running': return '🔄';
      case 'overflow': return '🟣';
      default: return '⏳';
    }
  },

  _statusColor(status) {
    switch (status) {
      case 'completed': case 'validated': case 'done': return 'var(--green)';
      case 'failed': case 'cancelled': case 'dropped': return 'var(--red)';
      case 'in_progress': case 'running': return 'var(--accent)';
      case 'overflow': return 'var(--purple)';
      default: return 'var(--text-muted)';
    }
  },

  _escape(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
};

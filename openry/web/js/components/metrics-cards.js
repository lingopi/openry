/* global API */
// ── Metrics Cards Component ─────────────────────────

const MetricsCards = {
  async load() {
    const grid = document.getElementById('metricsGrid');
    grid.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';

    try {
      const data = await API.getMetrics();
      this._render(data);
    } catch (e) {
      grid.innerHTML = `<div class="empty-state"><p>⚠️ ${e.message}</p></div>`;
    }
  },

  _render(data) {
    const grid = document.getElementById('metricsGrid');
    const cards = [
      { value: data.total_runs || 0, label: 'Total Runs', cls: '' },
      { value: data.running || 0, label: 'Running', cls: 'yellow' },
      { value: data.completed || 0, label: 'Completed', cls: 'green' },
      { value: data.failed || 0, label: 'Failed', cls: 'red' },
      { value: (data.success_rate || 0) + '%', label: 'Success Rate', cls: data.success_rate > 80 ? 'green' : 'yellow' },
      { value: data.total_commands || 0, label: 'Commands Executed', cls: '' },
    ];

    let html = cards.map(c => `
      <div class="metric-card ${c.cls}">
        <div class="metric-value">${c.value}</div>
        <div class="metric-label">${c.label}</div>
      </div>
    `).join('');

    // Add per-workflow breakdown
    if (data.by_workflow && data.by_workflow.length > 0) {
      html += '<div class="detail-section" style="grid-column:1/-1;margin-top:16px"><h3>Per Workflow</h3>';
      html += '<table class="data-table"><thead><tr><th>Workflow</th><th>Runs</th></tr></thead><tbody>';
      html += data.by_workflow.map(w => 
        `<tr><td>${w.workflow}</td><td>${w.count}</td></tr>`
      ).join('');
      html += '</tbody></table></div>';
    }

    grid.innerHTML = html;
  }
};

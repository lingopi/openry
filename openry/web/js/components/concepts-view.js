/* global API */
// ── Concepts View ─────────────────────────────────────
const ConceptsView = {
  async load() {
    const tbody = document.getElementById('conceptsBody');
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">Loading...</td></tr>';

    try {
      const data = await API.getConcepts();
      const concepts = data.concepts || [];

      if (concepts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">
          <div class="empty-state">
            <div class="empty-icon">🏷️</div>
            <p>暂无概念标签</p>
            <p class="text-muted" style="font-size:12px;">运行 Workflow 后，语义蒸馏会自动提炼概念</p>
          </div>
        </td></tr>`;
        return;
      }

      tbody.innerHTML = concepts.map(c => `
        <tr>
          <td>
            <div class="tag-list">
              ${c.labels.map(l => `<span class="tag">${this._escapeHtml(l)}</span>`).join(' ')}
            </div>
          </td>
          <td class="text-muted">${this._escapeHtml(c.description) || '—'}</td>
          <td><span class="badge badge-blue">${c.member_count}</span></td>
          <td class="text-muted text-sm">${this._formatDate(c.created_at)}</td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">
        <span class="text-red">加载失败: ${err.message}</span>
      </td></tr>`;
    }
  },

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  _formatDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso + 'Z'); // SQLite datetime is UTC without timezone
      return d.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  }
};

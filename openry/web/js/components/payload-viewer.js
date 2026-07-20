// ── Payload Viewer (used inline) ───────────────────
// This is a utility, not a component with its own container.
// Used by workflow-tree.js _appendPayloads and inline rendering.

const PayloadViewer = {
  render(obj) {
    if (!obj) return '<span style="color:var(--text-muted)">(empty)</span>';
    try {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return `<pre style="font-family:monospace;font-size:11px;white-space:pre-wrap;word-break:break-all">${this._esc(s)}</pre>`;
    } catch (_) {
      return `<span style="color:var(--red)">(error rendering)</span>`;
    }
  },

  _esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
};

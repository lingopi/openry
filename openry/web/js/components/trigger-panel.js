/* global API */
// ── Trigger Panel Component ─────────────────────────

const TriggerPanel = {
  _modal: null,

  init() {
    this._modal = document.getElementById('triggerModal');

    document.getElementById('fabTrigger').addEventListener('click', () => this.open());
    document.getElementById('btnCloseModal').addEventListener('click', () => this.close());
    document.getElementById('btnCancelTrigger').addEventListener('click', () => this.close());
    document.getElementById('btnRunTrigger').addEventListener('click', () => this._run());
    document.getElementById('triggerModal').addEventListener('click', (e) => {
      if (e.target === this._modal) this.close();
    });
  },

  async open() {
    this._modal.classList.remove('hidden');
    document.getElementById('triggerError').classList.add('hidden');

    try {
      const data = await API.getWorkflows();
      const compositions = data.compositions || [];
      const workflows = data.workflows || [];
      const sel = document.getElementById('triggerWorkflow');

      let html = '';
      if (compositions.length > 0) {
        html += '<optgroup label="📋 Compositions">';
        html += compositions.map(n => `<option value="${n}">${n}</option>`).join('');
        html += '</optgroup>';
      }
      if (workflows.length > 0) {
        html += '<optgroup label="⚡ Workflows">';
        html += workflows.map(n => `<option value="${n}">${n}</option>`).join('');
        html += '</optgroup>';
      }
      sel.innerHTML = html || '<option value="">-- No workflows --</option>';
    } catch (e) {
      document.getElementById('triggerWorkflow').innerHTML = '<option value="">-- Error loading --</option>';
    }
  },

  close() {
    this._modal.classList.add('hidden');
  },

  async _run() {
    const workflow = document.getElementById('triggerWorkflow').value;
    const payloadRaw = document.getElementById('triggerPayload').value;
    const errEl = document.getElementById('triggerError');

    if (!workflow) {
      errEl.textContent = '请选择一个 workflow';
      errEl.classList.remove('hidden');
      return;
    }

    let payload = {};
    try {
      payload = JSON.parse(payloadRaw);
    } catch (_) {
      errEl.textContent = 'Invalid JSON in payload';
      errEl.classList.remove('hidden');
      return;
    }

    try {
      const result = await API.triggerWorkflow(workflow, payload);
      errEl.classList.add('hidden');
      this.close();
      // Show success and reload
      alert(`✅ Workflow started!\nComposition ID: ${result.composition_id}`);
      if (typeof App !== 'undefined' && App.reloadCurrentView) App.reloadCurrentView();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  }
};

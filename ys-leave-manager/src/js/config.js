(function (PLUGIN_ID) {
  'use strict';

  // 假別預設值：法定/常見假別的初始建議規則，實際數字仍可在畫面上調整
  const DEFAULT_LEAVE_TYPES = [
    { code: 'ANNUAL', name: '特休', unit: 'hour', quotaMethod: 'seniority', fixedQuota: null, resetCycle: 'anniversary', requiresAttachment: false, isPaid: true },
    { code: 'SICK', name: '病假', unit: 'day', quotaMethod: 'fixed', fixedQuota: 30, resetCycle: 'anniversary', requiresAttachment: true, isPaid: false },
    { code: 'PERSONAL', name: '事假', unit: 'day', quotaMethod: 'fixed', fixedQuota: 14, resetCycle: 'anniversary', requiresAttachment: false, isPaid: false },
    { code: 'MARRIAGE', name: '婚假', unit: 'day', quotaMethod: 'fixed', fixedQuota: 8, resetCycle: 'once', requiresAttachment: true, isPaid: true },
    { code: 'FUNERAL', name: '喪假', unit: 'day', quotaMethod: 'kinship', fixedQuota: null, resetCycle: 'per_event', requiresAttachment: true, isPaid: true },
    { code: 'OFFICIAL', name: '公假', unit: 'day', quotaMethod: 'unlimited', fixedQuota: null, resetCycle: 'per_event', requiresAttachment: true, isPaid: true },
    { code: 'OTHER', name: '其他', unit: 'day', quotaMethod: 'unlimited', fixedQuota: null, resetCycle: 'per_event', requiresAttachment: false, isPaid: false }
    // 未來新增「加班補休」COMP，只要在這裡（或畫面上）多加一列，desktop.js/GAS 不用改
  ];
  // 額外常見假別 建議代碼
  const EXTRA_LEAVE_NAME_CODE_MAP = {
    '生理假': 'MENSTRUAL', '產假': 'MATERNITY', '陪產假': 'PATERNITY',
    '育嬰假': 'PARENTAL', '家庭照顧假': 'FAMILY_CARE', '工傷假': 'INJURY', '補休': 'COMP',
  };

  const LEAVE_NAME_CODE_MAP = Object.assign(
    {},
    Object.fromEntries(DEFAULT_LEAVE_TYPES.map(t => [t.name, t.code])),
    EXTRA_LEAVE_NAME_CODE_MAP
  );


  const config = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
  const state = config.leaveTypes ? JSON.parse(config.leaveTypes) : DEFAULT_LEAVE_TYPES;

  document.getElementById('appEmployee').value = config.appEmployee || '';
  document.getElementById('appBalance').value = config.appBalance || '';
  document.getElementById('appLeave').value = config.appLeave || '';
  document.getElementById('workStart').value = config.workStart || '09:00';
  document.getElementById('workEnd').value = config.workEnd || '18:00';
  document.getElementById('lunchStart').value = config.lunchStart || '12:00';
  document.getElementById('lunchEnd').value = config.lunchEnd || '13:00';
  document.getElementById('gasUrl').value = config.gasUrl || '';
  document.getElementById('clientSecret').value = config.clientSecret || '';

  function calcHoursPerDay() {
    const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const work = toMin(document.getElementById('workEnd').value) - toMin(document.getElementById('workStart').value);
    const lunch = toMin(document.getElementById('lunchEnd').value) - toMin(document.getElementById('lunchStart').value);
    document.getElementById('hoursPerDay').value = ((work - lunch) / 60).toFixed(1);
  }
  ['workStart', 'workEnd', 'lunchStart', 'lunchEnd'].forEach(id =>
    document.getElementById(id).addEventListener('change', calcHoursPerDay)
  );
  calcHoursPerDay();

  const QUOTA_METHODS = [
    ['seniority', '年資對照表'],
    ['fixed', '固定值'],
    ['kinship', '親等對照表'],
    ['unlimited', '不限額逐案簽核'],
  ];
  const RESET_CYCLES = [
    ['anniversary', '到職週年制'],
    ['calendar', '曆年制'],
    ['once', '一次性不重置'],
    ['per_event', '逐次核給'],
  ];

  function renderRow(row, index) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input data-field="code" value="${row.code}" /></td>
      <td><input data-field="name" value="${row.name}" /></td>
      <td>
        <select data-field="unit">
          <option value="hour" ${row.unit === 'hour' ? 'selected' : ''}>小時</option>
          <option value="day" ${row.unit === 'day' ? 'selected' : ''}>天</option>
        </select>
      </td>
      <td>
        <select data-field="quotaMethod">
          ${QUOTA_METHODS.map(([v, l]) => `<option value="${v}" ${row.quotaMethod === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </td>
      <td><input data-field="fixedQuota" type="number" value="${row.fixedQuota ?? ''}" /></td>
      <td>
        <select data-field="resetCycle">
          ${RESET_CYCLES.map(([v, l]) => `<option value="${v}" ${row.resetCycle === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </td>
      <td style="text-align:center"><input data-field="requiresAttachment" type="checkbox" ${row.requiresAttachment ? 'checked' : ''} /></td>
      <td style="text-align:center"><input data-field="isPaid" type="checkbox" ${row.isPaid ? 'checked' : ''} /></td>
      <td style="text-align:center"><button type="button" class="btn-remove-circle" data-index="${index}" title="刪除此假別">&times;</button></td>
    `;

    const nameInput = tr.querySelector('[data-field="name"]');
    const codeInput = tr.querySelector('[data-field="code"]');
    nameInput.addEventListener('blur', () => {
      const suggested = LEAVE_NAME_CODE_MAP[nameInput.value.trim()];
      if (suggested && !codeInput.value.trim()) {
        codeInput.value = suggested;
      }
    });

    return tr;
  }

  function renderTable() {
    const body = document.getElementById('leaveTypeBody');
    body.innerHTML = '';
    state.forEach((row, i) => body.appendChild(renderRow(row, i)));
    body.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        state.splice(Number(btn.dataset.index), 1);
        renderTable();
      });
    });
  }
  renderTable();

  document.getElementById('btnAddRow').addEventListener('click', () => {
    state.push({ code: '', name: '', unit: 'day', quotaMethod: 'fixed', fixedQuota: 0, resetCycle: 'anniversary', requiresAttachment: false, isPaid: true });
    renderTable();
  });

  function collectStateFromDOM() {
    const rows = document.querySelectorAll('#leaveTypeBody tr');
    rows.forEach((tr, i) => {
      state[i].code = tr.querySelector('[data-field="code"]').value.trim();
      state[i].name = tr.querySelector('[data-field="name"]').value.trim();
      state[i].unit = tr.querySelector('[data-field="unit"]').value;
      state[i].quotaMethod = tr.querySelector('[data-field="quotaMethod"]').value;
      const fq = tr.querySelector('[data-field="fixedQuota"]').value;
      state[i].fixedQuota = fq === '' ? null : Number(fq);
      state[i].resetCycle = tr.querySelector('[data-field="resetCycle"]').value;
      state[i].requiresAttachment = tr.querySelector('[data-field="requiresAttachment"]').checked;
      state[i].isPaid = tr.querySelector('[data-field="isPaid"]').checked;
    });
  }

  document.getElementById('btnSave').addEventListener('click', () => {
    // ---- 必填欄位檢查 ----
    const requiredFields = [
      { id: 'appEmployee', label: '員工主檔 App ID' },
      { id: 'appBalance', label: '假別額度 App ID' },
      { id: 'appLeave', label: '請假申請 App ID' },
      { id: 'gasUrl', label: 'GAS Webhook URL' },
      { id: 'clientSecret', label: 'Client Secret' },
    ];
    let firstInvalidEl = null;
    const missing = [];
    requiredFields.forEach(({ id, label }) => {
      const el = document.getElementById(id);
      if (!el.value.trim()) {
        el.classList.add('field-error');
        missing.push(label);
        if (!firstInvalidEl) firstInvalidEl = el;
      } else {
        el.classList.remove('field-error');
      }
    });
    if (missing.length) {
      alert('以下欄位為必填，請填寫後再儲存：\n' + missing.join('、'));
      firstInvalidEl.focus();
      return;
    }

    collectStateFromDOM();

    const codes = state.map(r => r.code);
    if (codes.some(c => !c) || new Set(codes).size !== codes.length) {
      alert('假別代碼不可空白或重複，請檢查後再儲存');
      return;
    }

    const newConfig = {
      appEmployee: document.getElementById('appEmployee').value.trim(),
      appBalance: document.getElementById('appBalance').value.trim(),
      appLeave: document.getElementById('appLeave').value.trim(),
      workStart: document.getElementById('workStart').value,
      workEnd: document.getElementById('workEnd').value,
      lunchStart: document.getElementById('lunchStart').value,
      lunchEnd: document.getElementById('lunchEnd').value,
      gasUrl: document.getElementById('gasUrl').value.trim(),
      clientSecret: document.getElementById('clientSecret').value,
      leaveTypes: JSON.stringify(state),
    };

    kintone.plugin.app.setConfig(newConfig, () => {
      alert('設定已儲存');
      window.location.href = '../../flow?app=' + kintone.app.getId();
    });
  });

  document.getElementById('btnCancel').addEventListener('click', () => {
    window.location.href = '../../flow?app=' + kintone.app.getId();
  });

})(kintone.$PLUGIN_ID);

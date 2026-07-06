/* =============================================
   ERP 自動編號外掛 - 設定頁邏輯
   ============================================= */

(function () {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  // ── 讀取已儲存設定 ──────────────────────────────
  const saved = kintone.plugin.app.getConfig(PLUGIN_ID);

  // ── DOM refs ───────────────────────────────────
  const el = {
    fieldCode:        document.getElementById('fieldCode'),
    prefix:           document.getElementById('prefix'),
    digits:           document.getElementById('digits'),
    resetMode:        document.getElementById('resetMode'),
    conditionalField: document.getElementById('conditionalField'),
    conditionSection: document.getElementById('conditionSection'),
    conditionRows:    document.getElementById('conditionRows'),
    addConditionRow:  document.getElementById('addConditionRow'),
    previewBadge:     document.getElementById('previewBadge'),
    pvPrefix:         document.getElementById('pvPrefix'),
    pvDate:           document.getElementById('pvDate'),
    pvSeq:            document.getElementById('pvSeq'),
    saveBtn:          document.getElementById('saveBtn'),
    cancelBtn:        document.getElementById('cancelBtn'),
    presetBtns:       document.querySelectorAll('.preset-btn'),
  };

  // ── 初始化填入已儲存值 ──────────────────────────
  function init() {
    if (saved.fieldCode)        el.fieldCode.value        = saved.fieldCode;
    if (saved.prefix)           el.prefix.value           = saved.prefix;
    if (saved.digits)           el.digits.value           = saved.digits;
    if (saved.resetMode)        el.resetMode.value        = saved.resetMode;
    if (saved.conditionalField) el.conditionalField.value = saved.conditionalField;

    // 條件對應表
    if (saved.conditions) {
      try {
        const conditions = JSON.parse(saved.conditions);
        conditions.forEach(c => addConditionRow(c.value, c.prefix));
      } catch (_) {}
    }

    updatePreview();
    updateConditionSection();
  }

  // ── 即時預覽 ───────────────────────────────────
  function getTodayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  function updatePreview() {
    const prefix = (el.prefix.value || 'XX').toUpperCase();
    const digits  = parseInt(el.digits.value || '3', 10);
    const seq     = '1'.padStart(digits, '0');
    const dateStr = getTodayStr();

    el.pvPrefix.textContent = prefix;
    el.pvDate.textContent   = dateStr;
    el.pvSeq.textContent    = seq;
    el.previewBadge.textContent = `${prefix}-${dateStr}-${seq}`;
  }

  el.prefix.addEventListener('input', updatePreview);
  el.digits.addEventListener('change', updatePreview);

  // ── 快速套用預設 ───────────────────────────────
  el.presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const prefix = btn.dataset.prefix;
      el.prefix.value = prefix;
      el.presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updatePreview();
    });
  });

  // 如果已有儲存的 prefix，標記對應 preset 按鈕
  if (saved.prefix) {
    el.presetBtns.forEach(btn => {
      if (btn.dataset.prefix === saved.prefix) btn.classList.add('active');
    });
  }

  // ── 條件分段 ───────────────────────────────────
  function updateConditionSection() {
    const hasField = el.conditionalField.value.trim() !== '';
    el.conditionSection.classList.toggle('hidden', !hasField);
  }

  el.conditionalField.addEventListener('input', updateConditionSection);

  function addConditionRow(value = '', prefix = '') {
    const row = document.createElement('div');
    row.className = 'condition-row';
    row.innerHTML = `
      <input type="text" class="cond-value" placeholder="欄位值（如：倉庫）" value="${value}" />
      <span style="color:#94a3b8;font-size:13px;white-space:nowrap">→ 前綴</span>
      <input type="text" class="cond-prefix" placeholder="WH" maxlength="10" value="${prefix}" style="max-width:100px;" />
      <button type="button" class="btn-remove-row" title="刪除">✕</button>
    `;
    row.querySelector('.btn-remove-row').addEventListener('click', () => row.remove());
    el.conditionRows.appendChild(row);
  }

  el.addConditionRow.addEventListener('click', () => addConditionRow());

  // ── 取消 ───────────────────────────────────────
  el.cancelBtn.addEventListener('click', () => {
    history.back();
  });

  // ── 儲存 ───────────────────────────────────────
  el.saveBtn.addEventListener('click', () => {
    const fieldCode = el.fieldCode.value.trim();
    const prefix    = el.prefix.value.trim().toUpperCase();

    if (!fieldCode) {
      showToast('請填入編號欄位代碼', 'error');
      el.fieldCode.focus();
      return;
    }
    if (!prefix) {
      showToast('請填入前綴代碼', 'error');
      el.prefix.focus();
      return;
    }

    // 收集條件對應
    const conditionRows = el.conditionRows.querySelectorAll('.condition-row');
    const conditions = [];
    conditionRows.forEach(row => {
      const v = row.querySelector('.cond-value').value.trim();
      const p = row.querySelector('.cond-prefix').value.trim().toUpperCase();
      if (v && p) conditions.push({ value: v, prefix: p });
    });

    const config = {
      fieldCode:        fieldCode,
      prefix:           prefix,
      digits:           el.digits.value,
      resetMode:        el.resetMode.value,
      conditionalField: el.conditionalField.value.trim(),
      conditions:       JSON.stringify(conditions),
    };

    kintone.plugin.app.setConfig(config, () => {
      showToast('✓ 設定已儲存', 'success');
      setTimeout(() => history.back(), 1200);
    });
  });

  // ── Toast（設定頁用，輕量版）──────────────────
  function showToast(message, type = 'info') {
    const existing = document.querySelector('.erp-config-toast');
    if (existing) existing.remove();

    const colors = {
      success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d' },
      error:   { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626' },
      info:    { bg: '#eff6ff', border: '#93c5fd', text: '#2563eb' },
    };
    const c = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.className = 'erp-config-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      top: '20px',
      left: '50%',
      transform: 'translateX(-50%) translateY(-10px)',
      padding: '11px 22px',
      background: c.bg,
      border: `1.5px solid ${c.border}`,
      color: c.text,
      borderRadius: '8px',
      fontWeight: '600',
      fontSize: '14px',
      boxShadow: '0 4px 16px rgba(0,0,0,.12)',
      zIndex: '9999',
      opacity: '0',
      transition: 'all .25s ease',
      whiteSpace: 'nowrap',
    });

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      Object.assign(toast.style, {
        opacity: '1',
        transform: 'translateX(-50%) translateY(0)',
      });
    });

    if (type !== 'error') {
      setTimeout(() => {
        Object.assign(toast.style, {
          opacity: '0',
          transform: 'translateX(-50%) translateY(-10px)',
        });
        setTimeout(() => toast.remove(), 300);
      }, 2500);
    }
  }

  // ── Header 收合 ────────────────────────────────
  (function () {
    const toggle  = document.getElementById('headerToggle');
    const notice  = document.getElementById('headerNotice');
    const arrow   = document.getElementById('headerArrow');
    if (!toggle || !notice || !arrow) return;

    // 預設展開
    let isOpen = true;

    function applyState() {
      if (isOpen) {
        notice.style.maxHeight  = notice.scrollHeight + 'px';
        notice.style.paddingTop = '16px';
        notice.style.paddingBottom = '16px';
        notice.style.opacity    = '1';
        arrow.style.transform   = 'rotate(180deg)';
      } else {
        notice.style.maxHeight  = '0';
        notice.style.paddingTop = '0';
        notice.style.paddingBottom = '0';
        notice.style.opacity    = '0';
        arrow.style.transform   = 'rotate(0deg)';
      }
    }

    // 初始設定 transition
    notice.style.transition = 'max-height .35s ease, padding .35s ease, opacity .3s ease';
    notice.style.overflow   = 'hidden';
    applyState();

    toggle.addEventListener('click', () => {
      isOpen = !isOpen;
      applyState();
    });
  })();

  // ── 啟動 ───────────────────────────────────────
  init();

})();

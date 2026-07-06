/* =============================================
   ERP 自動編號外掛 - 主程式 (桌機 + 手機共用)
   v1.1 修正：submit 階段不再顯示「已成功產生編號」，
   改為只在 submit.success（真正存檔成功後）才提示成功，
   避免被同一張表單上其他外掛擋下存檔時造成誤導。
   ============================================= */

(function () {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  // ── 讀取外掛設定 ──────────────────────────────
  const cfg = kintone.plugin.app.getConfig(PLUGIN_ID);

  const FIELD_CODE        = cfg.fieldCode        || '';
  const BASE_PREFIX       = cfg.prefix           || '';
  const DIGITS            = parseInt(cfg.digits  || '3', 10);
  const RESET_MODE        = cfg.resetMode        || 'daily';
  const CONDITIONAL_FIELD = cfg.conditionalField || '';
  const CONDITIONS        = (() => {
    try { return JSON.parse(cfg.conditions || '[]'); } catch (_) { return []; }
  })();

  if (!FIELD_CODE || !BASE_PREFIX) {
    console.warn('[ERP AutoNumber] 外掛尚未設定，請至外掛設定頁完成設定。');
    return;
  }

  // ══════════════════════════════════════════════
  //  工具函式
  // ══════════════════════════════════════════════

  /** 取得今天的日期字串 YYYYMMDD */
  function getDateStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  /** 取得本月字串 YYYYMM（用於月重置模式） */
  function getMonthStr() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** 決定實際前綴（考慮條件分段） */
  function resolvePrefix(record) {
    if (CONDITIONAL_FIELD && CONDITIONS.length > 0) {
      const fieldVal = record[CONDITIONAL_FIELD] && record[CONDITIONAL_FIELD].value;
      if (fieldVal) {
        const matched = CONDITIONS.find(c => c.value === fieldVal);
        if (matched) return matched.prefix.toUpperCase();
      }
    }
    return BASE_PREFIX.toUpperCase();
  }

  /** 流水號補零 */
  function pad(n) {
    return String(n).padStart(DIGITS, '0');
  }

  /** 建立查詢字串（依重置模式決定查詢範圍） */
  function buildQuery(prefix) {
    // 格式：PREFIX-YYYYMMDD-NNN 或 PREFIX-YYYYMM-NNN 或 PREFIX-NNN
    const dateStr = RESET_MODE === 'daily'   ? getDateStr()  :
                    RESET_MODE === 'monthly' ? getMonthStr() : '';

    const searchPrefix = dateStr
      ? `${prefix}-${dateStr}-`
      : `${prefix}-`;

    return `${FIELD_CODE} like "${searchPrefix}" order by ${FIELD_CODE} desc limit 1`;
  }

  /** 建立完整編號 */
  function buildNumber(prefix, seq) {
    const dateStr = RESET_MODE === 'daily'   ? getDateStr()  :
                    RESET_MODE === 'monthly' ? getMonthStr() : '';
    return dateStr
      ? `${prefix}-${dateStr}-${pad(seq)}`
      : `${prefix}-${pad(seq)}`;
  }

  // ══════════════════════════════════════════════
  //  Toast 提示（不用 alert，漂亮的視覺回饋）
  // ══════════════════════════════════════════════

  const TOAST_STYLES = {
    success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d', icon: '✓' },
    error:   { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626', icon: '✕' },
    loading: { bg: '#eff6ff', border: '#93c5fd', text: '#2563eb', icon: '⟳' },
    warn:    { bg: '#fffbeb', border: '#fde68a', text: '#d97706', icon: '⚠' },
  };

  let _toastEl = null;

  function showToast(message, type = 'info', duration = 3000) {
    if (_toastEl) {
      _toastEl.remove();
      _toastEl = null;
    }

    const s = TOAST_STYLES[type] || TOAST_STYLES.success;
    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    Object.assign(toast.style, {
      position:     'fixed',
      top:          '20px',
      left:         '50%',
      transform:    'translateX(-50%) translateY(-16px)',
      display:      'flex',
      alignItems:   'center',
      gap:          '10px',
      padding:      '13px 20px',
      background:   s.bg,
      border:       `1.5px solid ${s.border}`,
      borderRadius: '10px',
      color:        s.text,
      fontWeight:   '600',
      fontSize:     '14px',
      fontFamily:   "'Segoe UI', 'Noto Sans TC', system-ui, sans-serif",
      boxShadow:    '0 6px 24px rgba(0,0,0,.13)',
      zIndex:       '99999',
      opacity:      '0',
      transition:   'all .25s cubic-bezier(.34,1.56,.64,1)',
      whiteSpace:   'nowrap',
      pointerEvents:'none',
      maxWidth:     'calc(100vw - 32px)',
    });

    // 動態 spinner for loading
    if (type === 'loading') {
      const spinner = document.createElement('span');
      spinner.textContent = '⟳';
      Object.assign(spinner.style, {
        display:      'inline-block',
        fontSize:     '16px',
        animation:    'erp-spin 1s linear infinite',
      });

      if (!document.getElementById('erp-spin-style')) {
        const style = document.createElement('style');
        style.id = 'erp-spin-style';
        style.textContent = `@keyframes erp-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`;
        document.head.appendChild(style);
      }

      toast.appendChild(spinner);
    } else {
      const icon = document.createElement('span');
      icon.textContent = s.icon;
      Object.assign(icon.style, {
        fontSize:     '16px',
        flexShrink:   '0',
      });
      toast.appendChild(icon);
    }

    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    document.body.appendChild(toast);
    _toastEl = toast;

    requestAnimationFrame(() => {
      Object.assign(toast.style, {
        opacity:   '1',
        transform: 'translateX(-50%) translateY(0)',
      });
    });

    if (duration > 0) {
      setTimeout(() => hideToast(toast), duration);
    }

    return toast;
  }

  function hideToast(toast) {
    if (!toast || !toast.parentNode) return;
    Object.assign(toast.style, {
      opacity:   '0',
      transform: 'translateX(-50%) translateY(-10px)',
    });
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
      if (_toastEl === toast) _toastEl = null;
    }, 280);
  }

  // ══════════════════════════════════════════════
  //  Kintone 事件：新增畫面（含複製）→ 清空 + 鎖定
  // ══════════════════════════════════════════════

  kintone.events.on([
    'app.record.create.show',
    'mobile.app.record.create.show',
  ], function (event) {
    if (event.record[FIELD_CODE]) {
      event.record[FIELD_CODE].value    = '';  // 複製時清空舊編號，避免重複
      event.record[FIELD_CODE].disabled = true;
    }
    return event;
  });

  // ══════════════════════════════════════════════
  //  Kintone 事件：編輯畫面 → 只鎖定，不清空
  // ══════════════════════════════════════════════

  kintone.events.on([
    'app.record.edit.show',
    'mobile.app.record.edit.show',
  ], function (event) {
    if (event.record[FIELD_CODE]) {
      event.record[FIELD_CODE].disabled = true;
    }
    return event;
  });

  // ══════════════════════════════════════════════
  //  Kintone 事件：新增儲存 → 自動產生編號
  // ══════════════════════════════════════════════
  //
  // 🌟 注意：同一張表單上可能還有其他外掛（例如條碼掃描外掛）
  // 也掛在 create.submit 事件上做存檔前驗證。kintone 會把所有
  // 外掛的 submit 處理常式串接執行，只要任何一個（包含順序在
  // 本外掛之後執行的）設定了 event.error，整筆記錄就會放棄儲存。
  // 因此這裡產生編號後「不能」直接顯示『已成功』，只能顯示
  // 『編號已產生，儲存中…』這種中性訊息；真正的成功提示要等
  // submit.success 事件才顯示（見檔案最後）。

  kintone.events.on([
    'app.record.create.submit',
    'mobile.app.record.create.submit',
  ], async function (event) {
    const record = event.record;
    const appId  = event.appId || kintone.app.getId();

    // 若已有編號（理論上不應有，但防呆）
    if (record[FIELD_CODE] && record[FIELD_CODE].value) {
      return event;
    }

    const prefix = resolvePrefix(record);
    if (!prefix) {
      showToast('無法決定編號前綴，請確認設定', 'error', 0);
      event.error = '無法決定編號前綴，請確認外掛設定。';
      return event;
    }

    try {
      const query = buildQuery(prefix);
      const resp = await kintone.api(
        kintone.api.url('/k/v1/records', true),
        'GET',
        { app: appId, query: query, fields: [FIELD_CODE] }
      );

      let newSeq = 1;

      if (resp.records.length > 0) {
        const lastVal = resp.records[0][FIELD_CODE].value || '';
        // 取最後一段（流水號）
        const parts   = lastVal.split('-');
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) newSeq = lastSeq + 1;
      }

      const newNumber = buildNumber(prefix, newSeq);
      record[FIELD_CODE].value = newNumber;
      // 🌟 這裡不顯示任何 toast。記錄是否真的存檔成功要看 submit
      // 事件鏈上後面是否有其他外掛擋下，因此成功提示統一放到
      // submit.success（見檔案最後），避免存檔被擋下時畫面快速
      // 跳轉、疊出一堆互相矛盾的 toast。

    } catch (err) {
      console.error('[ERP AutoNumber] 自動編號失敗:', err);
      showToast('自動編號失敗，請聯絡系統管理員', 'error', 0);
      event.error = '自動編號發生錯誤，無法儲存。請聯絡系統管理員。';
    }

    return event;
  });

  // ══════════════════════════════════════════════
  //  Kintone 事件：編輯儲存 → 不變更（保護現有編號）
  // ══════════════════════════════════════════════
  //  複製後（實為新增），Submit 是 create.submit，
  //  所以複製的記錄在儲存時會走上面的新增流程，
  //  舊欄位值因為 disabled 過，不會被帶進去。
  //
  //  這裡只需確保 edit 時欄位維持唯讀即可，不重複編號。

  kintone.events.on([
    'app.record.edit.submit',
    'mobile.app.record.edit.submit',
  ], function (event) {
    // 欄位已 disabled，kintone 不會更新該欄位，直接放行
    return event;
  });

  // ══════════════════════════════════════════════
  //  Kintone 事件：真正存檔成功後才顯示成功提示
  // ══════════════════════════════════════════════
  //  submit.success 只會在記錄確實寫入資料庫後才觸發；
  //  若 submit 事件鏈中有任何外掛（包含本外掛自己）設定了
  //  event.error，kintone 會整筆放棄儲存，不會走到這裡。
  //  因為 submit 階段完全不顯示任何 toast，這裡是唯一會
  //  跳出提示的時機，不會有多個 toast 互相覆蓋的問題。

  kintone.events.on([
    'app.record.create.submit.success',
    'mobile.app.record.create.submit.success',
  ], function (event) {
    const num = event.record[FIELD_CODE] && event.record[FIELD_CODE].value;
    if (num) showToast(`✓ 編號已儲存：${num}`, 'success', 2500);
    return event;
  });

})();
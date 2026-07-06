(function (PLUGIN_ID) {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // config.js — 進貨 / 出貨 / 調撥 三態設定頁
  // ══════════════════════════════════════════════════════════════════
  //  Toast 工具
  // ══════════════════════════════════════════════════════════════════
  const TOAST_STYLES = {
    success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d', icon: '✓' },
    error: { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626', icon: '✕' },
    warn: { bg: '#fffbeb', border: '#fde68a', text: '#d97706', icon: '⚠' },
    info: { bg: '#eff6ff', border: '#93c5fd', text: '#2563eb', icon: 'ℹ' },
  };
  let _toastEl = null;

  function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration === undefined ? 3000 : duration;
    if (_toastEl) { _toastEl.remove(); _toastEl = null; }
    const s = TOAST_STYLES[type] || TOAST_STYLES.info;
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed', top: '20px', left: '50%',
      transform: 'translateX(-50%) translateY(-16px)',
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '13px 20px', background: s.bg,
      border: `1.5px solid ${s.border}`, borderRadius: '10px',
      color: s.text, fontWeight: '600', fontSize: '14px',
      fontFamily: "'Segoe UI','Noto Sans TC',system-ui,sans-serif",
      boxShadow: '0 6px 24px rgba(0,0,0,.13)', zIndex: '99999',
      opacity: '0', transition: 'all .25s cubic-bezier(.34,1.56,.64,1)',
      whiteSpace: 'nowrap', pointerEvents: 'none', maxWidth: 'calc(100vw - 32px)',
    });

    const icon = document.createElement('span');
    icon.textContent = s.icon;
    icon.style.fontSize = '16px';

    const text = document.createElement('span');
    text.textContent = message;
    toast.append(icon, text);
    document.body.appendChild(toast);
    _toastEl = toast;
    requestAnimationFrame(() => {
      Object.assign(toast.style, { opacity: '1', transform: 'translateX(-50%) translateY(0)' });
    });
    if (duration > 0) {
      setTimeout(() => {
        Object.assign(toast.style, { opacity: '0', transform: 'translateX(-50%) translateY(-10px)' });
        setTimeout(() => { toast.remove(); if (_toastEl === toast) _toastEl = null; }, 280);
      }, duration);
    }
    return toast;
  }

  // ══════════════════════════════════════════════════════════════════
  //  各模式的下拉選單預設值（欄位代碼自動配對）
  //  三份字典 key 完全一致，方便切換模式時整組覆蓋／清空。
  // ══════════════════════════════════════════════════════════════════
  const DEFAULTS_IN = {
    fPoNum: '採購單號',
    fSupplierName: '廠商名稱',
    fSupplierKey: '廠商全名',
    fCustomerType: '',
    fCustomerName: '',
    fStatus: '',
    fSubtable: '採購內容',
    fProdName: '商品名稱',
    fProdCode: '商品料號',
    fBarcode: '條碼編號',
    fPrice: '單價',
    fListPrice: '廠商定價',
    fPoQty: '採購數量',
    fInQty: '已入庫數量',
    fWh: '收貨倉庫',
    fWhTrigger: '',
    fFromWh: '', fToWh: '', fFromWhTrigger: '', fToWhTrigger: '',
    fTransferStatus: '', fTransferType: '', fReturnStatus: '', fRefNo: '', fTransferDate: '', fUnit: '',
  };

  const DEFAULTS_OUT = {
    fPoNum: '銷貨單號',
    fSupplierName: '',
    fSupplierKey: '',
    fCustomerType: '客戶類型',
    fCustomerName: '客戶名稱',
    fStatus: '是否結案',
    fSubtable: '銷售內容',
    fProdName: '商品名稱',
    fProdCode: '商品料號',
    fBarcode: '條碼編號',
    fPrice: '實際售價',
    fListPrice: '商品售價',
    fPoQty: '數量',
    fInQty: '',
    fWh: '出貨倉庫',
    // 倉庫的「Lookup 連動目標欄位」，用來觸發 change 事件。
    // 出貨倉庫本身是 Lookup 欄位，操作它不會觸發 change，
    // 但它連動寫入的「倉庫編號」這個唯讀欄位會觸發，因此預設指向倉庫編號。
    fWhTrigger: '倉庫編號',
    fFromWh: '', fToWh: '', fFromWhTrigger: '', fToWhTrigger: '',
    fTransferStatus: '', fTransferType: '', fReturnStatus: '', fRefNo: '', fTransferDate: '', fUnit: '',
  };

  const DEFAULTS_TRANSFER = {
    fPoNum: '調撥單號',
    fSupplierName: '',
    fSupplierKey: '',
    fCustomerType: '',
    fCustomerName: '',
    fStatus: '',
    fSubtable: '調撥內容',
    fProdName: '商品名稱',
    fProdCode: '商品料號',
    fBarcode: '條碼編號',
    fPrice: '',
    fListPrice: '',
    fPoQty: '調撥數量',
    fInQty: '',
    fWh: '',
    fWhTrigger: '',
    // 調撥雙倉庫：撥出／撥入各自一個欄位，跟進貨/出貨的「單一倉庫」假設不同
    fFromWh: '撥出倉庫',
    fToWh: '撥入倉庫',
    fFromWhTrigger: '撥出倉庫_單位編號',
    fToWhTrigger: '撥入倉庫_單位編號',
    fTransferStatus: '調撥狀態',
    fTransferType: '調撥性質',
    fReturnStatus: '歸還狀態',
    fRefNo: '對應借調單號',
    fTransferDate: '調撥日期',
    fUnit: '單位',
  };

  const DEFAULTS_BY_MODE = { in: DEFAULTS_IN, out: DEFAULTS_OUT, transfer: DEFAULTS_TRANSFER };

  // 文字輸入框（非模式相關，三種模式共用同一份）
  const TEXT_DEFAULTS = {
    productAppId: '',
    invAppId: '',
    customerAppId: '',
    prodBarcode: '條碼編號',
    prodNameField: '中文名稱',
    prodCodeField: '商品料號',
    prodSuppTable: '供應商選單',
    suppName: '廠商名稱',
    suppPrice: '廠商定價',
    scanSpaceId: 'scan_space',
  };

  // 文字框與下拉選單的 ID 集合
  const CONFIG_KEYS = [
    'productAppId', 'invAppId', 'scanSpaceId', 'customerAppId',
    'prodBarcode', 'prodNameField', 'prodCodeField', 'prodSuppTable', 'suppName', 'suppPrice',
    'fPoNum', 'fSupplierName', 'fSupplierKey', 'fCustomerType', 'fCustomerName', 'fStatus',
    'fSubtable', 'fProdName', 'fProdCode', 'fBarcode', 'fPrice', 'fListPrice', 'fPoQty', 'fInQty', 'fWh', 'fWhTrigger',
    'fFromWh', 'fToWh', 'fFromWhTrigger', 'fToWhTrigger',
    'fTransferStatus', 'fTransferType', 'fReturnStatus', 'fRefNo', 'fTransferDate', 'fUnit',
  ];

  // 進貨專用欄位/開關 的 wrapper 元素 ID（出貨／調撥模式時隱藏）
  const IN_ONLY_WRAPS = [
    'wrap-suppTable', 'wrap-suppName', 'wrap-suppPrice',
    'wrap-supplierName', 'wrap-supplierKey',
    'wrap-inQty',
    'wrap-toggle-suppGuard', 'wrap-toggle-autoSupp',
  ];

  // 出貨專用欄位 的 wrapper 元素 ID（進貨／調撥模式時隱藏）
  const OUT_ONLY_WRAPS = [
    'wrap-customerApp', 'wrap-customerName', 'wrap-customerType', 'wrap-status', 'wrap-whTrigger'
  ];

  // 進貨／出貨共用、但調撥模式用不到的 wrapper（單一倉庫、價格）
  const IN_OUT_WRAPS = [
    'wrap-wh', 'wrap-price', 'wrap-listPrice',
  ];

  // 調撥專用欄位 的 wrapper 元素 ID（進貨／出貨模式時隱藏）
  const TRANSFER_ONLY_WRAPS = [
    'wrap-fromWh', 'wrap-toWh', 'wrap-fromWhTrigger', 'wrap-toWhTrigger',
    'wrap-transferStatus', 'wrap-transferType', 'wrap-returnStatus', 'wrap-refNo', 'wrap-transferDate',
    'wrap-unit',
  ];

  // 各 select 要從哪一份欄位清單取得選項（依 field code 對應的實際 kintone 欄位類型分類）
  const NORMAL_FIELD_KEYS = [
    'fPoNum', 'fSupplierName', 'fSupplierKey', 'fCustomerType', 'fCustomerName', 'fStatus',
    'fFromWh', 'fToWh', 'fFromWhTrigger', 'fToWhTrigger',
    'fTransferStatus', 'fTransferType', 'fReturnStatus', 'fRefNo', 'fTransferDate',
  ];
  const SUBTABLE_FIELD_KEYS = ['fSubtable'];
  const SUBTABLE_INNER_FIELD_KEYS = [
    'fProdName', 'fProdCode', 'fBarcode', 'fPrice', 'fListPrice', 'fPoQty', 'fInQty', 'fWh', 'fWhTrigger', 'fUnit',
  ];

  // 功能開關的 ID 集合
  const TOGGLES = [
    'enableSupplierGuard', 'enableInventorySync', 'isShipment', 'enableAutoFillSupplier'
  ];

  let currentMode = 'in'; // 'in' | 'out' | 'transfer'

  function applyModeVisibility(mode) {
    const show = (ids, cond) => {
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('is-hidden', !cond);
      });
    };

    show(IN_ONLY_WRAPS, mode === 'in');
    show(OUT_ONLY_WRAPS, mode === 'out');
    show(IN_OUT_WRAPS, mode === 'in' || mode === 'out');
    show(TRANSFER_ONLY_WRAPS, mode === 'transfer');

    const btnIn = document.getElementById('mode-btn-in');
    const btnOut = document.getElementById('mode-btn-out');
    const btnTransfer = document.getElementById('mode-btn-transfer');
    if (btnIn) btnIn.classList.toggle('active-in', mode === 'in');
    if (btnOut) btnOut.classList.toggle('active-out', mode === 'out');
    if (btnTransfer) btnTransfer.classList.toggle('active-transfer', mode === 'transfer');

    // 動態標籤文字（依模式顯示對應的範例欄位名稱，只在該標籤存在時更新）
    const labelsByMode = {
      in: {
        'lbl-poNum': '單號欄位 (採購單號)',
        'lbl-subtable': '子表格代碼 (採購內容)',
        'lbl-price': '價格欄位 (單價)',
        'lbl-listPrice': '定價欄位 (廠商定價)',
        'lbl-poQty': '數量欄位 (採購數量)',
        'lbl-wh': '倉庫欄位 (收貨倉庫)',
      },
      out: {
        'lbl-poNum': '單號欄位 (銷貨單號)',
        'lbl-subtable': '子表格代碼 (銷售內容)',
        'lbl-price': '價格欄位 (實際售價)',
        'lbl-listPrice': '定價欄位 (商品售價)',
        'lbl-poQty': '數量欄位 (數量)',
        'lbl-wh': '倉庫欄位 (出貨倉庫)',
      },
      transfer: {
        'lbl-poNum': '單號欄位 (調撥單號)',
        'lbl-subtable': '子表格代碼 (調撥內容)',
        'lbl-poQty': '數量欄位 (調撥數量)',
      },
    };
    const labels = labelsByMode[mode] || {};
    Object.keys(labels).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = labels[id];
    });
  }

  // 切換模式時，把對應模式的預設值套進下拉選單（直接覆蓋，方便使用者快速切換情境）
  function applyDefaultsToSelects(mode) {
    const defaults = DEFAULTS_BY_MODE[mode] || DEFAULTS_IN;
    Object.keys(defaults).forEach(key => {
      const el = document.getElementById(key);
      if (!el || el.tagName !== 'SELECT') return;
      const targetValue = defaults[key];
      if (targetValue && el.querySelector('option[value="' + targetValue.replace(/"/g, '') + '"]')) {
        el.value = targetValue;
      } else {
        el.value = '';
      }
    });
  }

  function switchMode(mode) {
    currentMode = mode;
    applyModeVisibility(mode);
    applyDefaultsToSelects(mode);
  }

  function init() {
    const config = kintone.plugin.app.getConfig(PLUGIN_ID);

    // 1. 還原文字輸入框設定（若無存檔則套用預設值）
    CONFIG_KEYS.forEach(function (key) {
      const el = document.getElementById(key);
      if (!el || el.tagName !== 'INPUT') return;
      if (config[key] !== undefined) {
        el.value = config[key];
      } else if (TEXT_DEFAULTS[key] !== undefined) {
        el.value = TEXT_DEFAULTS[key];
      }
    });

    // 2. 決定初始模式
    //    新版設定值優先讀 appMode（'in'|'out'|'transfer'）；
    //    若是舊版設定（只有 isShipment 布林），自動換算成 in/out，
    //    確保既有外掛設定升級後不會被重置。
    const initialMode = (config.appMode === 'in' || config.appMode === 'out' || config.appMode === 'transfer')
      ? config.appMode
      : (config.isShipment === '1' ? 'out' : 'in');

    // 3. 功能開關初始化（防呆：預設全部打勾啟用，出貨/調撥單除外的廠商相關開關）
    TOGGLES.forEach(function (key) {
      const el = document.getElementById(key);
      if (!el) return;
      if (config[key] !== undefined) {
        el.checked = (config[key] === '1');
      } else {
        el.checked = (key !== 'isShipment');
      }
    });

    // 4. 呼叫 Kintone API 獲取當前 App 的所有欄位，生成動態下拉選單
    kintone.api(kintone.api.url('/k/v1/preview/app/form/fields', true), 'GET', { app: kintone.app.getId() }).then(function (resp) {
      const fields = resp.properties;
      const normalFields = [], subtableFields = [], subtableInnerFields = [];

      for (const key in fields) {
        const field = fields[key];
        if (field.type === 'SUBTABLE') {
          subtableFields.push(field);
          for (const innerKey in field.fields) {
            subtableInnerFields.push(field.fields[innerKey]);
          }
        } else {
          normalFields.push(field);
        }
      }

      const fieldSelectors = {};
      NORMAL_FIELD_KEYS.forEach(k => { fieldSelectors[k] = normalFields; });
      SUBTABLE_FIELD_KEYS.forEach(k => { fieldSelectors[k] = subtableFields; });
      SUBTABLE_INNER_FIELD_KEYS.forEach(k => { fieldSelectors[k] = subtableInnerFields; });

      Object.keys(fieldSelectors).forEach(function (configKey) {
        const selectEl = document.getElementById(configKey);
        if (!selectEl || selectEl.tagName !== 'SELECT') return;

        selectEl.innerHTML = '<option value="">-- 請選擇對應欄位 --</option>';

        fieldSelectors[configKey].forEach(function (f) {
          const option = document.createElement('option');
          option.value = f.code;
          option.textContent = f.label + ' (' + f.code + ')';
          selectEl.appendChild(option);
        });
      });

      // 套用初始模式的值：若有存檔設定優先用存檔值，否則套用該模式的預設值
      const defaults = DEFAULTS_BY_MODE[initialMode] || DEFAULTS_IN;
      Object.keys(defaults).forEach(function (configKey) {
        const selectEl = document.getElementById(configKey);
        if (!selectEl || selectEl.tagName !== 'SELECT') return;
        const targetValue = config[configKey] !== undefined ? config[configKey] : defaults[configKey];
        if (targetValue) selectEl.value = targetValue;
      });
    }).catch(function (err) {
      console.error('無法取得欄位資訊：', err);
      showToast('無法取得欄位資訊，請確認 App 權限設定', 'error', 4000);
    });

    // 5. 套用初始模式的顯示/隱藏
    applyModeVisibility(initialMode);
    currentMode = initialMode;

    // 6. 綁定模式切換按鈕
    document.getElementById('mode-btn-in').addEventListener('click', function () {
      if (currentMode === 'in') return;
      switchMode('in');
    });
    document.getElementById('mode-btn-out').addEventListener('click', function () {
      if (currentMode === 'out') return;
      switchMode('out');
    });
    const btnTransfer = document.getElementById('mode-btn-transfer');
    if (btnTransfer) {
      btnTransfer.addEventListener('click', function () {
        if (currentMode === 'transfer') return;
        switchMode('transfer');
      });
    }

    // 7. 綁定儲存與取消按鈕
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveConfig);

    const cancelBtn = document.getElementById('cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function (e) {
        e.preventDefault();
        window.location.href = '../../' + kintone.app.getId() + '/plugin/';
      });
    }
  }

  // 儲存設定邏輯
  function saveConfig(e) {
    if (e) e.preventDefault();

    const productAppIdEl = document.getElementById('productAppId');
    if (!productAppIdEl || !productAppIdEl.value.trim()) {
      showToast('商品主檔 App ID 為必填欄位', 'error', 3000);
      if (productAppIdEl) productAppIdEl.focus();
      return;
    }

    const configToSave = {};

    CONFIG_KEYS.forEach(function (key) {
      const el = document.getElementById(key);
      if (el) configToSave[key] = el.value.trim();
    });

    TOGGLES.forEach(function (key) {
      const el = document.getElementById(key);
      if (el) configToSave[key] = el.checked ? '1' : '0';
    });

    // 模式切換結果：新版讀 appMode（三態），isShipment 仍一併寫入
    // 是為了跟舊版 core.js（若有其他 App 尚未更新外掛版本）相容。
    configToSave.appMode = currentMode;
    configToSave.isShipment = currentMode === 'out' ? '1' : '0';

    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '儲存中…';
    }

    kintone.plugin.app.setConfig(configToSave, function () {
      const saveMsg = document.getElementById('save-msg');
      if (saveMsg) saveMsg.textContent = '✓ 儲存成功，準備跳轉...';

      showToast('✅ 設定已成功儲存！', 'success', 1500);

      setTimeout(function () {
        window.location.href = '../../' + kintone.app.getId() + '/plugin/';
      }, 1500);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(kintone.$PLUGIN_ID);
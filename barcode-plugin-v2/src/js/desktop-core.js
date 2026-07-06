(function () {
  'use strict';

  /* ═══════════════════════════════════════════════
     ERP 萬用進出貨/調撥條碼掃描外掛 desktop-core.js v9.0
     - 共用命名空間：window.SP
     - 內容：設定讀取、API 查詢、Toast、scanPanel UI
     - 進貨 / 出貨 / 調撥 各自的「存檔驗證」「庫存同步」邏輯
       拆到 desktop-inbound.js / desktop-outbound.js / desktop-transfer.js，
       事件註冊統一在 desktop-events.js（調撥另有部分事件自行註冊，
       詳見 desktop-transfer.js 開頭說明）。
  ═══════════════════════════════════════════════ */

  const SP = window.SP = window.SP || {};

  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const cfg = kintone.plugin.app.getConfig(PLUGIN_ID);

  const c = (key, def) => (cfg[key] && cfg[key].trim()) ? cfg[key].trim() : def;
  const b = (key, def) => cfg[key] !== undefined ? cfg[key] === '1' : def;

  // App IDs
  SP.PRODUCT_APP_ID = parseInt(c('productAppId', ''), 10);
  SP.INV_APP_ID = parseInt(c('invAppId', ''), 10);

  /* 商品主檔欄位 */
  SP.PROD_BARCODE = c('prodBarcode', '條碼編號');
  SP.PROD_NAME_FIELD = c('prodNameField', '中文名稱');
  SP.PROD_CODE_FIELD = c('prodCodeField', '商品料號');
  SP.PROD_SUPP_TABLE = c('prodSuppTable', '供應商選單');
  SP.SUPP_NAME = c('suppName', '廠商名稱');
  SP.SUPP_PRICE = c('suppPrice', '廠商定價');

  SP.PROD_PRICE_RETAIL = '零售價';
  SP.PROD_PRICE_WHOLE = '批發價';
  SP.PROD_PRICE_NET = '網路價';

  /* 主表單欄位（進貨／出貨） */
  SP.F_PO_NUM = c('fPoNum', '採購單號');
  SP.F_SUPPLIER_NAME = c('fSupplierName', '廠商名稱');
  SP.F_CUSTOMER_NAME = c('fCustomerName', '客戶名稱');
  SP.F_CUSTOMER_TYPE = c('fCustomerType', '客戶類型');
  SP.F_STATUS = c('fStatus', '是否結案');
  SP.SCAN_SPACE_ID = c('scanSpaceId', 'scan_space');

  /* 子表格欄位（進貨／出貨／調撥共用同一組 key，實際欄位代碼依模式在
     config 頁面各自填寫，因此三種模式即使欄位代碼不同也能共用同一套
     scanPanel 與 addToSubtable 邏輯） */
  SP.F_SUBTABLE = c('fSubtable', '採購內容');
  SP.F_PROD_NAME = c('fProdName', '商品名稱');
  SP.F_PROD_CODE = c('fProdCode', '商品料號');
  SP.F_BARCODE = c('fBarcode', '條碼編號');
  SP.F_PRICE = c('fPrice', '單價');
  SP.F_LIST_PRICE = c('fListPrice', '廠商定價');
  SP.F_PO_QTY = c('fPoQty', '數量');
  SP.F_IN_QTY = c('fInQty', '已入庫數量');
  SP.F_WH = c('fWh', '收貨倉庫');

  // 倉庫 Lookup 連動目標欄位（真正會觸發 change 事件的欄位代碼，進貨／出貨用）
  SP.F_WH_TRIGGER = c('fWhTrigger', SP.F_WH);

  /* ── 調撥模式專屬欄位（僅 appMode === 'transfer' 時有意義） ──
     撥出／撥入倉庫是兩個獨立欄位，跟進貨/出貨「單一倉庫」的假設不同，
     因此另外開一組 key，不與 F_WH 混用。 */
  SP.F_FROM_WH = c('fFromWh', '撥出倉庫');
  SP.F_TO_WH = c('fToWh', '撥入倉庫');
  SP.F_FROM_WH_TRIGGER = c('fFromWhTrigger', SP.F_FROM_WH);
  SP.F_TO_WH_TRIGGER = c('fToWhTrigger', SP.F_TO_WH);
  SP.F_TRANSFER_STATUS = c('fTransferStatus', '調撥狀態');
  SP.F_TRANSFER_TYPE = c('fTransferType', '調撥性質');
  SP.F_RETURN_STATUS = c('fReturnStatus', '歸還狀態');
  SP.F_REF_NO = c('fRefNo', '對應借調單號');
  SP.F_TRANSFER_DATE = c('fTransferDate', '調撥日期');
  SP.F_UNIT = c('fUnit', '單位');

  /* ── App 模式：'in' | 'out' | 'transfer' ──
     新版設定值為 appMode 字串；若外掛設定還是舊版（只有 isShipment
     布林勾選框），則自動換算成 'out' / 'in'，避免既有設定失效。 */
  const rawMode = c('appMode', '');
  SP.OPT_APP_MODE = (rawMode === 'in' || rawMode === 'out' || rawMode === 'transfer')
    ? rawMode
    : (b('isShipment', false) ? 'out' : 'in');
  SP.OPT_IS_SHIPMENT = SP.OPT_APP_MODE === 'out';   // 保留給既有進貨/出貨程式碼相容
  SP.OPT_IS_TRANSFER = SP.OPT_APP_MODE === 'transfer';

  SP.OPT_SUPPLIER_GUARD = b('enableSupplierGuard', true);
  SP.OPT_INVENTORY_SYNC = b('enableInventorySync', true);
  SP.OPT_IS_SHIPMENT = SP.OPT_IS_SHIPMENT; // no-op，保留賦值位置方便閱讀對照舊版
  SP.OPT_AUTO_FILL_SUPPLIER = b('enableAutoFillSupplier', true);

  if (!SP.PRODUCT_APP_ID) {
    console.error('[條碼掃描外掛] 尚未設定商品主檔 App ID。');
    SP.DISABLED = true;
    return;
  }

  // 跨模組共用的可變狀態
  SP.state = {
    originalSalesData: {},
    currentCustomerType: '',
  };

  SP.isMobile = (kintone.app.getId() === null);
  SP.kApp = SP.isMobile ? kintone.mobile.app : kintone.app;

  SP.getRec = () => SP.kApp.record.get();
  SP.setRec = (r) => SP.kApp.record.set(r);
  SP.getAppId = () => SP.kApp.getId();
  SP.getRecId = () => SP.kApp.record.getId();
  SP.esc = (str) => (str || '').replace(/"/g, '');

  // ══════════════════════════════════════════════
  //  Toast 工具
  // ══════════════════════════════════════════════
  const TOAST_STYLES = {
    success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d', icon: '✓' },
    error: { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626', icon: '✕' },
    warn: { bg: '#fffbeb', border: '#fde68a', text: '#d97706', icon: '⚠' },
    info: { bg: '#eff6ff', border: '#93c5fd', text: '#2563eb', icon: 'ℹ' }
  };
  let _toastEl = null;

  SP.showToast = function (message, type = 'info', duration = 3000) {
    if (_toastEl) { _toastEl.remove(); _toastEl = null; }
    const s = TOAST_STYLES[type] || TOAST_STYLES.info;
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%) translateY(-16px)',
      display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '13px 18px', background: s.bg,
      border: `1.5px solid ${s.border}`, borderRadius: '10px', color: s.text, fontWeight: '600', fontSize: '14px',
      fontFamily: "'Segoe UI','Noto Sans TC',system-ui,sans-serif", boxShadow: '0 6px 24px rgba(0,0,0,.13)',
      zIndex: '99999', opacity: '0', transition: 'all .25s ease',
      whiteSpace: 'normal', wordBreak: 'break-word', pointerEvents: 'none',
      maxWidth: 'min(520px, calc(100vw - 24px))', boxSizing: 'border-box'
    });
    const icon = document.createElement('span'); icon.textContent = s.icon; icon.style.fontSize = '16px'; icon.style.flexShrink = '0';
    const text = document.createElement('span'); text.textContent = message; text.style.lineHeight = '1.5';
    toast.append(icon, text); document.body.appendChild(toast); _toastEl = toast;
    requestAnimationFrame(() => Object.assign(toast.style, { opacity: '1', transform: 'translateX(-50%) translateY(0)' }));
    if (duration > 0) {
      setTimeout(() => {
        Object.assign(toast.style, { opacity: '0', transform: 'translateX(-50%) translateY(-10px)' });
        setTimeout(() => { toast.remove(); if (_toastEl === toast) _toastEl = null; }, 280);
      }, duration);
    }
    return toast;
  };

  // ══════════════════════════════════════════════
  //  API 查詢
  // ══════════════════════════════════════════════
  SP.fetchProductByBarcode = function (barcode) {
    return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
      app: SP.PRODUCT_APP_ID, query: `${SP.PROD_BARCODE} in ("${SP.esc(barcode)}") limit 1`
    }).then(resp => resp.records.length ? resp.records[0] : null);
  };

  SP.fetchProductMapSync = function (codes) {
    if (!codes || !codes.length) return {};
    const query = `${SP.PROD_CODE_FIELD} in ("${codes.map(SP.esc).join('","')}")`;
    const xhr = new XMLHttpRequest();
    xhr.open('GET', kintone.api.url('/k/v1/records', true) + '?app=' + SP.PRODUCT_APP_ID + '&query=' + encodeURIComponent(query), false);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.send(null);
    if (xhr.status !== 200) return {};
    const resp = JSON.parse(xhr.responseText);
    const map = {};
    resp.records.forEach(r => { map[r[SP.PROD_CODE_FIELD].value] = r; });
    return map;
  };

  // ══════════════════════════════════════════════
  //  庫存查詢（同步 XHR）
  //  - 傳入單一倉庫字串（進貨/出貨用法，維持原本回傳格式）：
  //      回傳 null=未設定庫存App、-1=查無該倉庫商品紀錄、數字=現有庫存量
  //  - 傳入倉庫字串陣列（調撥雙倉庫用法）：
  //      回傳 { 倉庫名稱: 數量或 -1 }（-1 代表該倉庫查無此商品建檔）
  // ══════════════════════════════════════════════
  SP.fetchStockSync = function (whNames, itemCode) {
    const isMulti = Array.isArray(whNames);
    if (!itemCode || !SP.INV_APP_ID) return isMulti ? {} : null;

    const whList = (isMulti ? whNames : [whNames]).filter(Boolean);
    if (!whList.length) return isMulti ? {} : null;

    const whQ = whList.map(w => `倉庫名稱 = "${SP.esc(w)}"`).join(' or ');
    const query = `商品料號 = "${SP.esc(itemCode)}" and (${whQ})`;

    const xhr = new XMLHttpRequest();
    xhr.open('GET', kintone.api.url('/k/v1/records', true) + '?app=' + SP.INV_APP_ID + '&query=' + encodeURIComponent(query), false);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.send(null);
    if (xhr.status !== 200) return isMulti ? {} : null;

    const resp = JSON.parse(xhr.responseText);
    const foundMap = {};
    resp.records.forEach(rec => {
      const wh = rec['倉庫名稱'] ? rec['倉庫名稱'].value : '';
      const stockStr = (rec['在庫量'] && rec['在庫量'].value) ||
        (rec['庫存數量'] && rec['庫存數量'].value) ||
        (rec['目前庫存'] && rec['目前庫存'].value) ||
        (rec['進貨量'] && rec['進貨量'].value) || '0';
      foundMap[wh] = parseFloat(stockStr) || 0;
    });

    if (isMulti) {
      const result = {};
      whList.forEach(w => {
        result[w] = Object.prototype.hasOwnProperty.call(foundMap, w) ? foundMap[w] : -1;
      });
      return result;
    }
    return Object.prototype.hasOwnProperty.call(foundMap, whList[0]) ? foundMap[whList[0]] : -1;
  };

  // 找出子表格行內實際使用的數量欄位代碼（容錯：設定欄位找不到時退回「數量」）
  SP.resolveQtyField = function (row) {
    let qtyField = SP.F_PO_QTY;
    if (!row.value[qtyField] && row.value['數量']) qtyField = '數量';
    return qtyField;
  };

  // 依客戶類型重新計算單行價格（出貨模式專用，core 提供因為 scanPanel 也會用到）
  SP.updateRowPrice = function (row, custType) {
    const pCode = row.value[SP.F_PROD_CODE]?.value;
    if (!pCode || !custType) {
      if (row.value[SP.F_LIST_PRICE]) row.value[SP.F_LIST_PRICE].value = '';
      if (row.value[SP.F_PRICE]) row.value[SP.F_PRICE].value = '';
      return;
    }
    const product = SP.fetchProductMapSync([pCode])[pCode];
    if (!product) return;
    let finalPrice = '';
    switch (custType) {
      case '批發客戶': finalPrice = product[SP.PROD_PRICE_WHOLE] ? product[SP.PROD_PRICE_WHOLE].value : ''; break;
      case '網路客戶': finalPrice = product[SP.PROD_PRICE_NET] ? product[SP.PROD_PRICE_NET].value : ''; break;
      case '零售客戶': finalPrice = product[SP.PROD_PRICE_RETAIL] ? product[SP.PROD_PRICE_RETAIL].value : ''; break;
      default: finalPrice = ''; break;
    }
    if (finalPrice !== '' && !isNaN(finalPrice)) {
      if (row.value[SP.F_LIST_PRICE]) row.value[SP.F_LIST_PRICE].value = Number(finalPrice);
      if (row.value[SP.F_PRICE]) row.value[SP.F_PRICE].value = Number(finalPrice);
    } else {
      if (row.value[SP.F_LIST_PRICE]) row.value[SP.F_LIST_PRICE].value = '';
      if (row.value[SP.F_PRICE]) row.value[SP.F_PRICE].value = '';
    }
  };

  // ══════════════════════════════════════════════
  //  SCAN PANEL（進貨/出貨/調撥共用 UI）
  // ══════════════════════════════════════════════
  const scanPanel = {
    el: null, _videoControls: null, _product: null, _matchedSupp: null, _matchedPrice: null, _scannedBarcode: null,

    create() {
      if (document.getElementById('sp-panel')) return;
      const el = document.createElement('div');
      el.id = 'sp-panel';
      el.innerHTML = [
        '<div id="sp-overlay"></div>',
        '<div id="sp-box">',
        '<div id="sp-header"><span id="sp-title">掃描條碼</span><button id="sp-close" aria-label="關閉">✕</button></div>',
        '<div id="sp-cam-wrap">',
        '<video id="sp-video" autoplay playsinline muted></video>',
        '<div id="sp-viewfinder">',
        '<div class="sp-corner sp-tl"></div><div class="sp-corner sp-tr"></div>',
        '<div class="sp-corner sp-bl"></div><div class="sp-corner sp-br"></div>',
        '<div id="sp-scan-line"></div>',
        '</div>',
        '<div id="sp-cam-msg">點擊「開始掃描」啟動鏡頭</div>',
        '</div>',
        '<button id="sp-start-btn">📷 開始掃描</button>',
        '<div class="sp-or">── 或 ──</div>',
        '<label id="sp-upload-label"><input type="file" id="sp-file-input" accept="image/*" style="display:none">🖼 上傳條碼圖片</label>',
        '<div class="sp-or">── 或 ──</div>',
        '<div id="sp-manual-row">',
        '<input type="text" id="sp-manual-input" placeholder="直接輸入條碼號碼…">',
        '<button id="sp-manual-btn">查詢</button>',
        '</div>',
        '<div id="sp-result" style="display:none">',
        '<div id="sp-result-inner"></div>',
        '<div id="sp-result-actions">',
        '<button id="sp-add-btn">＋ 加入明細</button>',
        '<button id="sp-retry-btn">↺ 重新掃描</button>',
        '</div>',
        '</div>',
        '<div id="sp-error" style="display:none"></div>',
        '</div>',
      ].join('');
      document.body.appendChild(el);
      this.el = el;
      this._injectStyles();
      this._bindEvents();
    },

    _injectStyles() {
      if (document.getElementById('sp-css')) return;
      const s = document.createElement('style');
      s.id = 'sp-css';
      s.textContent = [
        '#sp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998}',
        '#sp-box{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:360px;max-width:95vw;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);z-index:9999;padding:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif}',
        '#sp-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}',
        '#sp-title{font-size:15px;font-weight:600;color:#111}',
        '#sp-close{background:none;border:none;font-size:18px;cursor:pointer;color:#6b7280;padding:2px 6px}',
        '#sp-cam-wrap{position:relative;background:#111;border-radius:8px;overflow:hidden;margin-bottom:10px;min-height:160px;display:flex;align-items:center;justify-content:center}',
        '#sp-video{width:100%;max-height:220px;object-fit:cover;display:none}',
        '#sp-viewfinder{position:absolute;inset:0;pointer-events:none;display:none}',
        '.sp-corner{position:absolute;width:20px;height:20px;border-color:#63c9ff;border-style:solid}',
        '.sp-tl{top:12px;left:12px;border-width:2px 0 0 2px}.sp-tr{top:12px;right:12px;border-width:2px 2px 0 0}',
        '.sp-bl{bottom:12px;left:12px;border-width:0 0 2px 2px}.sp-br{bottom:12px;right:12px;border-width:0 2px 2px 0}',
        '#sp-scan-line{position:absolute;left:12px;right:12px;height:2px;background:rgba(99,201,255,.85);box-shadow:0 0 8px rgba(99,201,255,.6);animation:sp-scan 1.8s ease-in-out infinite}',
        '@keyframes sp-scan{0%,100%{top:20%}50%{top:75%}}',
        '#sp-cam-msg{color:rgba(255,255,255,.55);font-size:13px}',
        '#sp-start-btn,#sp-upload-label{display:block;width:100%;padding:9px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;text-align:center;box-sizing:border-box;margin-bottom:8px}',
        '#sp-start-btn{background:#185FA5;color:#fff;border:none}#sp-start-btn:hover{background:#0C447C}',
        '#sp-upload-label{border:1px solid #d1d5db;color:#374151;background:#f9fafb}#sp-upload-label:hover{background:#f3f4f6}',
        '.sp-or{text-align:center;font-size:11px;color:#9ca3af;margin:6px 0}',
        '#sp-manual-row{display:flex;gap:6px;margin-top:4px}',
        '#sp-manual-input{flex:1;height:34px;border:1px solid #d1d5db;border-radius:8px;padding:0 10px;font-size:13px;outline:none}',
        '#sp-manual-input:focus{border-color:#185FA5;box-shadow:0 0 0 2px rgba(24,95,165,.15)}',
        '#sp-manual-btn{padding:0 14px;height:34px;background:#185FA5;color:#fff;border:none;border-radius:8px;font-size:13px;cursor:pointer;white-space:nowrap}',
        '#sp-manual-btn:hover{background:#0C447C}',
        '#sp-result{margin-top:14px;border-top:1px solid #f3f4f6;padding-top:12px}',
        '#sp-result-inner{background:#f9fafb;border-radius:8px;padding:10px 14px;margin-bottom:10px;font-size:13px}',
        '.sp-rrow{display:flex;justify-content:space-between;padding:4px 0;border-bottom:.5px solid #e5e7eb}',
        '.sp-rrow:last-child{border-bottom:none}',
        '.sp-rl{color:#6b7280}.sp-rv{font-weight:500;color:#111;text-align:right;max-width:200px;word-break:break-all}',
        '#sp-result-actions{display:flex;gap:8px}',
        '#sp-add-btn{flex:1;padding:8px;background:#185FA5;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer}',
        '#sp-add-btn:hover{background:#0C447C}',
        '#sp-retry-btn{padding:8px 14px;border:1px solid #d1d5db;background:#fff;border-radius:8px;font-size:13px;cursor:pointer;color:#374151}',
        '#sp-error{margin-top:10px;padding:8px 12px;background:#FCEBEB;border:1px solid #E24B4A;border-radius:6px;font-size:13px;color:#791F1F;white-space:pre-line}',
      ].join('');
      document.head.appendChild(s);
    },

    _bindEvents() {
      document.getElementById('sp-close').onclick = () => this.close();
      document.getElementById('sp-overlay').onclick = () => this.close();
      document.getElementById('sp-start-btn').onclick = () => {
        this._videoControls ? this.stopCamera() : this.startCamera();
      };
      document.getElementById('sp-retry-btn').onclick = () => this.reset();
      document.getElementById('sp-manual-btn').onclick = () => {
        const val = document.getElementById('sp-manual-input').value.trim();
        if (val) this.lookup(val);
      };
      document.getElementById('sp-manual-input').onkeydown = (e) => {
        if (e.key === 'Enter') { const val = e.target.value.trim(); if (val) this.lookup(val); }
      };
      document.getElementById('sp-file-input').onchange = (e) => {
        const file = e.target.files[0]; if (file) this.scanFromImage(file); e.target.value = '';
      };
      document.getElementById('sp-add-btn').onclick = () => this.addToSubtable();
    },

    open() { this.create(); this.reset(); document.getElementById('sp-panel').style.display = 'block'; },
    close() { this.stopCamera(); const p = document.getElementById('sp-panel'); if (p) p.style.display = 'none'; },

    reset() {
      this.stopCamera();
      this._product = null; this._matchedSupp = null; this._matchedPrice = null; this._scannedBarcode = null;
      document.getElementById('sp-result').style.display = 'none';
      document.getElementById('sp-error').style.display = 'none';
      document.getElementById('sp-manual-input').value = '';
      document.getElementById('sp-video').style.display = 'none';
      document.getElementById('sp-viewfinder').style.display = 'none';
      document.getElementById('sp-cam-msg').style.display = 'flex';
      document.getElementById('sp-start-btn').textContent = '📷 開始掃描';
    },

    _checkZXing() {
      if (typeof window.ZXingBrowser === 'undefined') {
        this.showError('ZXing 套件載入失敗，請確認 manifest.json 設定。');
        return false;
      }
      return true;
    },

    async startCamera() {
      this.showError('');
      if (!this._checkZXing()) return;
      try {
        const videoElement = document.getElementById('sp-video');
        const codeReader = new window.ZXingBrowser.BrowserMultiFormatReader();
        const devices = await window.ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
        if (!devices.length) throw new Error('找不到可用的攝影機設備');

        let selectedDeviceId = devices[0].deviceId;
        const backCamera = devices.find(d =>
          d.label.toLowerCase().includes('back') ||
          d.label.toLowerCase().includes('後') ||
          d.label.toLowerCase().includes('environment')
        );
        if (backCamera) selectedDeviceId = backCamera.deviceId;

        videoElement.style.display = 'block';
        document.getElementById('sp-viewfinder').style.display = 'block';
        document.getElementById('sp-cam-msg').style.display = 'none';
        document.getElementById('sp-start-btn').textContent = '⏹ 停止掃描';

        this._videoControls = await codeReader.decodeFromVideoDevice(
          selectedDeviceId, videoElement,
          (result) => { if (result) { this.stopCamera(); this.lookup(result.getText()); } }
        );
      } catch (err) {
        this.stopCamera();
        this.showError('鏡頭啟動失敗：' + err.message);
      }
    },

    stopCamera() {
      if (this._videoControls) { this._videoControls.stop(); this._videoControls = null; }
      const btn = document.getElementById('sp-start-btn');
      if (btn) btn.textContent = '📷 開始掃描';
      const vid = document.getElementById('sp-video');
      if (vid) { vid.style.display = 'none'; vid.srcObject = null; }
      const vf = document.getElementById('sp-viewfinder'); if (vf) vf.style.display = 'none';
      const msg = document.getElementById('sp-cam-msg'); if (msg) msg.style.display = 'flex';
    },

    async scanFromImage(file) {
      this.showError('');
      if (!this._checkZXing()) return;
      const imgUrl = URL.createObjectURL(file);
      const img = document.createElement('img');
      img.src = imgUrl;
      img.onload = async () => {
        try {
          const result = await new window.ZXingBrowser.BrowserMultiFormatReader().decodeFromImageElement(img);
          this.lookup(result.getText());
        } catch {
          this.showError('無法辨識條碼，請確認圖片清晰度、條碼格式，或改用手動輸入。');
        } finally {
          URL.revokeObjectURL(imgUrl);
        }
      };
      img.onerror = () => { this.showError('圖片載入失敗，請確認檔案格式。'); URL.revokeObjectURL(imgUrl); };
    },

    // ── 依 appMode 決定要不要做廠商比對／客戶售價比對，調撥模式兩者都跳過 ──
    lookup(barcode) {
      this.showError('');
      document.getElementById('sp-result').style.display = 'none';

      SP.fetchProductByBarcode(barcode).then(product => {
        if (!product) {
          this.showError(`找不到條碼「${barcode}」對應的商品，請手動選擇。`);
          return;
        }

        const recNow = SP.getRec();
        const record = recNow.record;
        let matchedSupp = '', matchedPrice = '', errorMsg = '';

        if (SP.OPT_APP_MODE === 'transfer') {
          // 調撥模式：不需要廠商比對，也不需要客戶售價比對，
          // 只需要商品名稱／料號，直接往下走。
        } else if (!SP.OPT_IS_SHIPMENT) {
          const formSupp = record[SP.F_SUPPLIER_NAME]?.value || '';
          const suppList = product[SP.PROD_SUPP_TABLE] ? product[SP.PROD_SUPP_TABLE].value : [];
          for (const item of suppList) {
            if (item.value[SP.PROD_BARCODE] && item.value[SP.PROD_BARCODE].value === barcode) {
              matchedSupp = item.value[SP.SUPP_NAME] ? item.value[SP.SUPP_NAME].value : '';
              matchedPrice = item.value[SP.SUPP_PRICE] ? item.value[SP.SUPP_PRICE].value : '';
              break;
            }
          }
          if (!matchedSupp && formSupp) matchedSupp = formSupp;
          if (SP.OPT_SUPPLIER_GUARD && formSupp && matchedSupp && formSupp !== matchedSupp) {
            errorMsg = `⛔\n目前的廠商為「${formSupp}」，但此條碼屬於「${matchedSupp}」。`;
          }
        } else {
          const custType = record[SP.F_CUSTOMER_TYPE]?.value || '';
          if (!custType) {
            errorMsg = '請先選擇客戶（客戶類型尚未設定），才能判斷對應售價。';
          } else {
            switch (custType) {
              case '批發客戶': matchedPrice = product[SP.PROD_PRICE_WHOLE] ? product[SP.PROD_PRICE_WHOLE].value : ''; break;
              case '網路客戶': matchedPrice = product[SP.PROD_PRICE_NET] ? product[SP.PROD_PRICE_NET].value : ''; break;
              case '零售客戶': matchedPrice = product[SP.PROD_PRICE_RETAIL] ? product[SP.PROD_PRICE_RETAIL].value : ''; break;
              default:
                errorMsg = `客戶類型「${custType}」無對應價格設定，請確認客戶資料。`;
            }
          }
        }

        if (errorMsg) { this.showError(errorMsg); return; }

        this._product = product;
        this._matchedSupp = matchedSupp;
        this._matchedPrice = matchedPrice;
        this._scannedBarcode = barcode;

        const name = product[SP.PROD_NAME_FIELD]?.value || '—';
        const code = product[SP.PROD_CODE_FIELD]?.value || '—';

        const rows = [
          `<div class="sp-rrow"><span class="sp-rl">條碼</span><span class="sp-rv" style="font-family:monospace;font-size:12px">${barcode}</span></div>`,
          `<div class="sp-rrow"><span class="sp-rl">商品名稱</span><span class="sp-rv">${name}</span></div>`,
          `<div class="sp-rrow"><span class="sp-rl">商品料號</span><span class="sp-rv" style="font-family:monospace;font-size:12px">${code}</span></div>`,
        ];

        // 調撥模式不顯示廠商／價格列，只需要名稱＋料號
        if (SP.OPT_APP_MODE !== 'transfer') {
          if (matchedSupp) {
            rows.push(`<div class="sp-rrow"><span class="sp-rl">對應廠商</span><span class="sp-rv" style="color:#27500A;font-weight:bold">${matchedSupp}</span></div>`);
          }
          const priceText = matchedPrice ? `${Number(matchedPrice).toLocaleString()} 元` : '無定價';
          rows.push(`<div class="sp-rrow"><span class="sp-rl">${SP.OPT_IS_SHIPMENT ? '售價' : '廠商定價'}</span><span class="sp-rv">${priceText}</span></div>`);
        }

        document.getElementById('sp-result-inner').innerHTML = rows.join('');
        document.getElementById('sp-result').style.display = 'block';

      }).catch(e => {
        console.error('[條碼掃描外掛] lookup 失敗', e);
        this.showError('查詢失敗，請確認網路或 App 權限設定。');
      });
    },

    addToSubtable() {
      const product = this._product; if (!product) return;
      const rec = SP.getRec(); if (!rec) return;
      const record = rec.record;
      const rows = record[SP.F_SUBTABLE].value;
      let existRow = null;
      for (const row of rows) {
        if (row.value[SP.F_PROD_CODE]?.value === product[SP.PROD_CODE_FIELD].value) { existRow = row; break; }
      }

      const qtyField = rows.length ? SP.resolveQtyField(rows[0]) : SP.F_PO_QTY;

      if (existRow) {
        existRow.value[qtyField].value = String((parseFloat(existRow.value[qtyField].value) || 0) + 1);
        if (existRow.value[SP.F_BARCODE]) existRow.value[SP.F_BARCODE].value = this._scannedBarcode;
      } else {
        const nv = {};
        const tpl = rows.length > 0 ? rows[0].value : null;
        if (tpl) {
          // 有既有列可當範本：直接照抄欄位結構，三種模式都適用，
          // 因為實際欄位有哪些完全由子表格本身決定，不需要另外分流。
          Object.keys(tpl).forEach(k => { nv[k] = { type: tpl[k].type, value: '' }; });
        } else if (SP.OPT_APP_MODE === 'transfer') {
          // 調撥子表格空白時的預設欄位：料號/名稱/條碼/數量/單位，不含價格與廠商。
          nv[SP.F_PROD_NAME] = { type: 'SINGLE_LINE_TEXT', value: '' };
          nv[SP.F_PROD_CODE] = { type: 'SINGLE_LINE_TEXT', value: '' };
          nv[SP.F_BARCODE] = { type: 'SINGLE_LINE_TEXT', value: '' };
          nv[SP.F_PO_QTY] = { type: 'NUMBER', value: '' };
          if (SP.F_UNIT) nv[SP.F_UNIT] = { type: 'SINGLE_LINE_TEXT', value: '' };
        } else {
          nv[SP.F_PROD_NAME] = { type: 'SINGLE_LINE_TEXT', value: '' };
          nv[SP.F_PROD_CODE] = { type: 'SINGLE_LINE_TEXT', value: '' };
          nv[SP.F_BARCODE] = { type: 'SINGLE_LINE_TEXT', value: '' };
          nv[SP.F_LIST_PRICE] = { type: 'NUMBER', value: '' };
          nv[SP.F_PRICE] = { type: 'NUMBER', value: '' };
          nv[qtyField] = { type: 'NUMBER', value: '' };
          nv[SP.F_IN_QTY] = { type: 'NUMBER', value: '' };
          nv[SP.F_WH] = { type: 'SINGLE_LINE_TEXT', value: '' };
        }
        nv[SP.F_PROD_NAME].value = product[SP.PROD_NAME_FIELD]?.value || '';
        nv[SP.F_PROD_CODE].value = product[SP.PROD_CODE_FIELD]?.value || '';
        if (nv[SP.F_BARCODE]) nv[SP.F_BARCODE].value = this._scannedBarcode || '';

        if (nv[SP.F_LIST_PRICE]) nv[SP.F_LIST_PRICE].value = this._matchedPrice ? String(this._matchedPrice) : '';
        if (nv[SP.F_PRICE]) nv[SP.F_PRICE].value = this._matchedPrice ? String(this._matchedPrice) : '';
        if (nv[qtyField]) nv[qtyField].value = '1';

        const fr = rows[0];
        const isEmpty = rows.length === 1
          && !fr.value[SP.F_PROD_CODE].value
          && !fr.value[SP.F_PROD_NAME].value
          && (!fr.value[qtyField].value || fr.value[qtyField].value === '0');
        if (isEmpty) { rows[0].value = nv; } else { rows.push({ value: nv }); }
      }

      SP.setRec(rec);

      // 進貨模式：掃描後自動帶入廠商名稱（若表頭欄位為空）
      if (SP.OPT_APP_MODE === 'in' && SP.OPT_AUTO_FILL_SUPPLIER && this._matchedSupp) {
        setTimeout(() => {
          const rec2 = SP.getRec();
          if (rec2 && !rec2.record[SP.F_SUPPLIER_NAME].value) {
            rec2.record[SP.F_SUPPLIER_NAME].value = this._matchedSupp;
            rec2.record[SP.F_SUPPLIER_NAME].lookup = true;
            SP.setRec(rec2);
          }
        }, 150);
      }

      // 調撥模式：加入明細後是程式化 setRec，不會觸發 change 事件，
      // 因此手動呼叫一次即時驗證，讓雙倉庫庫存紅字馬上刷新。
      if (SP.OPT_APP_MODE === 'transfer' && SP.Transfer && typeof SP.Transfer.afterAddToSubtable === 'function') {
        SP.Transfer.afterAddToSubtable();
      }

      this._playSuccess();
      this.close();
    },

    _playSuccess() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = 'sine'; osc.frequency.value = 1200; osc.connect(ctx.destination);
        osc.start(); setTimeout(() => { osc.stop(); ctx.close(); }, 120);
      } catch { /* 靜默失敗 */ }
    },

    showError(msg) {
      const el = document.getElementById('sp-error'); if (!el) return;
      if (!msg) { el.style.display = 'none'; return; }
      el.textContent = msg; el.style.display = 'block';
    }
  };

  SP.scanPanel = scanPanel;

})();
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════
     desktop-transfer.js — 調撥單專屬邏輯
     只在 SP.OPT_APP_MODE === 'transfer' 時會被呼叫／註冊事件。

     跟 desktop-inbound.js / desktop-outbound.js 不同的地方：
     這支檔案除了提供給 desktop-events.js 呼叫的
     SP.Transfer.handleSubtableChange / validateSubmit / handleDelete
     之外，也「自行註冊」一部分 kintone.events.on(...)。

     原因：借還子系統（借調單下拉選單、借還紀錄面板、雙倉庫欄位鎖定）
     監聽的欄位/事件跟進貨出貨完全不同形狀（雙倉庫觸發欄位、
     調撥性質變更、唯讀檢視畫面...），硬塞進 desktop-events.js
     既有的共用分派結構只會讓那支檔案變得難懂，所以維持原本
     transfer.js 自成一套事件註冊的寫法，只是把欄位代碼／App ID
     改成讀 SP 命名空間裡的設定值。

     kintone 允許同一個事件被多支檔案分別註冊、依 manifest.json
     載入順序依序執行，所以這裡自行註冊不會跟 desktop-events.js
     的共用註冊互相覆蓋，兩邊各自處理各自負責的部分。

     🔧 [2026-07 修正] 手機版事件名稱前綴跟桌面版不同
     （mobile.app.record... vs app.record...），這支檔案原本自行
     註冊事件時，全部只寫了桌面版事件名，漏了對應的 mobile 版本，
     導致調撥模組（歸還狀態鎖定、借調單下拉選單、借還紀錄面板、
     即時庫存驗證）在手機版完全沒有生效。
     已透過下方 bothEvents() helper 統一補上 mobile 前綴版本，
     並將 event.type 的嚴格比對（===）改為 .includes()，
     避免手機版事件字串（帶 mobile. 前綴）比對不到。
  ═══════════════════════════════════════════════ */

  const SP = window.SP;
  if (!SP || SP.DISABLED || SP.OPT_APP_MODE !== 'transfer') return;

  const Transfer = SP.Transfer = {};

  const STOCK_APP_ID = SP.INV_APP_ID;
  const SELF_APP_ID = SP.getAppId();

  // 主表單欄位（讀自 SP，設定頁面對應調撥單的欄位代碼）
  const F_NO = SP.F_PO_NUM;          // 調撥單號
  const F_STATUS = SP.F_TRANSFER_STATUS; // 調撥狀態
  const F_TYPE = SP.F_TRANSFER_TYPE;   // 調撥性質
  const F_RETURN = SP.F_RETURN_STATUS;   // 歸還狀態
  const F_REF_NO = SP.F_REF_NO;          // 對應借調單號
  const F_FROM_WH = SP.F_FROM_WH;         // 撥出倉庫
  const F_TO_WH = SP.F_TO_WH;           // 撥入倉庫
  const F_DATE = SP.F_TRANSFER_DATE;   // 調撥日期

  // Lookup 連動觸發欄位（真正會觸發 change 事件的唯讀欄位代碼）
  const F_FROM_WH_TRIGGER = SP.F_FROM_WH_TRIGGER;
  const F_TO_WH_TRIGGER = SP.F_TO_WH_TRIGGER;

  // 子表格欄位
  const F_SUBTABLE = SP.F_SUBTABLE; // 調撥內容
  const F_CODE = SP.F_PROD_CODE;
  const F_NAME = SP.F_PROD_NAME;
  const F_QTY = SP.F_PO_QTY;   // 調撥數量
  const F_UNIT = SP.F_UNIT;
  const F_REMARK = '備註'; // 純顯示用，暫不開放設定

  // ── 狀態值文字（欄位「值」的字面量，非欄位代碼，維持原邏輯不做成設定項） ──
  const ST_PROCESSING = '處理中';
  const ST_SHIPPING = '已發貨/運輸中';
  const ST_DONE = '調撥完成';
  const TYPE_LEND = '借調撥出';
  const TYPE_RETURN = '借調歸還';
  const RET_NA = '—';
  const RET_PENDING = '未歸還';
  const RET_DONE = '已歸還';

  // ── 手機版事件名前綴跟桌面版不同（mobile.app.record... vs app.record...），
  //    這支檔案自行註冊事件時容易漏加 mobile 版本，用這個 helper 統一產生兩種前綴。
  function bothEvents(names) {
    return names.concat(names.map(n => 'mobile.' + n));
  }

  // ── 工具函式 ──
  function getRows(record) {
    return record[F_SUBTABLE] ? record[F_SUBTABLE].value : [];
  }

  function getItemCodes(record) {
    const codes = [];
    getRows(record).forEach(row => {
      const c = row.value[F_CODE] ? row.value[F_CODE].value : '';
      if (c && codes.indexOf(c) === -1) codes.push(c);
    });
    return codes;
  }

  function applyReturnStatus(record) {
    if (!record[F_RETURN]) return;
    const type = record[F_TYPE] ? record[F_TYPE].value : '';
    const status = record[F_STATUS] ? record[F_STATUS].value : '';

    record[F_RETURN].disabled = true; // 永遠鎖死

    if (type === TYPE_LEND) {
      record[F_RETURN].value = (status === ST_DONE) ? RET_PENDING : RET_NA;
    } else {
      record[F_RETURN].value = RET_NA;
    }
  }
  Transfer.applyReturnStatus = applyReturnStatus;

  // ── 取得空白欄位 (自動相容桌面與手機版) ──
  function getSpaceEl(spaceId) {
    if (window.location.href.indexOf('/m/') > -1) {
      return kintone.mobile.app.record.getSpaceElement(spaceId);
    }
    return kintone.app.record.getSpaceElement(spaceId);
  }


  function updateOriginalLendRecord(refNo, targetStatus) {
    if (!refNo) return Promise.resolve();
    const q = F_NO + ' = "' + refNo + '" limit 1';
    return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: SELF_APP_ID, query: q }).then(res => {
      if (!res.records.length) return;
      const rec = res.records[0];
      if (rec[F_RETURN].value === targetStatus) return;
      return kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
        app: SELF_APP_ID, id: rec.$id.value, record: { [F_RETURN]: { value: targetStatus } }
      });
    });
  }

  // ── 智慧下拉選單 ──
  function renderReturnSelector(currentRefNo) {
    const old = document.getElementById('inv-return-selector');
    if (old) old.remove();

    let query = F_TYPE + ' in ("' + TYPE_LEND + '") and ' + F_RETURN + ' in ("' + RET_PENDING + '") and ' + F_STATUS + ' in ("' + ST_DONE + '")';
    if (currentRefNo) query = '(' + query + ') or (' + F_NO + ' = "' + currentRefNo + '")';
    query += ' order by ' + F_NO + ' desc limit 100';

    kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: SELF_APP_ID, query: query }).then(resp => {
      const pendingRecords = resp.records;
      const spaceEl = getSpaceEl('transfer_return_space');
      if (!spaceEl) return;

      // 加上 alignItems 與 marginTop，讓排版緊湊精緻
      spaceEl.style.display = 'flex';
      spaceEl.style.flexDirection = 'column';
      spaceEl.style.gap = '10px';
      spaceEl.style.alignItems = 'flex-start';
      spaceEl.style.marginTop = '4px';

      const wrap = document.createElement('div');
      wrap.id = 'inv-return-selector';
      wrap.style.cssText = ['display:flex', 'align-items:center', 'gap:8px', 'margin-top:6px'].join(';');

      const label = document.createElement('span');
      label.textContent = '選擇未歸還借調單';
      label.style.cssText = ['font-size:12px', 'color:#8f9092', 'white-space:nowrap', 'flex-shrink:0'].join(';');
      wrap.appendChild(label);

      const arrowSvg = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8f9092" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>'
      );

      const sel = document.createElement('select');
      sel.id = 'inv-return-sel';
      sel.style.cssText = [
        'flex:1', 'max-width:320px', 'height:32px', 'padding:0 28px 0 10px',
        'font-size:13px', 'color:#333', 'background-color:#fff',
        'background-repeat:no-repeat', 'background-position:right 8px center', 'background-size:12px',
        'border:1px solid #e3e7e8', 'border-radius:3px', 'cursor:pointer',
        'appearance:none', '-webkit-appearance:none', 'transition:border-color .15s ease'
      ].join(';');
      sel.style.backgroundImage = 'url("' + arrowSvg + '")';

      sel.addEventListener('focus', () => { sel.style.borderColor = '#3b82f6'; });
      sel.addEventListener('blur', () => { sel.style.borderColor = '#e3e7e8'; });

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '── 請選擇借調單 ──';
      sel.appendChild(placeholder);

      pendingRecords.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.$id.value;
        const fromWh = r[F_FROM_WH] ? r[F_FROM_WH].value : '';
        const toWh = r[F_TO_WH] ? r[F_TO_WH].value : '';
        const no = r[F_NO] ? r[F_NO].value : '';
        const date = r[F_DATE] ? r[F_DATE].value : '';
        opt.textContent = no + ' ' + fromWh + ' → ' + toWh + ' (' + date + ')';
        if (no === currentRefNo) opt.selected = true;
        sel.appendChild(opt);
      });

      sel.addEventListener('change', () => {
        const selectedId = sel.value;
        if (!selectedId) return;
        const lendRec = pendingRecords.find(r => r.$id.value === selectedId);
        if (!lendRec) return;

        const refNo = lendRec[F_NO].value;
        const recId = SP.getRecId();

        let qHist = F_REF_NO + ' = "' + refNo + '" and ' + F_STATUS + ' in ("' + ST_DONE + '")';
        if (recId) qHist += ' and $id != "' + recId + '"';

        kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: SELF_APP_ID, query: qHist }).then(resHist => {
          const historyMap = {};
          resHist.records.forEach(h => {
            (h[F_SUBTABLE] ? h[F_SUBTABLE].value : []).forEach(r => {
              const c = r.value[F_CODE] ? r.value[F_CODE].value : '';
              if (c) historyMap[c] = (historyMap[c] || 0) + (parseFloat(r.value[F_QTY].value) || 0);
            });
          });

          const recObj = SP.getRec();
          if (!recObj) return;
          const record = recObj.record;

          record[F_REF_NO].value = refNo;
          record[F_FROM_WH].value = lendRec[F_TO_WH] ? lendRec[F_TO_WH].value : '';
          record[F_TO_WH].value = lendRec[F_FROM_WH] ? lendRec[F_FROM_WH].value : '';

          const originalRows = lendRec[F_SUBTABLE] ? lendRec[F_SUBTABLE].value : [];
          const newRows = [];

          originalRows.forEach(row => {
            const code = row.value[F_CODE] ? row.value[F_CODE].value : '';
            const totalBorrowed = parseFloat(row.value[F_QTY] ? row.value[F_QTY].value : 0) || 0;
            const remaining = totalBorrowed - (historyMap[code] || 0);

            if (remaining > 0) {
              const rv = {};
              rv[F_NAME] = { type: 'SINGLE_LINE_TEXT', value: row.value[F_NAME] ? row.value[F_NAME].value : '' };
              rv[F_CODE] = { type: 'SINGLE_LINE_TEXT', value: code };
              rv[F_QTY] = { type: 'NUMBER', value: remaining };
              if (F_UNIT) rv[F_UNIT] = { type: 'SINGLE_LINE_TEXT', value: row.value[F_UNIT] ? row.value[F_UNIT].value : '' };
              rv[F_REMARK] = { type: 'MULTI_LINE_TEXT', value: '' };
              newRows.push({ value: rv });
            }
          });

          record[F_SUBTABLE].value = newRows;
          SP.setRec(recObj);
          triggerInlineValidation();
          renderHistoryPanel(refNo); // 選好借調單後，立即更新借還紀錄面板
        });
      });

      wrap.appendChild(sel);
      // refField.appendChild(wrap);
      spaceEl.appendChild(wrap);

    });
  }
  Transfer.renderReturnSelector = renderReturnSelector;

  // ── 借還紀錄面板 ──
  function renderHistoryPanel(refNo) {
    const old = document.getElementById('inv-history-panel');
    if (old) old.remove();
    if (!refNo) return;

    const query = '(' + F_NO + ' = "' + refNo + '") or (' + F_REF_NO + ' = "' + refNo + '") order by ' + F_NO + ' asc';

    kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: SELF_APP_ID, query: query }).then(resp => {
      const records = resp.records;
      const lendRec = records.find(r => r[F_NO].value === refNo);
      if (!lendRec) return;

      const returnRecs = records.filter(r => r[F_TYPE].value === TYPE_RETURN);

      const borrowedMap = {};
      (lendRec[F_SUBTABLE] ? lendRec[F_SUBTABLE].value : []).forEach(row => {
        const c = row.value[F_CODE] ? row.value[F_CODE].value : '';
        const q = parseFloat(row.value[F_QTY] ? row.value[F_QTY].value : 0) || 0;
        const n = row.value[F_NAME] ? row.value[F_NAME].value : '';
        if (!c) return;
        if (!borrowedMap[c]) borrowedMap[c] = { name: n, borrowed: 0, returned: 0 };
        borrowedMap[c].borrowed += q;
      });
      returnRecs.forEach(r => {
        if (r[F_STATUS].value !== ST_DONE) return;
        (r[F_SUBTABLE] ? r[F_SUBTABLE].value : []).forEach(row => {
          const c = row.value[F_CODE] ? row.value[F_CODE].value : '';
          const q = parseFloat(row.value[F_QTY] ? row.value[F_QTY].value : 0) || 0;
          if (!c || !borrowedMap[c]) return;
          borrowedMap[c].returned += q;
        });
      });

      const panel = document.createElement('div');
      panel.id = 'inv-history-panel';
      panel.style.cssText = [
        'margin:0', 'background:#fff', 'border:1px solid #e5e8ea', 'border-left:4px solid #3b82f6',
        'border-radius:10px', 'box-shadow:0 2px 8px rgba(0,0,0,.06)', 'font-size:13px', 'overflow:hidden',
        'width:100%', 'box-sizing:border-box'
      ].join(';');

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:16px 24px;background:linear-gradient(to right,#f8fafc,#f1f5f9);border-bottom:1px solid #eef1f2;';

      const icon = document.createElement('span');
      icon.textContent = '📋';
      icon.style.cssText = 'font-size:14px;flex-shrink:0;';
      header.appendChild(icon);

      const title = document.createElement('span');
      title.textContent = '借還紀錄';
      title.style.cssText = 'font-weight:700;color:#1f2937;font-size:14px;';
      header.appendChild(title);

      const subTitle = document.createElement('span');
      subTitle.textContent = '借調單 ' + refNo;
      subTitle.style.cssText = 'font-size:12px;color:#9ca3af;';
      header.appendChild(subTitle);

      const countBadge = document.createElement('span');
      countBadge.textContent = records.length + ' 筆單據';
      countBadge.style.cssText = 'margin-left:auto;font-size:11px;color:#6b7280;background:#eef1f2;padding:2px 8px;border-radius:10px;flex-shrink:0;';
      header.appendChild(countBadge);

      panel.appendChild(header);

      const tableWrap = document.createElement('div');
      tableWrap.style.cssText = 'padding:18px 24px 8px 24px;';

      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;';
      table.innerHTML = '<thead><tr>' +
        '<th style="text-align:left;padding:0 10px 10px 0;font-size:12px;font-weight:600;color:#9ca3af;letter-spacing:.3px;">品項</th>' +
        '<th style="text-align:right;padding:0 20px 10px;font-size:12px;font-weight:600;color:#9ca3af;letter-spacing:.3px;">借出</th>' +
        '<th style="text-align:right;padding:0 20px 10px;font-size:12px;font-weight:600;color:#9ca3af;letter-spacing:.3px;">已歸還</th>' +
        '<th style="text-align:right;padding:0 0 10px 20px;font-size:12px;font-weight:600;color:#9ca3af;letter-spacing:.3px;">剩餘</th>' +
        '</tr></thead>';
      const tbody = document.createElement('tbody');
      Object.keys(borrowedMap).forEach((c, idx) => {
        const d = borrowedMap[c];
        const remain = d.borrowed - d.returned;
        const pillColor = remain > 0 ? 'background:#fff7ed;color:#c2410c;' : 'background:#f0fdf4;color:#15803d;';
        const tr = document.createElement('tr');
        tr.style.cssText = idx % 2 === 1 ? 'background:#fafbfc;' : '';
        tr.innerHTML =
          '<td style="padding:11px 10px 11px 0;color:#374151;font-size:13px;">' + d.name + '<span style="color:#9ca3af;font-size:11px;"> ／ ' + c + '</span></td>' +
          '<td style="padding:11px 20px;text-align:right;color:#374151;font-size:13px;font-variant-numeric:tabular-nums;">' + d.borrowed + '</td>' +
          '<td style="padding:11px 20px;text-align:right;color:#374151;font-size:13px;font-variant-numeric:tabular-nums;">' + d.returned + '</td>' +
          '<td style="padding:11px 0 11px 20px;text-align:right;">' +
          '<span style="display:inline-block;min-width:32px;' + pillColor + 'font-weight:700;font-size:12px;padding:3px 10px;border-radius:12px;font-variant-numeric:tabular-nums;">' + remain + '</span>' +
          '</td>';
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      panel.appendChild(tableWrap);

      const listWrap = document.createElement('div');
      listWrap.style.cssText = 'padding:8px 24px 18px 24px;border-top:1px solid #f1f3f4;margin-top:6px;';
      const listLabel = document.createElement('div');
      listLabel.textContent = '單據明細';
      listLabel.style.cssText = 'font-size:11px;font-weight:600;color:#9ca3af;margin:8px 0 6px;';
      listWrap.appendChild(listLabel);

      const timeline = document.createElement('div');
      timeline.style.cssText = 'position:relative;padding-left:14px;';

      const railLine = document.createElement('div');
      railLine.style.cssText = 'position:absolute;left:3px;top:4px;bottom:4px;width:1px;background:#e5e8ea;';
      timeline.appendChild(railLine);

      records.forEach(r => {
        const isLend = r[F_TYPE].value === TYPE_LEND;
        const dotColor = r[F_STATUS].value === ST_DONE ? '#22c55e' : '#d1d5db';
        const tagBg = isLend ? '#eff6ff' : '#f5f3ff';
        const tagColor = isLend ? '#2563eb' : '#7c3aed';
        const tagText = isLend ? '借出' : '歸還';

        const item = document.createElement('div');
        item.style.cssText = 'position:relative;display:flex;align-items:center;gap:8px;padding:4px 0;';

        const dot = document.createElement('span');
        dot.style.cssText = 'position:absolute;left:-14px;width:7px;height:7px;border-radius:50%;background:' + dotColor + ';border:2px solid #fff;box-shadow:0 0 0 1px ' + dotColor + ';';
        item.appendChild(dot);

        const tag = document.createElement('span');
        tag.textContent = tagText;
        tag.style.cssText = 'font-size:11px;font-weight:700;color:' + tagColor + ';background:' + tagBg + ';padding:1px 7px;border-radius:4px;flex-shrink:0;';
        item.appendChild(tag);

        const info = document.createElement('span');
        info.style.cssText = 'color:#374151;';
        info.textContent = r[F_NO].value;
        item.appendChild(info);

        const date = document.createElement('span');
        date.style.cssText = 'color:#9ca3af;font-size:12px;';
        date.textContent = r[F_DATE] ? r[F_DATE].value : '';
        item.appendChild(date);

        const st = document.createElement('span');
        st.style.cssText = 'color:#6b7280;font-size:12px;margin-left:auto;';
        st.textContent = r[F_STATUS].value;
        item.appendChild(st);

        timeline.appendChild(item);
      });

      listWrap.appendChild(timeline);
      panel.appendChild(listWrap);

      const spaceEl = getSpaceEl('transfer_history_space');
      if (!spaceEl) return;

      spaceEl.style.display = 'block';
      spaceEl.style.width = '100%';
      spaceEl.style.marginTop = '12px';

      spaceEl.appendChild(panel);
    });
  }
  Transfer.renderHistoryPanel = renderHistoryPanel;

  // ══════════════════════════════════════════════
  //  防手震非同步驗證（清空即時消除、雙向倉庫檢查）
  // ══════════════════════════════════════════════
  let _validationTimer = null;

  function triggerInlineValidation() {
    if (_validationTimer) clearTimeout(_validationTimer);

    _validationTimer = setTimeout(() => {
      const recObj = SP.getRec();
      if (!recObj) return;
      const record = recObj.record;
      const fromWh = record[F_FROM_WH] ? record[F_FROM_WH].value : '';
      const toWh = record[F_TO_WH] ? record[F_TO_WH].value : '';
      const type = record[F_TYPE] ? record[F_TYPE].value : '';
      const refNo = record[F_REF_NO] ? record[F_REF_NO].value : '';
      const codes = getItemCodes(record);
      const recId = SP.getRecId();

      if (codes.length === 0) {
        SP.setRec(recObj);
        return;
      }

      // 1. 同時查詢「撥出倉庫」與「撥入倉庫」的實體庫存
      //    可用庫存公式必須跟 Transfer.validateSubmit（存檔時的真正驗證）
      //    完全一致：進貨量 - 出貨量 - 預約保留量，這裡固定走原生 API
      //    批次查詢，不透過 core 的 fetchStockSync（那支函式是給進貨/
      //    出貨單純比對「單一庫存欄位」用的，公式不同，混用會讓即時
      //    提示跟實際存檔驗證的數字對不起來）。
      let pStock = Promise.resolve({});
      const queryWhs = [];
      if (fromWh) queryWhs.push(fromWh);
      if (toWh) queryWhs.push(toWh);

      if (queryWhs.length > 0) {
        const codeQ = codes.map(c => '商品料號 = "' + c + '"').join(' or ');
        const whQ = queryWhs.map(w => '倉庫名稱 = "' + w + '"').join(' or ');
        const qStockStr = '(' + codeQ + ') and (' + whQ + ')';

        pStock = kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: STOCK_APP_ID, query: qStockStr })
          .then(res => {
            const map = {};
            res.records.forEach(r => {
              const key = r['倉庫名稱'].value + '_' + r['商品料號'].value;
              map[key] = Math.max(0, (parseFloat(r['進貨量'].value) || 0) - (parseFloat(r['出貨量'].value) || 0) - (parseFloat(r['預約保留量'].value) || 0));
              map[key + '_exists'] = true;
            });
            return map;
          });
      }

      // 2. 查詢歸還單上限
      let pReturn = Promise.resolve(null);
      if (type === TYPE_RETURN && refNo) {
        const qLend = F_NO + ' = "' + refNo + '" limit 1';
        let qHist = F_REF_NO + ' = "' + refNo + '" and ' + F_STATUS + ' in ("' + ST_DONE + '")';
        if (recId) qHist += ' and $id != "' + recId + '"';

        pReturn = Promise.all([
          kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: SELF_APP_ID, query: qLend }),
          kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: SELF_APP_ID, query: qHist })
        ]).then(results => {
          const orig = results[0].records[0];
          const hists = results[1].records;
          if (!orig) return null;

          const borrowed = {};
          (orig[F_SUBTABLE] ? orig[F_SUBTABLE].value : []).forEach(r => {
            const c = r.value[F_CODE] ? r.value[F_CODE].value : '';
            if (c) borrowed[c] = (borrowed[c] || 0) + (parseFloat(r.value[F_QTY].value) || 0);
          });

          const returned = {};
          hists.forEach(h => {
            (h[F_SUBTABLE] ? h[F_SUBTABLE].value : []).forEach(r => {
              const c = r.value[F_CODE] ? r.value[F_CODE].value : '';
              if (c) returned[c] = (returned[c] || 0) + (parseFloat(r.value[F_QTY].value) || 0);
            });
          });

          const maxMap = {};
          codes.forEach(c => { maxMap[c] = (borrowed[c] || 0) - (returned[c] || 0); });
          return maxMap;
        });
      }

      // 3. 寫入紅/藍字
      Promise.all([pStock, pReturn]).then(results => {
        const stockMap = results[0];
        const maxMap = results[1];

        const currObj = SP.getRec();
        if (!currObj) return;
        const cRows = getRows(currObj.record);

        const summary = {};
        cRows.forEach(r => {
          const c = r.value[F_CODE] ? r.value[F_CODE].value : '';
          const q = parseFloat(r.value[F_QTY] ? r.value[F_QTY].value : 0) || 0;
          if (c) summary[c] = (summary[c] || 0) + q;
        });

        cRows.forEach(r => {
          const c = r.value[F_CODE] ? r.value[F_CODE].value : '';
          const qtyF = r.value[F_QTY];
          if (!c || !qtyF) return;

          const tq = summary[c];
          const errMsgs = [];

          if (maxMap !== null) {
            const m = maxMap[c] !== undefined ? maxMap[c] : 0;
            if (tq > m) {
              qtyF.error = '❌ 超過借調數量，最多僅需再歸還: ' + m;
              return;
            }
          }

          if (fromWh && !stockMap[fromWh + '_' + c + '_exists']) {
            errMsgs.push('❌ 撥出倉庫【' + fromWh + '】無此商品紀錄！');
          }
          if (toWh && !stockMap[toWh + '_' + c + '_exists']) {
            errMsgs.push('❌ 撥入倉庫【' + toWh + '】無此商品紀錄！');
          }

          if (errMsgs.length > 0) {
            qtyF.error = errMsgs.join('\n');
            return;
          }

          if (fromWh) {
            const avail = stockMap[fromWh + '_' + c];
            if (tq > avail) {
              qtyF.error = '❌ 庫存不足！剩餘：' + avail;
            } else {
              if (maxMap !== null && maxMap[c] !== undefined) {
                qtyF.error = '💡 可用庫存: ' + avail + ' / 剩餘需歸還: ' + maxMap[c];
              } else {
                qtyF.error = '💡 目前庫存可用量：' + avail;
              }
            }
          }
        });

        SP.setRec(currObj);
      }).catch(err => {
        console.error('Validation API Error:', err);
      });

    }, 300);
  }
  Transfer.triggerInlineValidation = triggerInlineValidation;

  // 掃碼加入明細後（程式化 setRec 不會觸發 change 事件）手動刷新驗證
  Transfer.afterAddToSubtable = function () {
    const recObj = SP.getRec();
    if (recObj) {
      getRows(recObj.record).forEach(r => { if (r.value[F_QTY]) r.value[F_QTY].error = null; });
    }
    triggerInlineValidation();
  };

  // ══════════════════════════════════════════════
  //  子表格 / 雙倉庫觸發欄位變動 → 即時驗證（桌面版 + 手機版）
  // ══════════════════════════════════════════════
  kintone.events.on(bothEvents([
    'app.record.create.change.' + F_FROM_WH_TRIGGER,
    'app.record.edit.change.' + F_FROM_WH_TRIGGER,
    'app.record.create.change.' + F_TO_WH_TRIGGER,
    'app.record.edit.change.' + F_TO_WH_TRIGGER,
    'app.record.create.change.' + F_SUBTABLE,
    'app.record.edit.change.' + F_SUBTABLE,
    'app.record.create.change.' + F_CODE,
    'app.record.edit.change.' + F_CODE,
    'app.record.create.change.' + F_QTY,
    'app.record.edit.change.' + F_QTY
  ]), function (event) {
    try {
      getRows(event.record).forEach(r => { if (r.value[F_QTY]) r.value[F_QTY].error = null; });
      triggerInlineValidation();
    } catch (err) {
      console.error('[調撥模組] 子表格變動處理失敗：', err);
    }
    return event;
  });

  // ══════════════════════════════════════════════
  //  1. 畫面載入與欄位屬性控制（桌面版 + 手機版）
  // ══════════════════════════════════════════════
  kintone.events.on(bothEvents(['app.record.create.show', 'app.record.edit.show']), function (event) {
    // 這支 handler 排在 desktop-events.js 之前載入，kintone 的事件是照
    // manifest 載入順序串接執行的——這裡任何一行同步拋錯，都會讓整條鏈
    // 中斷，害 desktop-events.js 裡負責掛「📷 掃描條碼」按鈕的 handler
    // 完全不會被呼叫到。手機版的 kintone.mobile.app.record 對某些桌面版
    // 才有的 API（例如 getFieldElement）支援不穩定，所以整段包 try/catch，
    // 確保不管內部發生什麼事，一定會 return event，不截斷後面的按鈕注入。
    try {
      const record = event.record;

      // event.type 手機版會帶 mobile. 前綴（例如 'mobile.app.record.create.show'），
      // 用 includes() 而非嚴格等於，才能同時涵蓋桌面／手機兩種寫法。
      if (event.type.includes('.create.show') && event.reuse) {
        if (record[F_STATUS]) record[F_STATUS].value = ST_PROCESSING;
        if (record[F_REF_NO]) record[F_REF_NO].value = '';
      }

      if (record[F_RETURN]) applyReturnStatus(record);

      const status = record[F_STATUS] ? record[F_STATUS].value : '';
      const isLocked = (status === ST_SHIPPING || status === ST_DONE);

      if (isLocked) {
        if (record[F_FROM_WH]) record[F_FROM_WH].disabled = true;
        if (record[F_TO_WH]) record[F_TO_WH].disabled = true;
        if (record[F_TYPE]) record[F_TYPE].disabled = true;
        if (record[F_REF_NO]) record[F_REF_NO].disabled = true;

        try {
          const subtableEl = SP.kApp.record.getFieldElement(F_SUBTABLE);
          if (subtableEl) {
            subtableEl.querySelectorAll('.subtable-operation-gaia').forEach(btn => { btn.style.display = 'none'; });
          }
        } catch (err) {
          // 手機版 getFieldElement 支援不穩定，隱藏子表格操作按鈕失敗時
          // 不影響欄位鎖定本身，安靜跳過即可。
          console.warn('[調撥模組] getFieldElement 失敗（可能是手機版限制）：', err);
        }

        getRows(record).forEach(row => {
          if (row.value[F_QTY]) row.value[F_QTY].disabled = true;
          if (row.value[F_CODE]) row.value[F_CODE].disabled = true;
          if (row.value[F_NAME]) row.value[F_NAME].disabled = true;
          if (F_UNIT && row.value[F_UNIT]) row.value[F_UNIT].disabled = true;
          if (row.value[SP.F_BARCODE]) row.value[SP.F_BARCODE].disabled = true;
        });
      }

      const type = record[F_TYPE] ? record[F_TYPE].value : '';
      const refNo = record[F_REF_NO] ? record[F_REF_NO].value : '';
      const isReuseDraft = (event.type.includes('.create.show') && event.reuse);

      if (type === TYPE_RETURN) {
        if (!isLocked) setTimeout(() => renderReturnSelector(refNo), 300);
        if (refNo) renderHistoryPanel(refNo);
      } else if (type === TYPE_LEND && record[F_NO].value && !isReuseDraft) {
        // 複製出來的草稿即使「調撥單號」欄位不是自動編號、舊值被一併複製過來，
        // 也不該顯示舊單的借還紀錄——這張草稿還沒存檔，不是同一張單據。
        renderHistoryPanel(record[F_NO].value);
      }

      if (!isLocked) triggerInlineValidation();
    } catch (err) {
      console.error('[調撥模組] app.record.show 處理失敗，欄位鎖定/面板顯示可能不完整：', err);
    }
    return event;
  });

  // ══════════════════════════════════════════════
  //  1-1. 唯讀檢視畫面也顯示借還紀錄面板（桌面版 + 手機版）
  // ══════════════════════════════════════════════
  kintone.events.on(bothEvents(['app.record.detail.show']), function (event) {
    try {
      const record = event.record;
      const type = record[F_TYPE] ? record[F_TYPE].value : '';
      const refNo = type === TYPE_LEND ? record[F_NO].value : (record[F_REF_NO] ? record[F_REF_NO].value : '');
      renderHistoryPanel(refNo);
    } catch (err) {
      console.error('[調撥模組] detail.show 借還面板渲染失敗：', err);
    }
    return event;
  });

  // 調撥性質變更（桌面版 + 手機版）
  kintone.events.on(bothEvents(['app.record.create.change.' + F_TYPE, 'app.record.edit.change.' + F_TYPE]), function (event) {
    try {
      const record = event.record;
      applyReturnStatus(record);

      const type = record[F_TYPE] ? record[F_TYPE].value : '';
      const old = document.getElementById('inv-return-selector');
      const oldPanel = document.getElementById('inv-history-panel');

      if (type !== TYPE_RETURN) {
        if (old) old.remove();
        if (oldPanel) oldPanel.remove();
      } else {
        const refNo = record[F_REF_NO] ? record[F_REF_NO].value : '';
        renderReturnSelector(refNo);
        if (refNo) renderHistoryPanel(refNo);
      }

      triggerInlineValidation();
    } catch (err) {
      console.error('[調撥模組] 調撥性質變更處理失敗：', err);
    }
    return event;
  });

  // 調撥狀態變更（桌面版 + 手機版）
  kintone.events.on(bothEvents(['app.record.create.change.' + F_STATUS, 'app.record.edit.change.' + F_STATUS]), function (event) {
    try {
      applyReturnStatus(event.record);
    } catch (err) {
      console.error('[調撥模組] 調撥狀態變更處理失敗：', err);
    }
    return event;
  });

  // ══════════════════════════════════════════════
  //  2. 儲存前驗證與庫存同步（Submit 階段）
  //  由 desktop-events.js 分派呼叫（desktop-events.js 已同時涵蓋桌面/手機事件）。
  // ══════════════════════════════════════════════
  Transfer.validateSubmit = function (event) {
    const record = event.record;
    // event.type 手機版會帶 mobile. 前綴，用 includes() 而非嚴格等於。
    const isNew = event.type.includes('.create.submit');
    const recId = isNew ? null : SP.getRecId();
    const fromWh = record[F_FROM_WH] ? record[F_FROM_WH].value : '';
    const toWh = record[F_TO_WH] ? record[F_TO_WH].value : '';
    const newSt = record[F_STATUS] ? record[F_STATUS].value : '';
    const type = record[F_TYPE] ? record[F_TYPE].value : '';
    const refNo = record[F_REF_NO] ? record[F_REF_NO].value : '';
    const rows = getRows(record);
    const codes = getItemCodes(record);

    if (!fromWh || !toWh) { event.error = '❌ 請先選擇「撥出倉庫」與「撥入倉庫」。'; return event; }
    if (fromWh === toWh) { event.error = '❌ 撥出倉庫與撥入倉庫不可相同。'; return event; }
    if (type === TYPE_RETURN && !refNo) { event.error = '❌ 借調歸還單請選擇對應借調單。'; return event; }

    const originalPromise = isNew
      ? Promise.resolve(null)
      : kintone.api(kintone.api.url('/k/v1/record', true), 'GET', { app: SELF_APP_ID, id: recId }).then(res => res.record);

    return originalPromise.then(originalRecord => {
      const oldSt = originalRecord ? (originalRecord[F_STATUS] ? originalRecord[F_STATUS].value : ST_PROCESSING) : ST_PROCESSING;

      if (!isNew && oldSt === ST_DONE) {
        return Promise.reject(new Error('❌ 調撥完成的單據不可再修改。'));
      }

      const oldRowMap = {};
      if (originalRecord) {
        getRows(originalRecord).forEach(r => {
          const c = r.value[F_CODE] ? r.value[F_CODE].value : '';
          const q = parseFloat(r.value[F_QTY] ? r.value[F_QTY].value : 0) || 0;
          if (c) oldRowMap[c] = (oldRowMap[c] || 0) + q;
        });
      }

      let validateReturnPromise = Promise.resolve({ ok: true, isFullyReturned: false });

      if (type === TYPE_RETURN && refNo) {
        const qLend = F_NO + ' = "' + refNo + '" limit 1';
        let qHist = F_REF_NO + ' = "' + refNo + '" and ' + F_STATUS + ' in ("' + ST_DONE + '")';
        if (recId) qHist += ' and $id != "' + recId + '"';

        validateReturnPromise = Promise.all([
          kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: SELF_APP_ID, query: qLend }),
          kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: SELF_APP_ID, query: qHist })
        ]).then(res => {
          const origLend = res[0].records[0];
          const hists = res[1].records;

          if (!origLend) return Promise.reject(new Error('❌ 找不到對應的借調單號。'));

          const borrowedMap = {};
          (origLend[F_SUBTABLE] ? origLend[F_SUBTABLE].value : []).forEach(r => {
            const c = r.value[F_CODE] ? r.value[F_CODE].value : '';
            const q = parseFloat(r.value[F_QTY] ? r.value[F_QTY].value : 0) || 0;
            if (c) borrowedMap[c] = (borrowedMap[c] || 0) + q;
          });

          const historyMap = {};
          hists.forEach(h => {
            (h[F_SUBTABLE] ? h[F_SUBTABLE].value : []).forEach(r => {
              const c = r.value[F_CODE] ? r.value[F_CODE].value : '';
              const q = parseFloat(r.value[F_QTY] ? r.value[F_QTY].value : 0) || 0;
              if (c) historyMap[c] = (historyMap[c] || 0) + q;
            });
          });

          let hasError = false;
          let isFully = true;

          rows.forEach(row => {
            const c = row.value[F_CODE] ? row.value[F_CODE].value : '';
            const currQty = parseFloat(row.value[F_QTY] ? row.value[F_QTY].value : 0) || 0;
            if (!c) return;

            const maxRet = (borrowedMap[c] || 0) - (historyMap[c] || 0);
            if (currQty > maxRet) {
              row.value[F_QTY].error = '❌ 超過借調餘額！最多僅可再歸還: ' + maxRet;
              hasError = true;
            }
          });

          if (hasError) return Promise.reject(new Error('❌ 存檔失敗：明細中有超過借調餘額的歸還！'));

          Object.keys(borrowedMap).forEach(c => {
            const pastRet = historyMap[c] || 0;
            let currRet = 0;
            rows.forEach(r => { if (r.value[F_CODE] && r.value[F_CODE].value === c) currRet += (parseFloat(r.value[F_QTY].value) || 0); });
            if (pastRet + currRet < borrowedMap[c]) isFully = false;
          });

          return { ok: true, isFullyReturned: isFully };
        });
      }

      return validateReturnPromise.then(returnCheck => {
        const codeQ = codes.map(c => '商品料號 = "' + c + '"').join(' or ');
        const whQ = '倉庫名稱 in ("' + fromWh + '", "' + toWh + '")';
        const qStock = '(' + codeQ + ') and (' + whQ + ')';

        if (codes.length === 0) return { returnCheck: returnCheck, stockMap: {} };

        return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: STOCK_APP_ID, query: qStock }).then(res => {
          const stockMap = {};
          res.records.forEach(r => {
            const key = r['倉庫名稱'].value + '_' + r['商品料號'].value;
            stockMap[key] = {
              id: r.$id.value,
              inQty: parseFloat(r['進貨量'].value) || 0,
              outQty: parseFloat(r['出貨量'].value) || 0,
              reserveQty: parseFloat(r['預約保留量'].value) || 0
            };
            stockMap[key + '_exists'] = true;
          });
          return { returnCheck: returnCheck, stockMap: stockMap };
        });

      }).then(data => {
        const returnCheck = data.returnCheck;
        const stockMap = data.stockMap;
        const missingErrors = [];
        let hasStockError = false;

        rows.forEach(row => {
          const code = row.value[F_CODE] ? row.value[F_CODE].value : '';
          const qty = parseFloat(row.value[F_QTY] ? row.value[F_QTY].value : 0) || 0;
          if (!code || qty <= 0) return;

          const sfExists = stockMap[fromWh + '_' + code + '_exists'];
          const stExists = stockMap[toWh + '_' + code + '_exists'];

          if (!sfExists) missingErrors.push('❌ 撥出倉庫【' + fromWh + '】無此商品紀錄！(料號：' + code + ')');
          if (!stExists) missingErrors.push('❌ 撥入倉庫【' + toWh + '】無此商品紀錄！(料號：' + code + ')');

          if (sfExists) {
            const sf = stockMap[fromWh + '_' + code];
            const originalReserved = (oldSt === ST_SHIPPING) ? (oldRowMap[code] || 0) : 0;
            const realAvail = sf.inQty - sf.outQty - (sf.reserveQty - originalReserved);

            row.value[F_QTY].error = null;
            if (qty > realAvail) {
              row.value[F_QTY].error = '⚠️ 剩餘可用庫存不足，目前最多可調整為 ' + realAvail;
              hasStockError = true;
            }
          }
        });

        if (missingErrors.length > 0) return Promise.reject(new Error('⛔ 儲存失敗！未在總表配置品項：\n\n' + missingErrors.join('\n')));
        if (hasStockError) return Promise.reject(new Error('⛔ 儲存失敗：有品項可用庫存不足。'));

        const deltaMap = {};
        function addDelta(stockId, field, delta) {
          if (delta === 0) return;
          if (!deltaMap[stockId]) deltaMap[stockId] = {};
          deltaMap[stockId][field] = (deltaMap[stockId][field] || 0) + delta;
        }

        rows.forEach(row => {
          const code = row.value[F_CODE] ? row.value[F_CODE].value : '';
          const newQty = parseFloat(row.value[F_QTY] ? row.value[F_QTY].value : 0) || 0;
          if (!code) return;

          const sf = stockMap[fromWh + '_' + code];
          const st = stockMap[toWh + '_' + code];
          const oldQty = oldRowMap[code] || 0;

          if (sf) {
            const oldReserveImpact = (oldSt === ST_SHIPPING) ? oldQty : 0;
            const newReserveImpact = (newSt === ST_SHIPPING) ? newQty : 0;
            addDelta(sf.id, '預約保留量', newReserveImpact - oldReserveImpact);
          }

          const oldStockImpact = (oldSt === ST_DONE) ? oldQty : 0;
          const newStockImpact = (newSt === ST_DONE) ? newQty : 0;
          const stockDelta = newStockImpact - oldStockImpact;

          if (stockDelta !== 0) {
            if (sf) addDelta(sf.id, '出貨量', +stockDelta);
            if (st) addDelta(st.id, '進貨量', +stockDelta);
          }
        });

        const allEntries = Object.values(stockMap).filter(e => e && e.id);
        const recordsToUpdate = Object.keys(deltaMap).map(id => {
          const deltas = deltaMap[id];
          const entry = allEntries.find(e => e.id === id);
          const rec = {};
          if (deltas['預約保留量'] !== undefined) rec['預約保留量'] = { value: Math.max(0, (entry ? entry.reserveQty : 0) + deltas['預約保留量']) };
          if (deltas['出貨量'] !== undefined) rec['出貨量'] = { value: Math.max(0, (entry ? entry.outQty : 0) + deltas['出貨量']) };
          if (deltas['進貨量'] !== undefined) rec['進貨量'] = { value: Math.max(0, (entry ? entry.inQty : 0) + deltas['進貨量']) };
          return { id: id, record: rec };
        });

        const finishUp = () => {
          if (type === TYPE_RETURN && newSt === ST_DONE) {
            const targetSt = returnCheck.isFullyReturned ? RET_DONE : RET_PENDING;
            return updateOriginalLendRecord(refNo, targetSt).then(() => event);
          }
          return event;
        };

        if (recordsToUpdate.length > 0) {
          return kintone.api(kintone.api.url('/k/v1/records', true), 'PUT', { app: STOCK_APP_ID, records: recordsToUpdate }).then(finishUp);
        }
        return finishUp();
      });
    }).catch(err => {
      console.error('調撥存檔失敗:', err);
      event.error = err.message || '❌ 同步失敗，請聯繫管理員。';
      return event;
    });
  };

  // ══════════════════════════════════════════════
  //  3. 刪除還原
  //  由 desktop-events.js 分派呼叫。
  // ══════════════════════════════════════════════
  Transfer.handleDelete = function (event) {
    const record = event.record;
    const status = record[F_STATUS] ? record[F_STATUS].value : '';
    const fromWh = record[F_FROM_WH] ? record[F_FROM_WH].value : '';
    const toWh = record[F_TO_WH] ? record[F_TO_WH].value : '';
    const type = record[F_TYPE] ? record[F_TYPE].value : '';
    const refNo = record[F_REF_NO] ? record[F_REF_NO].value : '';
    const codes = getItemCodes(record);
    const rows = getRows(record);

    if (status === ST_PROCESSING) return event;

    const codeQ = codes.map(c => '商品料號 = "' + c + '"').join(' or ');
    const whQ = '倉庫名稱 in ("' + fromWh + '", "' + toWh + '")';
    const qStock = '(' + codeQ + ') and (' + whQ + ')';

    return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: STOCK_APP_ID, query: qStock }).then(res => {
      const stockMap = {};
      res.records.forEach(r => {
        const key = r['倉庫名稱'].value + '_' + r['商品料號'].value;
        stockMap[key] = {
          id: r.$id.value,
          inQty: parseFloat(r['進貨量'].value) || 0,
          outQty: parseFloat(r['出貨量'].value) || 0,
          reserveQty: parseFloat(r['預約保留量'].value) || 0
        };
      });

      const deltaMap = {};
      function addDelta(stockId, field, delta) {
        if (!deltaMap[stockId]) deltaMap[stockId] = {};
        deltaMap[stockId][field] = (deltaMap[stockId][field] || 0) + delta;
      }

      rows.forEach(row => {
        const code = row.value[F_CODE] ? row.value[F_CODE].value : '';
        const qty = parseFloat(row.value[F_QTY] ? row.value[F_QTY].value : 0) || 0;
        if (!code || qty <= 0) return;

        const sf = stockMap[fromWh + '_' + code];
        const st = stockMap[toWh + '_' + code];

        if (status === ST_SHIPPING && sf) addDelta(sf.id, '預約保留量', -qty);
        if (status === ST_DONE) {
          if (sf) addDelta(sf.id, '出貨量', -qty);
          if (st) addDelta(st.id, '進貨量', -qty);
        }
      });

      const allEntries = Object.values(stockMap);
      const recordsToUpdate = Object.keys(deltaMap).map(id => {
        const deltas = deltaMap[id];
        const entry = allEntries.find(e => e.id === id);
        const rec = {};
        if (deltas['預約保留量'] !== undefined) rec['預約保留量'] = { value: Math.max(0, (entry ? entry.reserveQty : 0) + deltas['預約保留量']) };
        if (deltas['出貨量'] !== undefined) rec['出貨量'] = { value: Math.max(0, (entry ? entry.outQty : 0) + deltas['出貨量']) };
        if (deltas['進貨量'] !== undefined) rec['進貨量'] = { value: Math.max(0, (entry ? entry.inQty : 0) + deltas['進貨量']) };
        return { id: id, record: rec };
      });

      const promises = [];
      if (recordsToUpdate.length > 0) {
        promises.push(kintone.api(kintone.api.url('/k/v1/records', true), 'PUT', { app: STOCK_APP_ID, records: recordsToUpdate }));
      }
      if (type === TYPE_RETURN && status === ST_DONE && refNo) {
        promises.push(updateOriginalLendRecord(refNo, RET_PENDING));
      }
      if (promises.length === 0) return event;
      return Promise.all(promises).then(() => event);

    }).catch(err => {
      event.error = '❌ 刪除調撥單失敗，雙向解鎖還原失敗：' + err.message;
      return event;
    });
  };

  // handleSubtableChange：desktop-events.js 共用的子表格監聽（F_PROD_NAME / F_PO_QTY 變動時）
  // 也會打進來，這裡只需要重新觸發一次防手震驗證即可，實際欄位監聽已經在本檔案
  // 開頭自行註冊得更完整（含雙倉庫觸發欄位），這裡重複呼叫是安全的（有 debounce）。
  Transfer.handleSubtableChange = function (event) {
    triggerInlineValidation();
    return event;
  };

})();
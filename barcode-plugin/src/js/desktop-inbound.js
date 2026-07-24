(function () {
  'use strict';

  /* ═══════════════════════════════════════════════
     desktop-inbound.js — 進貨單（採購入庫）專屬邏輯
     只在 SP.OPT_IS_SHIPMENT === false 時會被呼叫。

     🔧 [2026-07 修正] 新增存檔成功後／刪除時的庫存同步邏輯
     （getInboundSummary / updateInventoryInbound / handleSubmitSuccess /
     handleDelete）。原本這支檔案只有存檔前驗證，完全沒有把
     「已入庫數量」寫回庫存 App 的「進貨量」欄位，導致進貨單存檔後
     庫存明細的「累計入庫量」／區間統計「進貨量」都不會更新。
     寫法比照 desktop-outbound.js 既有的 getSalesSummary /
     updateInventoryOutbound 模式，保持專案風格一致。
  ═══════════════════════════════════════════════ */

  const SP = window.SP;
  if (!SP || SP.DISABLED) return;

  const Inbound = SP.Inbound = {};

  // 進貨模組專屬常數
  const F_RETURN_QTY = '退貨數量';
  const F_CLOSED = '立帳狀態';
  const CLOSED_VALUE = '已立帳核銷';

  // ══════════════════════════════════════════════
  //  工具：計算單行使用量與剩餘量
  //  有效使用量 = 已入庫數量 + 退貨數量
  //  剩餘可用量 = 採購數量 - 有效使用量
  // ══════════════════════════════════════════════
  function calcRowRemaining(row) {
    const qtyField = SP.resolveQtyField(row);
    const poQty = parseFloat(row.value[qtyField]?.value) || 0;
    const inQty = parseFloat(row.value[SP.F_IN_QTY]?.value) || 0;
    const retQty = parseFloat(row.value[F_RETURN_QTY]?.value) || 0;
    const used = inQty + retQty;
    const remaining = poQty - used;
    return { poQty, inQty, retQty, used, remaining };
  }

  // ══════════════════════════════════════════════
  //  即時紅字：已入庫數量 / 退貨數量 變動時觸發
  // ══════════════════════════════════════════════
  function validateRowQtyHint(row) {
    if (row.value[SP.F_IN_QTY]) row.value[SP.F_IN_QTY].error = null;
    if (row.value[F_RETURN_QTY]) row.value[F_RETURN_QTY].error = null;

    const { poQty, inQty, retQty, used, remaining } = calcRowRemaining(row);
    if (poQty === 0) return true;

    if (used > poQty) {
      const msg = `已入庫(${inQty}) + 退貨(${retQty}) = ${used}，超過採購量(${poQty})！`;
      if (row.value[SP.F_IN_QTY]) row.value[SP.F_IN_QTY].error = msg;
      if (row.value[F_RETURN_QTY]) row.value[F_RETURN_QTY].error = msg;
      return false;
    }

    if (row.value[SP.F_IN_QTY]) {
      row.value[SP.F_IN_QTY].error = remaining > 0
        ? `剩餘未入庫：${remaining}/採購 ${poQty}`
        : `已全數入庫完畢`;
    }
    return true;
  }


  // ══════════════════════════════════════════════
  //  已結案警告（編輯畫面進入時）
  // ══════════════════════════════════════════════
  Inbound.handleShowWarning = function (record) {
    const val = record[F_CLOSED]?.value;
    const isClosed = Array.isArray(val) ? val.includes(CLOSED_VALUE) : val === CLOSED_VALUE;
    if (isClosed) {
      setTimeout(() => {
        SP.showToast('此進貨單已結案，修改資料請謹慎確認，儲存後無法自動還原。', 'warn', 6000);
      }, 600);
    }
  };

  // ══════════════════════════════════════════════
  //  子表格欄位變動
  //  - 商品名稱清空 → 連動清空價格
  //  - 已入庫數量 / 退貨數量 變動 → 即時紅字
  // ══════════════════════════════════════════════
  Inbound.handleSubtableChange = function (event) {
    const row = event.changes.row;
    if (!row) return event;

    if (event.type.includes(SP.F_PROD_NAME) && !row.value[SP.F_PROD_NAME]?.value) {
      if (row.value[SP.F_LIST_PRICE]) row.value[SP.F_LIST_PRICE].value = '';
      if (row.value[SP.F_PRICE]) row.value[SP.F_PRICE].value = '';
    }

    if (event.type.includes(SP.F_IN_QTY) || event.type.includes(F_RETURN_QTY)) {
      validateRowQtyHint(row);
    }

    return event;
  };

  // ══════════════════════════════════════════════
  //  存檔前驗證
  //  1. 必須選擇廠商
  //  2. 已入庫 + 退貨 不可超過採購量
  //  3. 倉庫在庫存總表無建檔紀錄，禁止存檔
  // ══════════════════════════════════════════════
  Inbound.validateSubmit = function (event) {
    const record = event.record;
    const supp = record[SP.F_SUPPLIER_NAME]?.value || '';
    if (!supp) { event.error = '請先選擇廠商名稱再送出。'; return event; }

    const rows = record[SP.F_SUBTABLE]?.value || [];
    if (!rows.length) return event;

    const overQtyItems = [];
    const noStockItems = [];

    rows.forEach(row => {
      const isOk = validateRowQtyHint(row);

      if (!isOk) {
        const { used, poQty } = calcRowRemaining(row);
        overQtyItems.push(
          `${row.value[SP.F_PROD_NAME]?.value || '未知商品'}（已用 ${used}，採購量 ${poQty}）`
        );
      } else {
        // 足夠：清掉提示型文字讓 kintone 放行
        if (row.value[SP.F_IN_QTY]) row.value[SP.F_IN_QTY].error = null;
        if (row.value[F_RETURN_QTY]) row.value[F_RETURN_QTY].error = null;
      }

      // 倉庫庫存建檔檢查
      const whName = row.value[SP.F_WH]?.value || '';
      const pCode = row.value[SP.F_PROD_CODE]?.value || '';
      if (whName && pCode) {
        const stock = SP.fetchStockSync(whName, pCode);
        if (stock === -1) {
          if (row.value[SP.F_WH]) row.value[SP.F_WH].error = '此商品在此倉庫無庫存建檔紀錄！';
          noStockItems.push(`${row.value[SP.F_PROD_NAME]?.value || pCode}（倉庫：${whName}）`);
        }
      }
    });

    if (overQtyItems.length) {
      event.error = `入庫量 + 退貨量超過採購量，請修正後再存檔：\n ${overQtyItems.join('\n ')}`;
      return event;
    }
    if (noStockItems.length) {
      event.error = `存檔失敗：以下商品在指定倉庫尚未建立庫存總表紀錄，請先建檔：\n\n ${noStockItems.join('\n ')}`;
      return event;
    }
    return event;
  };

  // ══════════════════════════════════════════════
  //  🔧 [2026-07 新增] 整張單依「倉庫+料號」彙總本次「已入庫數量」
  //
  //  跟 Outbound.getSalesSummary 的差別：進貨單只有一種數量語意
  //  （已入庫數量），不像出貨單要拆保留量／已出貨量，所以彙總結果
  //  只有單一 inQty 欄位，維持結構單純。
  // ══════════════════════════════════════════════
  Inbound.getInboundSummary = function (record) {
    const summary = {};
    const subtable = record[SP.F_SUBTABLE]?.value || [];

    subtable.forEach(row => {
      const whName = row.value[SP.F_WH]?.value || '';
      const itemCode = row.value[SP.F_PROD_CODE]?.value || '';
      const inQty = parseFloat(row.value[SP.F_IN_QTY]?.value) || 0;
      const prodName = row.value[SP.F_PROD_NAME]?.value || itemCode;

      if (!whName || !itemCode) return;

      const key = `${whName}|||${itemCode}`;
      if (!summary[key]) {
        summary[key] = { inQty: 0, title: `「${whName}」的「${prodName}」` };
      }
      summary[key].inQty += inQty;
    });
    return summary;
  };

  // 🔧 [2026-07 新增] 依差異量把「進貨量」寫回庫存 App
  //    寫法比照 Outbound.updateInventoryOutbound：先 GET 對應記錄，
  //    在目前值上加差異量再 PUT 回去，避免直接覆蓋掉其他來源
  //    （例如調撥入庫）同時寫入的數字。
  Inbound.updateInventoryInbound = function (diffMap, event) {
    const keys = Object.keys(diffMap);
    if (!keys.length) return event;

    const itemCodes = [...new Set(keys.map(k => k.split('|||')[1]))];

    return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
      app: SP.INV_APP_ID, query: `商品料號 in ("${itemCodes.join('","')}")`
    }).then(resp => {
      const updates = [];
      resp.records.forEach(inv => {
        const iCode = inv['商品料號']?.value;
        const wName = inv['倉庫名稱']?.value;
        const localKey = `${wName}|||${iCode}`;
        const diff = diffMap[localKey];

        if (diff && diff.inQty !== 0) {
          updates.push({
            id: inv.$id.value,
            record: {
              '進貨量': { value: (parseFloat(inv['進貨量']?.value) || 0) + diff.inQty }
            }
          });
        }
      });
      if (!updates.length) return event;
      return kintone.api(kintone.api.url('/k/v1/records', true), 'PUT', {
        app: SP.INV_APP_ID, records: updates
      }).then(() => event);
    });
  };

  // 🔧 [2026-07 新增] 存檔成功後：依「新舊已入庫數量」的差異同步庫存
  //
  //  跟出貨模式一樣採「差異量」而非「總量」寫入，這樣同一張進貨單
  //  被反覆編輯（例如分批入庫、或把已入庫數量改小做更正）時，
  //  庫存 App 的「進貨量」才會正確地只加上「這次新增的差額」，
  //  而不會每次存檔都把整張單的已入庫數量重複疊加上去。
  //
  //  SP.state.originalInboundData 由 desktop-events.js 在
  //  app.record.edit.show 時透過 Inbound.getInboundSummary 快取，
  //  新增畫面（create）沒有「舊資料」，視為空物件即可。
  Inbound.handleSubmitSuccess = function (event) {
    const isCreate = event.type.includes('create');
    const newData = Inbound.getInboundSummary(event.record);
    const oldData = isCreate ? {} : (SP.state.originalInboundData || {});
    const allKeys = new Set([...Object.keys(newData), ...Object.keys(oldData)]);
    const diffMap = {};

    allKeys.forEach(key => {
      const n = newData[key] ? newData[key].inQty : 0;
      const o = oldData[key] ? oldData[key].inQty : 0;
      const d = n - o;
      if (d !== 0) diffMap[key] = { inQty: d };
    });
    return Inbound.updateInventoryInbound(diffMap, event);
  };

  // 🔧 [2026-07 新增] 刪除記錄歸還庫存
  //    整張單被刪除時，把該單累計的已入庫數量從「進貨量」扣回去。
  Inbound.handleDelete = function (event) {
    const deletedData = Inbound.getInboundSummary(event.record);
    const diffMap = {};
    Object.keys(deletedData).forEach(key => {
      diffMap[key] = { inQty: -deletedData[key].inQty };
    });
    return Inbound.updateInventoryInbound(diffMap, event);
  };

})();
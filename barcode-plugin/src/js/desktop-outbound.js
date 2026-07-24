(function () {
  'use strict';

  /* ═══════════════════════════════════════════════
     desktop-outbound.js — 出貨單（銷貨）專屬邏輯
     只在 SP.OPT_IS_SHIPMENT === true 時會被呼叫。
  ═══════════════════════════════════════════════ */

  const SP = window.SP;
  if (!SP || SP.DISABLED) return;

  const Outbound = SP.Outbound = {};

  // 🔧 [需依環境修改] 結案判斷欄位：應收款回寫的「立帳狀態」核取方塊
  //    （跟進貨單 desktop-inbound.js 用的是同一組欄位代碼／選項文字）
  const F_CLOSED = '立帳狀態';       // CHECK_BOX，應收款「已立帳核銷」勾選後由 App 2262 回寫
  const CLOSED_VALUE = '已立帳核銷'; // checkbox 選項文字，須與畫面顯示完全一致

  // 單行庫存防呆提示（即時紅字 / 藍字）
  Outbound.validateRowStockHint = function (row) {
    const whName = row.value[SP.F_WH]?.value || '';
    const pCode  = row.value[SP.F_PROD_CODE]?.value || '';
    const qtyField = SP.resolveQtyField(row);
    const qty = parseFloat(row.value[qtyField]?.value) || 0;

    if (row.value[qtyField]) row.value[qtyField].error = null;
    if (row.value[SP.F_WH]) row.value[SP.F_WH].error = null;

    if (!whName || !pCode) return true;

    const stock = SP.fetchStockSync(whName, pCode);

    if (stock === -1) {
      if (row.value[SP.F_WH]) row.value[SP.F_WH].error = '此倉庫無庫存紀錄！';
      if (row.value[qtyField]) row.value[qtyField].error = '無庫存';
      return false;
    } else if (stock !== null) {
      if (qty > stock) {
        if (row.value[qtyField]) row.value[qtyField].error = `庫存不足！剩餘：${stock}`;
        return false;
      } else {
        if (row.value[qtyField]) row.value[qtyField].error = `目前庫存可用量：${stock}`;
        return true;
      }
    }
    return true;
  };

  // 整張單依「倉庫+料號」彙總本次需求量（區分保留/已出貨）
  //
  // 判斷依據是「是否結案」（手動標記已出貨），跟「立帳狀態」
  // （應收款財務核銷回寫）刻意脫鉤：付款、出貨的先後順序在實務上
  // 不固定（先出貨後收款、或客戶先付款倉庫才出貨都可能發生），
  // 庫存要跟著實體「貨有沒有真的出去」走，不能被財務端牽動。
  Outbound.getSalesSummary = function (record) {
    const summary = {};
    const subtable = record[SP.F_SUBTABLE]?.value || [];
    const status   = record[SP.F_STATUS]?.value || '未結案';

    subtable.forEach(row => {
      const whName   = row.value[SP.F_WH]?.value || '';
      const itemCode = row.value[SP.F_PROD_CODE]?.value || '';
      const qtyField = SP.resolveQtyField(row);
      const qty      = parseFloat(row.value[qtyField]?.value) || 0;
      const prodName = row.value[SP.F_PROD_NAME]?.value || itemCode;

      if (!whName || !itemCode || qty === 0) return;

      const key = `${whName}|||${itemCode}`;
      if (!summary[key]) {
        summary[key] = { reserved: 0, shipped: 0, requestedTotal: 0, title: `「${whName}」的「${prodName}」` };
      }
      summary[key].requestedTotal += qty;
      if (status === '已結案') summary[key].shipped += qty;
      else                     summary[key].reserved += qty;
    });
    return summary;
  };

  Outbound.updateInventoryOutbound = function (diffMap, event) {
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

        if (diff) {
          updates.push({
            id: inv.$id.value,
            record: {
              '預約保留量': { value: (parseFloat(inv['預約保留量']?.value) || 0) + diff.reserved },
              '出貨量':     { value: (parseFloat(inv['出貨量']?.value)     || 0) + diff.shipped  }
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

  // 客戶名稱/客戶類型變更 → 重算所有行價格
  Outbound.handleCustomerTypeChange = function () {
    setTimeout(() => {
      const obj = SP.getRec();
      if (!obj) return;
      const newCustType = obj.record[SP.F_CUSTOMER_TYPE]?.value || '';
      if (newCustType !== SP.state.currentCustomerType) {
        SP.state.currentCustomerType = newCustType;
        obj.record[SP.F_SUBTABLE].value.forEach(row => {
          if (row.value[SP.F_PROD_CODE]?.value) SP.updateRowPrice(row, SP.state.currentCustomerType);
        });
        SP.setRec(obj);
      }
    }, 300);
  };

  // 子表格欄位變動：商品名稱變動時重新查價，任何變動都重新檢查庫存紅字
  Outbound.handleSubtableChange = function (event) {
    const row = event.changes.row;
    if (!row) return event;

    if (event.type.includes(SP.F_PROD_NAME)) {
      SP.state.currentCustomerType = event.record[SP.F_CUSTOMER_TYPE]?.value || '';
      SP.updateRowPrice(row, SP.state.currentCustomerType);
    }
    Outbound.validateRowStockHint(row);
    return event;
  };

  // ══════════════════════════════════════════════
  //  已結案警告（編輯畫面進入時）
  //
  //  🔧 出貨單的觸發條件跟進貨單不同：出貨單同時有「立帳狀態」
  //     （應收款核銷回寫）跟「是否結案」（手動標記已出貨）兩個欄位，
  //     只有兩者都成立──財務已核銷、貨也已標記出完──才代表這張單
  //     真的全部處理完畢，再被打開編輯才是需要提醒謹慎的情境。
  //     如果只有立帳狀態勾了、是否結案還沒勾（例如客戶先付款、
  //     倉庫還沒出貨），代表使用者正要進來補標記已出貨，
  //     這是正常流程，不需要跳警告。
  // ══════════════════════════════════════════════
  Outbound.handleShowWarning = function (record) {
    const closedVal = record[F_CLOSED]?.value;
    const isAccountClosed = Array.isArray(closedVal) ? closedVal.includes(CLOSED_VALUE) : closedVal === CLOSED_VALUE;
    const isShipmentClosed = record[SP.F_STATUS]?.value === '已結案';

    if (isAccountClosed && isShipmentClosed) {
      setTimeout(() => {
        SP.showToast('此出貨單已完成結案（已出貨且應收款已立帳核銷），修改資料請謹慎確認，儲存後無法自動還原。', 'warn', 6000);
      }, 600);
    }
  };

  // 存檔前驗證：單行庫存 + 同單加總聚合防呆
  Outbound.validateSubmit = function (event) {
    const record = event.record;
    const rows   = record[SP.F_SUBTABLE]?.value || [];
    if (!rows.length) return event;

    let hasError = false;
    rows.forEach(row => {
      const isOk = Outbound.validateRowStockHint(row);
      if (!isOk) hasError = true;
      else {
        const qtyField = SP.resolveQtyField(row);
        if (row.value[qtyField]) row.value[qtyField].error = null;
        if (row.value[SP.F_WH]) row.value[SP.F_WH].error = null;
      }
    });
    if (hasError) { event.error = '存檔失敗：明細中有商品庫存不足或倉庫無庫存。'; return event; }

    const newSalesData = Outbound.getSalesSummary(record);
    const keys = Object.keys(newSalesData);
    if (!keys.length) return event;

    const itemCodes = [...new Set(keys.map(k => k.split('|||')[1]))];

    return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
      app: SP.INV_APP_ID, query: `商品料號 in ("${itemCodes.join('","')}")`
    }).then(resp => {
      const stockMap = {};
      resp.records.forEach(inv => {
        const wName = inv['倉庫名稱']?.value;
        const iCode = inv['商品料號']?.value;
        const key = `${wName}|||${iCode}`;
        const curStr = inv['在庫量']?.value || inv['庫存數量']?.value || inv['目前庫存']?.value || '0';
        stockMap[key] = parseFloat(curStr) || 0;
      });

      let errorMsg = '';
      keys.forEach(key => {
        const { requestedTotal, title } = newSalesData[key];
        if (typeof stockMap[key] === 'undefined') {
          errorMsg += `找不到建檔紀錄：${title}\n`;
          return;
        }
        const oldQty = (event.type.includes('edit') && SP.state.originalSalesData[key])
          ? SP.state.originalSalesData[key].requestedTotal : 0;
        const available = stockMap[key] + oldQty;
        if (requestedTotal > available) {
          errorMsg += `庫存不足：${title} (總需求:${requestedTotal}，可用:${available})\n`;
        }
      });
      if (errorMsg) event.error = `存檔失敗，加總後庫存不足：\n\n${errorMsg}`;
      return event;
    });
  };

  // 存檔成功後：依差異量同步庫存（保留量／出貨量）
  Outbound.handleSubmitSuccess = function (event) {
    const isCreate = event.type.includes('create');
    const newData  = Outbound.getSalesSummary(event.record);
    const oldData  = isCreate ? {} : SP.state.originalSalesData;
    const allKeys  = new Set([...Object.keys(newData), ...Object.keys(oldData)]);
    const diffMap  = {};

    allKeys.forEach(key => {
      const n = newData[key] || { reserved: 0, shipped: 0 };
      const o = oldData[key] || { reserved: 0, shipped: 0 };
      const dr = n.reserved - o.reserved;
      const ds = n.shipped  - o.shipped;
      if (dr !== 0 || ds !== 0) diffMap[key] = { reserved: dr, shipped: ds };
    });
    return Outbound.updateInventoryOutbound(diffMap, event);
  };

  // 刪除記錄歸還庫存
  Outbound.handleDelete = function (event) {
    const deletedData = Outbound.getSalesSummary(event.record);
    const diffMap = {};
    Object.keys(deletedData).forEach(key => {
      diffMap[key] = { reserved: -deletedData[key].reserved, shipped: -deletedData[key].shipped };
    });
    return Outbound.updateInventoryOutbound(diffMap, event);
  };

})();
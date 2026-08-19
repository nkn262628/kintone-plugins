(function () {
  'use strict';

  /* ═══════════════════════════════════════════════
     desktop-events.js — kintone 事件註冊與分派
     只負責「監聽事件 → 依模式呼叫 SP.Inbound / SP.Outbound / SP.Transfer」，
     不寫商業邏輯，保持薄薄一層方便閱讀。

     調撥模式（transfer）另外有一批只跟借還子系統相關、
     跟進貨/出貨形狀完全不同的事件，是在 desktop-transfer.js
     裡自行註冊的，不在這支檔案的分派範圍內。

     🔧 [2026-07 修正] 事件 #5（存檔成功後同步庫存）與 #6（刪除歸還
     庫存）原本都寫死「僅出貨模式」，導致進貨單存檔成功後從來沒有
     把「已入庫數量」寫回庫存 App 的「進貨量」欄位，刪除進貨單時也
     沒有扣回庫存。現在改為依 SP.OPT_APP_MODE 分派給對應模組
     （desktop-inbound.js 新增的 Inbound.handleSubmitSuccess /
     Inbound.handleDelete）。同時在事件 #1（畫面載入）比照出貨模式，
     於進貨單編輯畫面進入時，用 Inbound.getInboundSummary 快取
     SP.state.originalInboundData，讓 handleSubmitSuccess 能用
     「新舊差異量」而非「總量」寫回庫存，避免重複編輯同一張單時
     把已入庫數量疊加好幾次。
  ═══════════════════════════════════════════════ */

  const SP = window.SP;
  if (!SP || SP.DISABLED) return;

  // ──────────────────────────────────────────────
  //  1. 進入畫面（桌面版 + 手機版）
  // ──────────────────────────────────────────────
  kintone.events.on([
    'app.record.create.show', 'app.record.edit.show',
    'mobile.app.record.create.show', 'mobile.app.record.edit.show',
  ], function (event) {
    const record = event.record;
    SP.state.currentCustomerType = record[SP.F_CUSTOMER_TYPE]?.value || '';

    // 🔧 [2026-08 調整] 不再強制鎖定單號欄位，改由客戶自動編號外掛或手動輸入。
    // if (record[SP.F_PO_NUM]) {
    //   record[SP.F_PO_NUM].disabled = true;
    //   if (event.type.includes('.create.show')) record[SP.F_PO_NUM].value = '';
    // }

    if (SP.OPT_IS_SHIPMENT) {
      SP.state.originalSalesData = (event.type.includes('.edit.show'))
        ? SP.Outbound.getSalesSummary(record)
        : {};
    } else if (SP.OPT_APP_MODE === 'in') {
      // 🔧 [2026-07 新增] 進貨模式：編輯畫面進入時快取「原始已入庫數量」，
      //    供存檔成功後計算差異量使用（比照出貨模式 originalSalesData 的做法）。
      SP.state.originalInboundData = (event.type.includes('.edit.show'))
        ? SP.Inbound.getInboundSummary(record)
        : {};
    }

    // 已結案警告 Toast：調撥模式的警告／欄位鎖定邏輯完全由
    // desktop-transfer.js 自己的 show 事件處理，這裡略過避免重複。
    if (event.type.includes('.edit.show')) {
      if (SP.OPT_APP_MODE === 'transfer') {
        // no-op：交給 desktop-transfer.js 自己的事件處理
      } else if (SP.OPT_IS_SHIPMENT) {
        SP.Outbound.handleShowWarning(record);
      } else {
        SP.Inbound.handleShowWarning(record);
      }
    }

    setTimeout(() => {
      if (document.getElementById('sp-open-btn')) return;
      const btn = document.createElement('button');
      btn.id = 'sp-open-btn';
      btn.textContent = '掃描條碼';
      btn.style.cssText = 'background:#185FA5;color:#fff;border:none;border-radius:5px;padding:10px 20px;font-size:16px;font-weight:bold;cursor:pointer;margin:8px;box-shadow:0 2px 4px rgba(0,0,0,.2)';
      btn.onclick = () => SP.scanPanel.open();

      // 1. 優先掛在使用者指定的 Space 欄位
      try {
        const space = SP.kApp.record.getSpaceElement(SP.SCAN_SPACE_ID);
        if (space) { space.appendChild(btn); return; }
      } catch (err) {
        console.warn('[條碼掃描外掛] getSpaceElement 失敗，改用備援掛載方式：', err);
      }

      // 2. 桌面版退而求其次掛在標題列選單區
      try {
        if (!SP.isMobile && SP.kApp.record.getHeaderMenuSpaceElement) {
          const header = SP.kApp.record.getHeaderMenuSpaceElement();
          if (header) { btn.style.marginLeft = '10px'; header.appendChild(btn); return; }
        }
      } catch (err) {
        console.warn('[條碼掃描外掛] getHeaderMenuSpaceElement 失敗，改用備援掛載方式：', err);
      }

      // 3. 最終備援：position:fixed 貼在畫面右下角（桌面／手機皆適用）
      btn.style.cssText = 'position:fixed;right:16px;bottom:76px;z-index:99990;background:#185FA5;color:#fff;border:none;border-radius:28px;padding:14px 20px;font-size:15px;font-weight:bold;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);';
      document.body.appendChild(btn);
    }, 300);

    return event;
  });

  // ──────────────────────────────────────────────
  //  2. 客戶名稱/客戶類型變更 → 重算所有行價格（僅出貨模式生效）
  // ──────────────────────────────────────────────
  const typeEvents = [SP.F_CUSTOMER_NAME, SP.F_CUSTOMER_TYPE].filter(Boolean)
    .flatMap(f => [
      `app.record.create.change.${f}`, `app.record.edit.change.${f}`,
      `mobile.app.record.create.change.${f}`, `mobile.app.record.edit.change.${f}`,
    ]);

  if (typeEvents.length > 0) {
    kintone.events.on(typeEvents, function (event) {
      if (SP.OPT_IS_SHIPMENT) SP.Outbound.handleCustomerTypeChange();
      return event;
    });
  }

  // ──────────────────────────────────────────────
  //  3. 子表格欄位變動 → 帶入價格 + 即時紅字
  //
  //  Lookup 欄位（例如「出貨倉庫」）本身的 change 事件不會觸發；
  //  真正觸發的是它連動寫入的唯讀欄位（F_WH_TRIGGER）。
  //  手機版事件名稱前綴改為 mobile.app.record。
  // ──────────────────────────────────────────────
  const subtableChangeFields = [
    SP.F_PROD_NAME, SP.F_PO_QTY, SP.F_WH_TRIGGER, SP.F_IN_QTY, '退貨數量',
  ].filter(Boolean);

  const subtableChangeEvents = subtableChangeFields.flatMap(f => [
    `app.record.create.change.${f}`,
    `app.record.edit.change.${f}`,
    `mobile.app.record.create.change.${f}`,
    `mobile.app.record.edit.change.${f}`,
  ]);

  kintone.events.on(subtableChangeEvents, function (event) {
    if (!event.changes.row) return event;
    if (SP.OPT_APP_MODE === 'transfer') return SP.Transfer.handleSubtableChange(event);
    return SP.OPT_IS_SHIPMENT
      ? SP.Outbound.handleSubtableChange(event)
      : SP.Inbound.handleSubtableChange(event);
  });

  // ──────────────────────────────────────────────
  //  4. 存檔前防呆（桌面版 + 手機版）
  // ──────────────────────────────────────────────
  kintone.events.on([
    'app.record.create.submit', 'app.record.edit.submit',
    'mobile.app.record.create.submit', 'mobile.app.record.edit.submit',
  ], function (event) {
    if (SP.OPT_APP_MODE === 'transfer') return SP.Transfer.validateSubmit(event);
    return SP.OPT_IS_SHIPMENT
      ? SP.Outbound.validateSubmit(event)
      : SP.Inbound.validateSubmit(event);
  });

  // ──────────────────────────────────────────────
  //  5. 存檔成功後同步庫存（進貨/出貨模式；桌面版 + 手機版）
  //
  //  🔧 [2026-07 修正] 原本只判斷 SP.OPT_IS_SHIPMENT，進貨模式一律
  //  略過，導致進貨單存檔成功後不會把「已入庫數量」寫回庫存 App。
  //  調撥模式的庫存同步是在 validateSubmit（存檔前）就直接做完
  //  （見 desktop-transfer.js），不需要、也不應該在這裡重複處理，
  //  所以維持排除 transfer。
  // ──────────────────────────────────────────────
  kintone.events.on([
    'app.record.create.submit.success', 'app.record.edit.submit.success',
    'mobile.app.record.create.submit.success', 'mobile.app.record.edit.submit.success',
  ], function (event) {
    if (!SP.OPT_INVENTORY_SYNC) return event;
    if (SP.OPT_APP_MODE === 'transfer') return event;
    return SP.OPT_IS_SHIPMENT
      ? SP.Outbound.handleSubmitSuccess(event)
      : SP.Inbound.handleSubmitSuccess(event);
  });

  // ──────────────────────────────────────────────
  //  6. 刪除記錄歸還庫存（手機版通常不支援列表刪除，detail 刪除仍需處理）
  //
  //  🔧 [2026-07 修正] 原本進貨模式刪除記錄時完全沒有扣回庫存，
  //  現在比照出貨/調撥模式一併處理。
  // ──────────────────────────────────────────────
  kintone.events.on([
    'app.record.detail.delete.submit', 'app.record.index.delete.submit',
    'mobile.app.record.detail.delete.submit',
  ], function (event) {
    if (!SP.OPT_INVENTORY_SYNC) return event;
    if (SP.OPT_APP_MODE === 'transfer') return SP.Transfer.handleDelete(event);
    return SP.OPT_IS_SHIPMENT
      ? SP.Outbound.handleDelete(event)
      : SP.Inbound.handleDelete(event);
  });

})();
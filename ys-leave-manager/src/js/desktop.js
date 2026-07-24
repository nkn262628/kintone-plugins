(function (PLUGIN_ID) {
  'use strict';

  const config = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
  const leaveTypes = config.leaveTypes ? JSON.parse(config.leaveTypes) : [];

  // 欄位代碼請依實際「請假申請」App 的欄位設定調整
  const FIELDS = {
    leaveType: 'leave_type_code',   // 假別代碼（單選或下拉，值需對應 config 的 code）
    startDatetime: 'start_datetime',
    endDatetime: 'end_datetime',
    totalHours: 'total_hours',
    previewText: 'preview_text',    // 建議加一個「唯讀文字欄位」顯示即時預覽說明
  };

  // ---- 假日快取（呼叫 GAS，GAS 內部再快取政府開放資料，前端這層只做短期 cache 避免重複打） ----
  let holidayCache = null;
  async function getHolidaySet(year) {
    if (holidayCache && holidayCache.year === year) return holidayCache.set;
    const res = await fetch(config.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'getHolidays', year, secret: config.clientSecret }),
    });
    const data = await res.json();
    // 預期格式：{ holidays: ['2026-01-01', ...], makeupWorkdays: ['2026-02-08', ...] }
    const set = { holidays: new Set(data.holidays), makeupWorkdays: new Set(data.makeupWorkdays) };
    holidayCache = { year, set };
    return set;
  }

  function isWorkday(dateStr, dayOfWeek, holidaySet) {
    if (holidaySet.holidays.has(dateStr)) return false;
    if (dayOfWeek === 0 || dayOfWeek === 6) return holidaySet.makeupWorkdays.has(dateStr);
    return true;
  }

  function toMinutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  // 排除假日、扣午休，算出實際請假時數
  async function calcLeaveHours(startDt, endDt) {
    const workStart = timeToMinutes(config.workStart || '09:00');
    const workEnd = timeToMinutes(config.workEnd || '18:00');
    const lunchStart = timeToMinutes(config.lunchStart || '12:00');
    const lunchEnd = timeToMinutes(config.lunchEnd || '13:00');
    const dailyWorkMinutes = (workEnd - workStart) - (lunchEnd - lunchStart);

    let totalMinutes = 0;
    const cursor = new Date(startDt);
    cursor.setHours(0, 0, 0, 0);
    const endDay = new Date(endDt);
    endDay.setHours(0, 0, 0, 0);

    while (cursor <= endDay) {
      const dateStr = formatDate(cursor);
      const holidaySet = await getHolidaySet(cursor.getFullYear());

      if (isWorkday(dateStr, cursor.getDay(), holidaySet)) {
        const isFirstDay = sameDay(cursor, startDt);
        const isLastDay = sameDay(cursor, endDt);

        let dayStartMin = workStart;
        let dayEndMin = workEnd;
        if (isFirstDay) dayStartMin = Math.max(workStart, toMinutesOfDay(startDt));
        if (isLastDay) dayEndMin = Math.min(workEnd, toMinutesOfDay(endDt));

        // 扣除與午休的重疊
        const overlapStart = Math.max(dayStartMin, lunchStart);
        const overlapEnd = Math.min(dayEndMin, lunchEnd);
        const lunchOverlap = Math.max(0, overlapEnd - overlapStart);

        const dayMinutes = Math.max(0, dayEndMin - dayStartMin - lunchOverlap);
        totalMinutes += dayMinutes;
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return totalMinutes / 60; // 小時
  }

  function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  function formatDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // ---- 剩餘額度預覽：查「假別額度」App 目前的剩餘時數（唯讀，最終以核准後 GAS 校正為準）----
  async function fetchRemainingBalance(employeeId, leaveTypeCode) {
    const resp = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
      app: config.appBalance,
      query: `員工編號 = "${employeeId}" and 假別代碼 = "${leaveTypeCode}" order by 週期識別 desc limit 1`,
    });
    if (!resp.records.length) return null;
    return Number(resp.records[0]['剩餘時數'].value);
  }

  async function refreshPreview(record) {
    const leaveCode = record[FIELDS.leaveType]?.value;
    const startVal = record[FIELDS.startDatetime]?.value;
    const endVal = record[FIELDS.endDatetime]?.value;
    if (!leaveCode || !startVal || !endVal) return record;

    const leaveTypeDef = leaveTypes.find(t => t.code === leaveCode);
    const hours = await calcLeaveHours(new Date(startVal), new Date(endVal));
    const displayValue = leaveTypeDef?.unit === 'day' ? (hours / 8).toFixed(1) + ' 天' : hours.toFixed(1) + ' 小時';

    record[FIELDS.totalHours].value = leaveTypeDef?.unit === 'day' ? (hours / 8).toFixed(1) : hours.toFixed(1);

    // 剩餘額度僅預覽用途，不代表最終核准結果
    let previewMsg = `本次請假：${displayValue}（排除假日/週末，已扣除午休）`;
    try {
      const employeeId = kintone.getLoginUser().code; // 依實際員工編號對應欄位調整
      const remaining = await fetchRemainingBalance(employeeId, leaveCode);
      if (remaining !== null) previewMsg += `｜目前剩餘：${remaining} ${leaveTypeDef.unit === 'day' ? '天' : '小時'}（送出後以核准結果為準）`;
    } catch (e) {
      console.warn('剩餘額度查詢失敗，僅顯示本次請假時數', e);
    }

    if (record[FIELDS.previewText]) record[FIELDS.previewText].value = previewMsg;
    const previewEl = kintone.app.record.getFieldElement(FIELDS.previewText);
    if (previewEl) previewEl.classList.add('leave-preview-message');
    return record;
  }

  const EVENTS = [
    'app.record.create.show', 'app.record.edit.show',
    'app.record.create.change.' + FIELDS.startDatetime,
    'app.record.create.change.' + FIELDS.endDatetime,
    'app.record.create.change.' + FIELDS.leaveType,
    'app.record.edit.change.' + FIELDS.startDatetime,
    'app.record.edit.change.' + FIELDS.endDatetime,
    'app.record.edit.change.' + FIELDS.leaveType,
  ];

  kintone.events.on(EVENTS, async (event) => {
    event.record = await refreshPreview(event.record);
    return event;
  });

})(kintone.$PLUGIN_ID);

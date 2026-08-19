(function (PLUGIN_ID) {
    'use strict';

    var savedConfig = kintone.plugin.app.getConfig(PLUGIN_ID);
    if (!savedConfig || !savedConfig.config) return;

    var config;
    try {
        config = JSON.parse(savedConfig.config);
    } catch (e) {
        console.error('table-auto-fill-plugin: invalid config JSON', e);
        return;
    }
    if ((!config.tables || !config.tables.length) && (!config.headerLookups || !config.headerLookups.length)) return;

    // ==========================================
    // 0. 跨App共用工具
    // ==========================================

    // kintone 查詢語法中，字串裡的反斜線與雙引號需要跳脫，避免比對值剛好含有這些字元時查詢語法出錯或被利用
    function tafEscapeQueryValue(v) {
        return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    // 去目標App查詢「matchField = matchValue」的記錄(最多50筆，避免單次查詢過大)
    // 呼叫者需注意：這裡用的是操作者本人的權限，若操作者對目標App沒有檢視權限，這支API會失敗(403)
    function tafQueryTargetApp(targetAppId, matchField, matchValue) {
        var query = matchField + ' = "' + tafEscapeQueryValue(matchValue) + '" limit 50';
        return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: targetAppId, query: query })
            .then(function (resp) { return resp.records; });
    }

    // 右上角小提示，用來取代 alert()，不會擋住畫面操作
    function tafShowToast(message) {
        var el = document.createElement('div');
        el.textContent = message;
        el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;background:#45496a;color:#fff;' +
            'padding:10px 16px;border-radius:8px;font-size:13px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,.2);' +
            'max-width:320px;font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","PingFang TC","Microsoft JhengHei",sans-serif;';
        document.body.appendChild(el);
        setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 4500);
    }

    // 查到多筆符合資料時，跳出一個簡易選擇視窗讓使用者自己挑一筆
    // columns: [{code, label}]，用來把每筆記錄的關鍵欄位列出來，讓使用者知道每個選項的差異
    // 回傳 Promise<record|null>，選了「取消」則回傳 null
    function tafShowPickerModal(records, columns) {
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99998;' +
                'display:flex;align-items:center;justify-content:center;' +
                'font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","PingFang TC","Microsoft JhengHei",sans-serif;';

            var box = document.createElement('div');
            box.style.cssText = 'background:#fff;border-radius:10px;padding:20px;max-width:560px;width:90%;' +
                'max-height:70vh;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.25);';

            var title = document.createElement('div');
            title.textContent = '查到多筆符合的資料，請選擇一筆：';
            title.style.cssText = 'font-weight:700;margin-bottom:14px;color:#45496a;font-size:14px;';
            box.appendChild(title);

            records.forEach(function (rec) {
                var item = document.createElement('button');
                item.type = 'button';
                var parts = columns.map(function (c) {
                    var cell = rec[c.code];
                    var v = cell ? (Array.isArray(cell.value) ? cell.value.join('、') : cell.value) : '';
                    return c.label + '：' + (v === '' || v === null || v === undefined ? '（空白）' : v);
                });
                item.textContent = parts.join('　|　');
                item.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:8px;' +
                    'border:1px solid #dbdfec;border-radius:6px;background:#f6f7fb;cursor:pointer;font-size:13px;color:#45496a;';
                item.addEventListener('mouseenter', function () { item.style.background = '#eef0f6'; });
                item.addEventListener('mouseleave', function () { item.style.background = '#f6f7fb'; });
                item.addEventListener('click', function () {
                    document.body.removeChild(overlay);
                    resolve(rec);
                });
                box.appendChild(item);
            });

            var cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = 'margin-top:4px;padding:7px 16px;border-radius:6px;border:1px solid #dbdfec;' +
                'background:#fff;cursor:pointer;font-size:13px;color:#45496a;';
            cancelBtn.addEventListener('click', function () {
                document.body.removeChild(overlay);
                resolve(null);
            });
            box.appendChild(cancelBtn);

            overlay.appendChild(box);
            document.body.appendChild(overlay);
        });
    }

    // ==========================================
    // 0-1. 跨App查找：自動填入表頭欄位 (headerLookups)
    // ==========================================
    (config.headerLookups || []).forEach(function (lookup) {
        if (!lookup.targetAppId || !lookup.matchTargetField || !lookup.matchSourceField
            || !lookup.fieldMappings || !lookup.fieldMappings.length) return;

        function applyLookupResult(record, sourceRecord) {
            lookup.fieldMappings.forEach(function (fm) {
                var targetCell = record[fm.targetField];
                var sourceCell = sourceRecord[fm.sourceField];
                if (targetCell && sourceCell) {
                    targetCell.value = sourceCell.value;
                }
            });
        }

        function clearMappedFields(record) {
            lookup.fieldMappings.forEach(function (fm) {
                var cell = record[fm.targetField];
                if (cell) cell.value = Array.isArray(cell.value) ? [] : '';
            });
        }

        function runLookup(record) {
            var matchCell = record[lookup.matchSourceField];
            var matchValue = matchCell ? matchCell.value : '';
            if (matchValue === '' || matchValue === null || matchValue === undefined) {
                return Promise.resolve();
            }

            return tafQueryTargetApp(lookup.targetAppId, lookup.matchTargetField, matchValue)
                .then(function (records) {
                    if (!records.length) {
                        tafShowToast('查無符合「' + matchValue + '」的資料，已清空相關欄位。');
                        clearMappedFields(record);
                        return;
                    }
                    if (records.length === 1) {
                        applyLookupResult(record, records[0]);
                        return;
                    }
                    var columns = lookup.fieldMappings.map(function (fm) {
                        return { code: fm.sourceField, label: fm.sourceField };
                    });
                    return tafShowPickerModal(records, columns).then(function (picked) {
                        if (picked) applyLookupResult(record, picked);
                    });
                })
                .catch(function (err) {
                    console.error('table-auto-fill-plugin: cross-app lookup failed', err);
                    tafShowToast('跨App查詢失敗，請確認您對目標App是否有檢視權限，或稍後再試一次。');
                });
        }

        // 使用者變更「比對值來源」欄位時即時查詢並帶入 —— 用 Promise 回傳事件本身,
        // 讓kintone等查詢完成後才畫面渲染,避免資料還沒到就先顯示舊值。
        kintone.events.on([
            'app.record.create.change.' + lookup.matchSourceField,
            'app.record.edit.change.' + lookup.matchSourceField
        ], function (event) {
            return runLookup(event.record).then(function () { return event; });
        });
    });

    // ==========================================
    // 0-2. 跨App展開列：按鈕觸發，把查到的多筆記錄展開成子表格的多列
    // ==========================================
    (config.tables || []).forEach(function (outerTableConfig) {
        (outerTableConfig.crossAppExpands || []).forEach(function (expandCfg, expandIdx) {
            if (!expandCfg.targetAppId || !expandCfg.matchTargetField || !expandCfg.matchSourceField
                || !expandCfg.fieldMappings || !expandCfg.fieldMappings.length) return;

            var tableCode = outerTableConfig.tableCode;
            var markerAttr = 'data-taf-expand-inserted-' + expandIdx;

            function handleExpandClick() {
                var record = kintone.app.record.get().record;
                var matchCell = record[expandCfg.matchSourceField];
                var matchValue = matchCell ? matchCell.value : '';
                if (matchValue === '' || matchValue === null || matchValue === undefined) {
                    tafShowToast('請先填寫「比對值來源」欄位的值,再點擊此按鈕。');
                    return;
                }

                tafQueryTargetApp(expandCfg.targetAppId, expandCfg.matchTargetField, matchValue)
                    .then(function (records) {
                        if (!records.length) {
                            tafShowToast('查無符合「' + matchValue + '」的資料。');
                            return;
                        }

                        var table = record[tableCode];
                        if (!table || !table.value.length) {
                            tafShowToast('找不到子表格,請確認掛件設定是否正確。');
                            return;
                        }

                        // 用現有列(通常是空白列)當作樣板，複製出型態正確的空列，再把值填進去
                        var templateRow = table.value[table.value.length - 1];
                        var newRows = records.map(function (srcRecord) {
                            var row = JSON.parse(JSON.stringify(templateRow));
                            row.id = null;
                            Object.keys(row.value).forEach(function (fieldCode) {
                                var cell = row.value[fieldCode];
                                if (cell.type === 'CHECK_BOX') {
                                    cell.value = [];
                                } else if (cell.type !== 'RADIO_BUTTON') {
                                    cell.value = '';
                                }
                            });
                            expandCfg.fieldMappings.forEach(function (fm) {
                                var targetCell = row.value[fm.targetField];
                                var sourceCell = srcRecord[fm.sourceField];
                                if (targetCell && sourceCell) targetCell.value = sourceCell.value;
                            });
                            return row;
                        });

                        // 如果子表格目前只有一列，且使用者還沒填過任何東西，直接取代掉那個空白列；
                        // 否則(使用者已經手動填了東西，或已經有多列)，用附加的方式，不覆蓋既有資料。
                        var firstRow = table.value[0];
                        var isSingleEmptyRow = table.value.length === 1 && Object.keys(firstRow.value).every(function (fc) {
                            var v = firstRow.value[fc].value;
                            return v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);
                        });

                        table.value = isSingleEmptyRow ? newRows : table.value.concat(newRows);

                        kintone.app.record.set({ record: record });
                        tafShowToast('已帶入 ' + newRows.length + ' 筆資料。');
                    })
                    .catch(function (err) {
                        console.error('table-auto-fill-plugin: cross-app expand failed', err);
                        tafShowToast('跨App查詢失敗，請確認您對目標App是否有檢視權限，或稍後再試一次。');
                    });
            }

            function insertButtonIfNeeded() {
                var space;
                try {
                    space = kintone.app.record.getFieldElement(tableCode);
                } catch (e) {
                    return;
                }
                if (!space || space.getAttribute(markerAttr)) return;
                space.setAttribute(markerAttr, '1');

                var btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = expandCfg.buttonLabel || '帶入明細';
                btn.style.cssText = 'margin-bottom:8px;padding:6px 14px;border-radius:6px;border:1px solid #7d8bae;' +
                    'background:#fff;color:#45496a;font-size:13px;cursor:pointer;' +
                    'font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","PingFang TC","Microsoft JhengHei",sans-serif;';
                btn.addEventListener('mouseenter', function () { btn.style.background = '#eef0f6'; });
                btn.addEventListener('mouseleave', function () { btn.style.background = '#fff'; });
                btn.addEventListener('click', handleExpandClick);

                if (space.parentNode) {
                    space.parentNode.insertBefore(btn, space);
                }
            }

            kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {
                insertButtonIfNeeded();
                return event;
            });
        });
    });

    if (!config.tables || !config.tables.length) return;

    config.tables.forEach(function (tableConfig) {
        var tableCode = tableConfig.tableCode;
        var mappings = tableConfig.mappings || [];
        var rowPresets = tableConfig.rowPresets || [];
        if (!tableCode || (!mappings.length && !rowPresets.length)) return;

        // 用於追蹤當前子表格的列數，以判斷觸發 change 事件時是「新增列」還是「修改內容」
        var currentTableLength = 0;

        function isNewRow(row) {
            return row.id === null || row.id === undefined;
        }

        function ensureRowCount(table, targetCount) {
            if (!table.value.length) return;
            var templateRow = table.value[table.value.length - 1];

            while (table.value.length < targetCount) {
                var newRow = JSON.parse(JSON.stringify(templateRow));
                newRow.id = null;

                Object.keys(newRow.value).forEach(function (fieldCode) {
                    var cell = newRow.value[fieldCode];
                    if (cell.type === 'CHECK_BOX') {
                        cell.value = [];
                    } else if (cell.type !== 'RADIO_BUTTON') {
                        // Radio buttons can't be empty in kintone — leave the
                        // template's existing selection as-is; applyMappingsToRow's
                        // new-row radio override will set it to the intended value.
                        cell.value = '';
                    }
                });

                table.value.push(newRow);
            }
        }

        // 獨立出「對單一列寫入資料」的邏輯
        function applyMappingsToRow(row, rowIndex, record) {
            var rowIsNew = isNewRow(row);
            var appliedByPreset = {};
            var preset = rowPresets[rowIndex];
            if (preset && preset.fields) {
                Object.keys(preset.fields).forEach(function (fieldCode) {
                    var targetCell = row.value[fieldCode];
                    if (!targetCell) return;

                    var currentValue = targetCell.value;
                    var isEmpty = currentValue === '' || currentValue === null || currentValue === undefined
                        || (Array.isArray(currentValue) && currentValue.length === 0);
                    var isRadioButton = (targetCell.type === 'RADIO_BUTTON') && rowIsNew;

                    if (!isEmpty && !isRadioButton) return;

                    var presetValue = preset.fields[fieldCode];
                    if (presetValue !== undefined && currentValue !== presetValue) {
                        targetCell.value = presetValue;
                    }
                    appliedByPreset[fieldCode] = true;
                });
            }

            mappings.forEach(function (mapping) {
                if (appliedByPreset[mapping.targetField]) return;
                var targetCell = row.value[mapping.targetField];
                if (!targetCell) return;

                var currentValue = targetCell.value;
                var isEmpty = currentValue === '' || currentValue === null || currentValue === undefined
                    || (Array.isArray(currentValue) && currentValue.length === 0);


                // 單選框永遠不會是空的，但只有「還沒存過的新列」才允許跳過空值檢查強制帶入，
                // 已存在的舊列即使欄位型態是單選框，也要尊重使用者原本的選擇
                var isRadioButton = (targetCell.type === 'RADIO_BUTTON') && rowIsNew;


                // 若設定「僅在空白時帶入」，且該欄位非空（且不是單選框），則跳過
                if (mapping.onlyIfEmpty !== false && !isEmpty && !isRadioButton) {
                    return;
                }

                var newValue = null;
                if (mapping.sourceType === 'static') {
                    newValue = mapping.sourceValue;
                } else {
                    var headerCell = record[mapping.sourceValue];
                    if (headerCell) {
                        newValue = headerCell.value;
                    }
                }

                // 若有值需要填入，且與當前值不同，才進行覆寫 (減少不必要的 DOM 重新渲染)
                if (newValue !== null && currentValue !== newValue) {
                    targetCell.value = newValue;
                }
            });
        }

        // ==========================================
        // 1. 畫面初始載入 (Show Events)
        // ==========================================
        // kintone.events.on([
        //     'app.record.create.show',
        //     'app.record.edit.show'
        // ], function (event) {
        //     var table = event.record[tableCode];
        //     if (!table || !table.value) return event;

        //     // 記錄初始的表格列數
        //     currentTableLength = table.value.length;

        //     // 針對每一列套用規則 (通常這時候只會有預設的第 1 列空白列，或編輯模式下的舊資料)
        //     table.value.forEach(function (row, rowIndex) {
        //         applyMappingsToRow(row, rowIndex, event.record);
        //     });

        //     return event;
        // });

        // 新增記錄：先把行數補到跟列預設值一樣多，再套用規則/預設值
        kintone.events.on('app.record.create.show', function (event) {
            var table = event.record[tableCode];
            if (!table || !table.value) return event;

            if (rowPresets.length > table.value.length) {
                ensureRowCount(table, rowPresets.length);
            }

            currentTableLength = table.value.length;

            table.value.forEach(function (row, rowIndex) {
                applyMappingsToRow(row, rowIndex, event.record);
            });

            return event;
        });

        // 編輯已存在的記錄：只套用規則/預設值，絕不自動補行數
        kintone.events.on('app.record.edit.show', function (event) {
            var table = event.record[tableCode];
            if (!table || !table.value) return event;

            currentTableLength = table.value.length;

            table.value.forEach(function (row, rowIndex) {
                applyMappingsToRow(row, rowIndex, event.record);
            });

            return event;
        });

        // ==========================================
        // 2. 子表格內容變更 / 新增列 (Subtable Change Events)
        // ==========================================
        kintone.events.on([
            'app.record.create.change.' + tableCode,
            'app.record.edit.change.' + tableCode
        ], function (event) {
            var table = event.record[tableCode];
            if (!table || !table.value) return event;

            var newLength = table.value.length;
            var isAddRow = newLength > currentTableLength; // 判斷是否為「新增列」動作

            // 更新計數器
            currentTableLength = newLength;

            // 如果是新增列，且 event.changes.row 存在（kintone 原生會帶入被變更/新增的列物件）
            if (isAddRow && event.changes && event.changes.row) {
                // ！！！最核心的優化！！！
                // 這裡「只」針對剛剛被新增的那一列執行填入，
                // 這樣就不會因為 RADIO_BUTTON 豁免檢查而誤覆蓋掉使用者在舊列手動修改過的選項！
                var rowIndex = table.value.indexOf(event.changes.row);
                applyMappingsToRow(event.changes.row, rowIndex, event.record);
            }

            return event;
        });

        // ==========================================
        // 3. 來源主表單欄位變更 (Header Field Change Events)
        // ==========================================
        var headerSourceCodes = mappings
            .filter(function (m) { return m.sourceType === 'header'; })
            .map(function (m) { return m.sourceValue; });

        if (headerSourceCodes.length) {
            var headerChangeEvents = [];
            headerSourceCodes.forEach(function (code) {
                headerChangeEvents.push('app.record.create.change.' + code);
                headerChangeEvents.push('app.record.edit.change.' + code);
            });

            kintone.events.on(headerChangeEvents, function (event) {
                var table = event.record[tableCode];
                if (!table || !table.value) return event;

                // 若使用者修改了主表單的來源欄位，我們預期要將新值同步到所有符合條件（如空白）的子表格列中
                table.value.forEach(function (row, rowIndex) {
                    applyMappingsToRow(row, rowIndex, event.record);
                });

                return event;
            });
        }

    });
})(kintone.$PLUGIN_ID);
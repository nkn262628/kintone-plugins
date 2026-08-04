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
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

    // 頁面中央的提示，仿 kintone 原生通知樣式，用來取代 alert() 與原本不明顯的右上角小提示
    // type: 'success' | 'error' | 'info'（預設）
    var tafToastContainer = null;

    function tafEnsureToastStyle() {
        if (document.getElementById('taf-toast-style')) return;
        var style = document.createElement('style');
        style.id = 'taf-toast-style';
        style.textContent =
            '@keyframes tafToastIn{from{opacity:0;transform:scale(.94) translateY(-8px);}to{opacity:1;transform:scale(1) translateY(0);}}' +
            '@keyframes tafToastOut{from{opacity:1;transform:scale(1) translateY(0);}to{opacity:0;transform:scale(.94) translateY(-8px);}}' +
            '@keyframes tafCheckCircle{to{stroke-dashoffset:0;}}' +
            '@keyframes tafCheckMark{to{stroke-dashoffset:0;}}' +
            '@keyframes tafCheckPop{0%{transform:scale(0);}70%{transform:scale(1.08);}100%{transform:scale(1);}}' +
            '@keyframes tafSpin{to{transform:rotate(360deg);}}';
        document.head.appendChild(style);
    }

    // 讓按鈕進入「處理中」狀態：鎖住不能重複點擊、換成 loading 文字與轉圈圈的圖示，
    // 回傳一個 restore() 函式，處理完成(成功或失敗)後呼叫即可還原成原本的樣子
    function tafSetButtonLoading(btnEl, loadingText) {
        tafEnsureToastStyle();
        var labelEl = btnEl.querySelector('.taf-btn-label');
        var iconEl = btnEl.querySelector('.taf-btn-icon');
        var originalLabel = labelEl ? labelEl.textContent : btnEl.textContent;
        var originalOpacity = btnEl.style.opacity;
        var originalCursor = btnEl.style.cursor;

        btnEl.disabled = true;
        btnEl.style.opacity = '.6';
        btnEl.style.cursor = 'not-allowed';
        if (labelEl) labelEl.textContent = loadingText;
        if (iconEl) iconEl.style.animation = 'tafSpin .8s linear infinite';

        var restored = false;
        return function restore() {
            if (restored) return;
            restored = true;
            btnEl.disabled = false;
            btnEl.style.opacity = originalOpacity;
            btnEl.style.cursor = originalCursor;
            if (labelEl) labelEl.textContent = originalLabel;
            if (iconEl) iconEl.style.animation = 'none';
        };
    }

    function tafGetToastContainer() {
        if (tafToastContainer && document.body.contains(tafToastContainer)) return tafToastContainer;
        tafToastContainer = document.createElement('div');
        tafToastContainer.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
            'z-index:99999;display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none;';
        document.body.appendChild(tafToastContainer);
        return tafToastContainer;
    }

    function tafShowToast(message, type) {
        tafEnsureToastStyle();
        var palette = {
            error: '#e2574c',
            success: '#2e7d32',
            info: '#3498db'
        };
        var accent = palette[type] || palette.info;
        var container = tafGetToastContainer();

        var el = document.createElement('div');
        el.style.cssText = 'pointer-events:auto;background:#fff;border-radius:8px;' +
            'padding:32px 36px 24px;box-shadow:0 12px 40px rgba(0,0,0,.22);min-width:380px;max-width:480px;' +
            'display:flex;flex-direction:column;align-items:center;text-align:center;' +
            'animation:tafToastIn .18s ease-out;' +
            'font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","PingFang TC","Microsoft JhengHei",sans-serif;';

        if (type === 'success') {
            var iconWrap = document.createElement('div');
            iconWrap.style.cssText = 'margin-bottom:14px;animation:tafCheckPop .3s ease-out;';
            iconWrap.innerHTML =
                '<svg width="64" height="64" viewBox="0 0 72 72">' +
                '<circle cx="36" cy="36" r="32" fill="none" stroke="' + accent + '" stroke-width="4" ' +
                'stroke-dasharray="201" stroke-dashoffset="201" style="animation:tafCheckCircle .45s ease-out forwards;"/>' +
                '<path d="M21 37 L31 47 L51 25" fill="none" stroke="' + accent + '" stroke-width="4" ' +
                'stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="44" stroke-dashoffset="44" ' +
                'style="animation:tafCheckMark .3s ease-out .4s forwards;"/>' +
                '</svg>';
            el.appendChild(iconWrap);
        }

        var text = document.createElement('div');
        text.textContent = message;
        text.style.cssText = 'white-space:pre-line;margin-bottom:22px;font-size:16px;line-height:1.7;color:#333333;';
        el.appendChild(text);

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:center;';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '確認';
        btn.style.cssText = 'padding:9px 40px;border-radius:3px;border:1px solid ' + accent + ';' +
            'background:' + accent + ';color:#fff;font-size:14px;font-weight:600;cursor:pointer;' +
            'font-family:inherit;transition:opacity .12s;';
        btn.addEventListener('mouseenter', function () { btn.style.opacity = '.88'; });
        btn.addEventListener('mouseleave', function () { btn.style.opacity = '1'; });
        btnRow.appendChild(btn);
        el.appendChild(btnRow);

        container.appendChild(el);

        var removed = false;
        function removeToast() {
            if (removed) return;
            removed = true;
            el.style.animation = 'tafToastOut .18s ease-in forwards';
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
                if (container.childNodes.length === 0 && container.parentNode) {
                    container.parentNode.removeChild(container);
                    tafToastContainer = null;
                }
            }, 180);
        }

        btn.addEventListener('click', removeToast);
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
            box.style.cssText = 'background:#fff;border-radius:4px;padding:20px;max-width:560px;width:90%;' +
                'max-height:70vh;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.25);';

            var title = document.createElement('div');
            title.textContent = '查到多筆符合的資料，請選擇一筆：';
            title.style.cssText = 'font-weight:700;margin-bottom:14px;color:#333333;font-size:14px;';
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
                    'border:1px solid #e3e7e8;border-radius:3px;background:#f7f8fa;cursor:pointer;font-size:13px;color:#333333;';
                item.addEventListener('mouseenter', function () { item.style.background = '#eaf4fc'; });
                item.addEventListener('mouseleave', function () { item.style.background = '#f7f8fa'; });
                item.addEventListener('click', function () {
                    document.body.removeChild(overlay);
                    resolve(rec);
                });
                box.appendChild(item);
            });

            var cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = 'margin-top:4px;padding:7px 16px;border-radius:3px;border:1px solid #e3e7e8;' +
                'background:#fff;cursor:pointer;font-size:13px;color:#333333;';
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
    // 0-2. 跨App展開列：按鈕觸發，把查到的多筆記錄展開成子表格的多列
    // ==========================================
    // getFieldElement() 官方不支援 SUBTABLE 及其內部欄位（無法判斷要對應哪一列），
    // 所以改用「這個子表格是頁面上第幾個 .subtable-gaia」來定位，
    // 順序抓自表單欄位定義順序（跟畫面呈現順序一致）。
    function initCrossAppExpand() {
        kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: kintone.app.getId() })
            .then(function (resp) {
                var subtableOrder = [];
                Object.keys(resp.properties).forEach(function (code) {
                    if (resp.properties[code].type === 'SUBTABLE') subtableOrder.push(code);
                });
                var domIndexOf = {};
                subtableOrder.forEach(function (code, i) { domIndexOf[code] = i; });

                (config.tables || []).forEach(function (outerTableConfig) {
                    (outerTableConfig.crossAppExpands || []).forEach(function (expandCfg, expandIdx) {
                        if (!expandCfg.targetAppId || !expandCfg.matchTargetField || !expandCfg.matchSourceField
                            || !expandCfg.fieldMappings || !expandCfg.fieldMappings.length) return;

                        var tableCode = outerTableConfig.tableCode;
                        var markerAttr = 'data-taf-expand-inserted-' + expandIdx;
                        var lastExpandedRowSignatures = []; // 追蹤「上次這個按鈕帶入的那幾列」的內容特徵，下次點擊時用來精準清除

                        // 用「這個 expand 設定會填入的欄位」組出一列的特徵字串，
                        // 只要是這個按鈕帶入的列，換比對值時就能被辨識出來並清除，不會誤刪使用者手動輸入的其他列
                        function rowSignature(row) {
                            return expandCfg.fieldMappings.map(function (fm) {
                                var cell = row.value[fm.targetField];
                                var v = cell ? cell.value : '';
                                return Array.isArray(v) ? v.join('\u0001') : String(v);
                            }).join('\u0002');
                        }

                        function isEmptyRow(row) {
                            return Object.keys(row.value).every(function (fc) {
                                if (row.value[fc].type === 'CALC') return true; // 計算欄位一定有算出來的值,不代表使用者填過,判斷空白列時要略過
                                var v = row.value[fc].value;
                                return v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);
                            });
                        }

                        function handleExpandClick(btnEl) {
                            var record = kintone.app.record.get().record;
                            var matchCell = record[expandCfg.matchSourceField];
                            var matchValue = matchCell ? matchCell.value : '';
                            if (matchValue === '' || matchValue === null || matchValue === undefined) {
                                tafShowToast('請先填寫「比對值來源」欄位的值,再點擊此按鈕。', 'error');
                                return;
                            }

                            var restoreBtn = btnEl ? tafSetButtonLoading(btnEl, '查詢中...') : function () {};

                            tafQueryTargetApp(expandCfg.targetAppId, expandCfg.matchTargetField, matchValue)
                                .then(function (records) {
                                    if (!records.length) {
                                        restoreBtn();
                                        tafShowToast('查無符合「' + matchValue + '」的資料。', 'error');
                                        return;
                                    }

                                    var table = record[tableCode];
                                    if (!table || !table.value.length) {
                                        restoreBtn();
                                        tafShowToast('找不到子表格,請確認掛件設定是否正確。', 'error');
                                        return;
                                    }

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

                                    // 不管是連續點同一廠商、還是換了廠商，只要這個按鈕之前帶入過資料，
                                    // 這次就先把上次這個按鈕帶入的那幾列清掉，避免新舊資料疊在一起；
                                    // 使用者手動輸入或其他來源的列則不受影響
                                    var baseRows = table.value;
                                    var removedCount = 0;
                                    if (lastExpandedRowSignatures.length) {
                                        var remainingSignatures = lastExpandedRowSignatures.slice();
                                        baseRows = table.value.filter(function (row) {
                                            var idx = remainingSignatures.indexOf(rowSignature(row));
                                            if (idx === -1) return true;
                                            remainingSignatures.splice(idx, 1);
                                            removedCount++;
                                            return false;
                                        });
                                    }

                                    var isSingleEmptyRow = baseRows.length === 1 && isEmptyRow(baseRows[0]);
                                    table.value = (baseRows.length === 0 || isSingleEmptyRow) ? newRows : baseRows.concat(newRows);

                                    kintone.app.record.set({ record: record });
                                    lastExpandedRowSignatures = newRows.map(rowSignature);
                                    restoreBtn();

                                    tafShowToast(
                                        removedCount > 0
                                            ? '已重新帶入 ' + newRows.length + ' 筆資料。'
                                            : '已帶入 ' + newRows.length + ' 筆資料。',
                                        'success'
                                    );
                                })
                                .catch(function (err) {
                                    restoreBtn();
                                    console.error('table-auto-fill-plugin: cross-app expand failed', err);
                                    tafShowToast('跨App查詢失敗，請確認您對目標App是否有檢視權限，或稍後再試一次。', 'error');
                                });
                        }

                        function insertButtonIfNeeded() {
                            var idx = domIndexOf[tableCode];
                            if (idx === undefined) return;
                            var allSubtables = document.querySelectorAll('.subtable-gaia');
                            var space = allSubtables[idx];
                            if (!space || space.getAttribute(markerAttr)) return;
                            space.setAttribute(markerAttr, '1');

                            tafEnsureToastStyle();

                            var btn = document.createElement('button');
                            btn.type = 'button';
                            btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:10px 0 12px;' +
                                'padding:7px 18px;border-radius:4px;border:1px solid #3498db;background:#fff;color:#3498db;' +
                                'font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;' +
                                'transition:background .15s ease,box-shadow .15s ease,opacity .15s ease;';

                            var icon = document.createElement('span');
                            icon.className = 'taf-btn-icon';
                            icon.setAttribute('aria-hidden', 'true');
                            icon.style.cssText = 'display:inline-flex;flex-shrink:0;line-height:0;';
                            icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none">' +
                                '<path d="M8 2v7.5M8 9.5L4.8 6.3M8 9.5l3.2-3.2" stroke="currentColor" stroke-width="1.6" ' +
                                'stroke-linecap="round" stroke-linejoin="round"/>' +
                                '<path d="M3 12.5v.5a1.5 1.5 0 001.5 1.5h7a1.5 1.5 0 001.5-1.5v-.5" stroke="currentColor" ' +
                                'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

                            var label = document.createElement('span');
                            label.className = 'taf-btn-label';
                            label.textContent = expandCfg.buttonLabel || '帶入明細';

                            btn.appendChild(icon);
                            btn.appendChild(label);

                            btn.addEventListener('mouseenter', function () {
                                if (btn.disabled) return;
                                btn.style.background = '#eaf4fc';
                                btn.style.boxShadow = '0 2px 8px rgba(52,152,219,.2)';
                            });
                            btn.addEventListener('mouseleave', function () {
                                btn.style.background = '#fff';
                                btn.style.boxShadow = 'none';
                            });
                            btn.addEventListener('click', function () { handleExpandClick(btn); });

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
            })
            .catch(function (err) {
                console.error('table-auto-fill-plugin: failed to fetch fields for subtable DOM mapping', err);
            });
    }
    initCrossAppExpand();

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
(function (PLUGIN_ID) {
    'use strict';

    var appId = kintone.app.getId();
    var allFields = {};       // fieldCode -> field properties (header fields only)
    var subtableFields = {};  // subtableCode -> { fieldCode: props, ... }
    var headerFieldCodes = [];// fieldCodes that are NOT inside any subtable
    var tableGroupCounter = 0;
    var ruleCounter = 0;

    // Fields with the same "shape" are safe to copy between.
    // This is a business-rule judgment call, not a kintone restriction —
    // adjust freely if a client needs a different pairing (e.g. NUMBER -> SINGLE_LINE_TEXT).
    var TYPE_COMPATIBILITY = {
        SINGLE_LINE_TEXT: ['SINGLE_LINE_TEXT', 'LINK', 'RADIO_BUTTON', 'DROP_DOWN', 'NUMBER', 'LOOKUP'],
        MULTI_LINE_TEXT: ['SINGLE_LINE_TEXT', 'LINK'],
        LINK: ['SINGLE_LINE_TEXT', 'LINK'],
        NUMBER: ['NUMBER'],
        DATE: ['DATE'],
        TIME: ['TIME'],
        DATETIME: ['DATETIME'],
        DROP_DOWN: ['DROP_DOWN', 'RADIO_BUTTON', 'SINGLE_LINE_TEXT'],
        RADIO_BUTTON: ['RADIO_BUTTON', 'DROP_DOWN', 'SINGLE_LINE_TEXT'],
        CHECK_BOX: ['CHECK_BOX', 'MULTI_SELECT'],
        MULTI_SELECT: ['MULTI_SELECT', 'CHECK_BOX'],
        LOOKUP: ['LOOKUP', 'SINGLE_LINE_TEXT']
    };

    var MULTI_VALUE_TYPES = ['CHECK_BOX', 'MULTI_SELECT'];

    var STATIC_INPUT_TYPE = {
        NUMBER: 'number',
        DATE: 'date',
        TIME: 'time'
    };

    var STATIC_SELECT_TYPES = ['RADIO_BUTTON', 'DROP_DOWN'];

    // For RADIO_BUTTON / DROP_DOWN targets, kintone only accepts values that
    // already exist as one of the field's defined options — free text risks
    // setting a value the field will reject or silently fail to display.
    // Swap the static input for a <select> populated from the field's actual options.
    function refreshStaticInputType(targetSelect, staticInput, staticSelect, staticMultiselect, tableCode) {
        var selectedOption = targetSelect.options[targetSelect.selectedIndex];
        var targetType = selectedOption ? selectedOption.getAttribute('data-field-type') : null;

        if (MULTI_VALUE_TYPES.indexOf(targetType) !== -1) {
            var msField = (subtableFields[tableCode] || {})[targetSelect.value];
            var msOptions = (msField && msField.options) || {};
            var msLabels = Object.keys(msOptions).sort(function (a, b) {
                return Number(msOptions[a].index) - Number(msOptions[b].index);
            });

            var msPanel = staticMultiselect.querySelector('.taf-ms-panel');
            msPanel.innerHTML = '';
            msLabels.forEach(function (label) {
                var wrap = document.createElement('label');
                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = label;
                cb.addEventListener('change', function () {
                    updateMsTriggerLabel(staticMultiselect);
                });
                var text = document.createElement('span');
                text.textContent = label;
                wrap.appendChild(cb);
                wrap.appendChild(text);
                msPanel.appendChild(wrap);
            });
            updateMsTriggerLabel(staticMultiselect);

            staticInput.style.display = 'none';
            staticSelect.style.display = 'none';
            staticMultiselect.style.display = '';
            return;
        }
        staticMultiselect.style.display = 'none';

        if (STATIC_SELECT_TYPES.indexOf(targetType) !== -1) {
            var field = (subtableFields[tableCode] || {})[targetSelect.value];
            var options = (field && field.options) || {};
            var labels = Object.keys(options).sort(function (a, b) {
                return Number(options[a].index) - Number(options[b].index);
            });

            staticSelect.innerHTML = '';
            labels.forEach(function (label) {
                var opt = document.createElement('option');
                opt.value = label;
                opt.textContent = label;
                staticSelect.appendChild(opt);
            });

            staticInput.style.display = 'none';
            staticSelect.style.display = '';
            staticInput.type = 'text';
            staticInput.value = staticSelect.value || '';
            return;
        }

        staticSelect.style.display = 'none';
        staticInput.style.display = '';

        var inputType = STATIC_INPUT_TYPE[targetType] || 'text';
        staticInput.type = inputType;
        staticInput.placeholder = (targetType === 'DATETIME')
            ? '例如：2026-08-03T10:00:00Z'
            : (inputType === 'text' ? '例如：待處理' : '');
    }

    var rowPresetCounter = 0;
    var fieldValueCounter = 0;

    // ---- Cross-App state ----
    var currentAppSpaceId = null;      // 目前App所在的Space ID(沒有的話是null)
    var spaceApps = [];                // 同Space下的其他App清單 [{appId, name}]
    var spaceAppsFetched = false;
    var targetAppFieldsCache = {};     // targetAppId -> fields properties(避免重複打API)

    function renumberRowPresets(container) {
        container.querySelectorAll('.taf-row-preset-card').forEach(function (card, i) {
            card.querySelector('.taf-row-preset-label').textContent = '第 ' + (i + 1) + ' 列';
        });
    }

    function createRowPresetCard(rowPresetsContainer, tableCode, savedPreset) {
        var frag = els.rowPresetTemplate.content.cloneNode(true);
        var card = frag.querySelector('.taf-row-preset-card');
        var index = rowPresetCounter++;
        card.setAttribute('data-row-preset-index', index);

        var fvContainer = card.querySelector('.taf-field-value-container');
        var addFvBtn = card.querySelector('.taf-add-field-value-btn');
        var deleteBtn = card.querySelector('.taf-delete-row-preset-btn');

        var inlineAddRowPresetBtn = card.querySelector('.taf-inline-add-row-preset-btn');
        inlineAddRowPresetBtn.addEventListener('click', function () {
            createRowPresetCard(rowPresetsContainer, tableCode, null);
        });

        addFvBtn.addEventListener('click', function () {
            appendFieldValueRow(fvContainer, tableCode, null, null);
        });

        deleteBtn.addEventListener('click', function () {
            card.remove();
            renumberRowPresets(rowPresetsContainer);
        });

        rowPresetsContainer.appendChild(card);
        renumberRowPresets(rowPresetsContainer);

        if (savedPreset && savedPreset.fields) {
            Object.keys(savedPreset.fields).forEach(function (fieldCode) {
                appendFieldValueRow(fvContainer, tableCode, fieldCode, savedPreset.fields[fieldCode]);
            });
        }
    }

    function appendFieldValueRow(container, tableCode, savedFieldCode, savedValue) {
        var frag = els.fieldValueTemplate.content.cloneNode(true);
        var row = frag.querySelector('.taf-field-value-row');
        var index = fieldValueCounter++;
        row.setAttribute('data-field-value-index', index);

        var fieldSelect = row.querySelector('.taf-fv-field-select');
        var staticInput = row.querySelector('.taf-fv-static-input');
        var staticSelect = row.querySelector('.taf-fv-static-select');
        var staticMultiselect = row.querySelector('.taf-fv-static-multiselect');
        setupMultiselectDropdown(staticMultiselect);
        var deleteBtn = row.querySelector('.taf-delete-field-value-btn');

        var inlineAddFvBtn = row.querySelector('.taf-inline-add-field-value-btn');
        inlineAddFvBtn.addEventListener('click', function () {
            appendFieldValueRow(container, tableCode, null, null);
        });

        populateTargetFieldSelect(fieldSelect, tableCode);
        refreshStaticInputType(fieldSelect, staticInput, staticSelect, staticMultiselect, tableCode);

        fieldSelect.addEventListener('change', function () {
            staticInput.value = '';
            staticSelect.innerHTML = '';
            refreshStaticInputType(fieldSelect, staticInput, staticSelect, staticMultiselect, tableCode);
        });

        staticSelect.addEventListener('change', function () {
            staticInput.value = staticSelect.value;
        });

        deleteBtn.addEventListener('click', function () {
            row.remove();
        });

        container.appendChild(row);

        if (savedFieldCode) {
            fieldSelect.value = savedFieldCode;
            refreshStaticInputType(fieldSelect, staticInput, staticSelect, staticMultiselect, tableCode);
            if (Array.isArray(savedValue)) {
                setCheckedValues(staticMultiselect, savedValue);
                updateMsTriggerLabel(staticMultiselect);
            } else {
                staticInput.value = savedValue || '';
                if (staticSelect.style.display !== 'none') {
                    staticSelect.value = savedValue || '';
                }
            }
        }
    }

    var els = {
        tablesContainer: document.getElementById('taf-tables-container'),
        addTableBtn: document.getElementById('taf-add-table-btn'),
        saveBtn: document.getElementById('taf-save-btn'),
        saveMsg: document.getElementById('taf-save-msg'),
        tableGroupTemplate: document.getElementById('taf-table-group-template'),
        ruleTemplate: document.getElementById('taf-rule-template'),
        rowPresetTemplate: document.getElementById('taf-row-preset-template'),
        fieldValueTemplate: document.getElementById('taf-field-value-template'),
        crossAppCardTemplate: document.getElementById('taf-crossapp-card-template'),
        crossAppFieldMapTemplate: document.getElementById('taf-crossapp-fieldmap-template')
    };

    // ---- 1. Fetch app fields, then init UI ----
    kintone.api(kintone.api.url('/k/v1/preview/app/form/fields', true), 'GET', { app: appId })
        .then(function (resp) {
            var properties = resp.properties;
            var subtableCodes = [];

            Object.keys(properties).forEach(function (code) {
                var field = properties[code];
                if (field.type === 'SUBTABLE') {
                    subtableCodes.push(code);
                    subtableFields[code] = field.fields;
                }
            });

            Object.keys(properties).forEach(function (code) {
                var field = properties[code];
                if (field.type === 'SUBTABLE') return;
                if (TYPE_COMPATIBILITY.hasOwnProperty(field.type)) {
                    allFields[code] = field;
                    headerFieldCodes.push(code);
                }
            });

            window.__taf_subtableCodes = subtableCodes; // used by table-group creation

            // 欄位抓完後，接著抓同一個 Space 底下有哪些其他 App，供跨App查找/展開的下拉選單使用。
            // 這一步失敗不影響既有功能，所以失敗時只記 log，讓使用者用「手動輸入 App ID」繼續設定。
            fetchSpaceAppsIfNeeded(function () {
                loadExistingConfig(subtableCodes);
            });
        })
        .catch(function (err) {
            console.error('table-auto-fill-plugin: failed to fetch app fields', err);
            els.saveMsg.textContent = '欄位資訊取得失敗,請重新整理畫面。';
        });

    // ---- Cross-App: 抓目前App所在Space的其他App清單 ----
    function fetchSpaceAppsIfNeeded(callback) {
        if (spaceAppsFetched) { callback(); return; }
        kintone.api(kintone.api.url('/k/v1/app', true), 'GET', { id: appId })
            .then(function (resp) {
                currentAppSpaceId = resp.spaceId || null;
                if (!currentAppSpaceId) {
                    spaceAppsFetched = true;
                    callback();
                    return;
                }
                return kintone.api(kintone.api.url('/k/v1/apps', true), 'GET', { spaceIds: [currentAppSpaceId] })
                    .then(function (listResp) {
                        spaceApps = (listResp.apps || [])
                            .filter(function (a) { return String(a.appId) !== String(appId); })
                            .map(function (a) { return { appId: a.appId, name: a.name }; });
                        spaceAppsFetched = true;
                        callback();
                    });
            })
            .catch(function (err) {
                console.error('table-auto-fill-plugin: failed to list apps in space', err);
                spaceAppsFetched = true;
                callback();
            });
    }

    // 抓目標App的欄位清單(非preview版，因為操作者對目標App通常只有一般權限，不一定是App管理者)
    function fetchTargetAppFields(targetAppId, callback) {
        if (!targetAppId) { callback(null); return; }
        if (targetAppFieldsCache[targetAppId]) { callback(targetAppFieldsCache[targetAppId]); return; }
        kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: targetAppId })
            .then(function (resp) {
                targetAppFieldsCache[targetAppId] = resp.properties;
                callback(resp.properties);
            })
            .catch(function (err) {
                console.error('table-auto-fill-plugin: failed to fetch target app fields', err);
                callback(null);
            });
    }

    function populateAppSelect(selectEl) {
        selectEl.innerHTML = '<option value="">請選擇...</option>';
        spaceApps.forEach(function (a) {
            var opt = document.createElement('option');
            opt.value = a.appId;
            opt.textContent = a.name + '（ID:' + a.appId + '）';
            selectEl.appendChild(opt);
        });
    }

    // 泛用的「欄位下拉選單」填入，用於目標App欄位(來源) — 排除子表格/群組，因為這裡只處理單一值欄位
    function populateFieldSelect(selectEl, fields, savedValue) {
        if (!fields) return;
        var prevValue = savedValue || selectEl.value;
        selectEl.innerHTML = '';
        var EXCLUDED_TYPES = ['SUBTABLE', 'GROUP', 'RECORD_NUMBER', 'CREATOR', 'CREATED_TIME',
            'MODIFIER', 'UPDATED_TIME', 'STATUS', 'STATUS_ASSIGNEE', 'CATEGORY'];
        Object.keys(fields).forEach(function (code) {
            var f = fields[code];
            if (EXCLUDED_TYPES.indexOf(f.type) !== -1) return;
            var opt = document.createElement('option');
            opt.value = code;
            opt.textContent = f.label + '（' + code + '）';
            selectEl.appendChild(opt);
        });
        if (prevValue && optionExists(selectEl, prevValue)) selectEl.value = prevValue;
    }

    // 本App表頭欄位下拉選單，用於「比對值來源」
    function populateHeaderFieldSelect(selectEl, savedValue) {
        selectEl.innerHTML = '';
        headerFieldCodes.forEach(function (code) {
            var f = allFields[code];
            var opt = document.createElement('option');
            opt.value = code;
            opt.textContent = f.label + '（' + code + '）';
            selectEl.appendChild(opt);
        });
        if (savedValue && optionExists(selectEl, savedValue)) selectEl.value = savedValue;
    }

    // 建立一張跨App卡片。kind: 'header'(填表頭) 或 'expand'(展開子表格列)
    // tableCodeForExpand 只有 kind==='expand' 時才需要，決定「填入欄位」要列哪個子表格的欄位
    function createCrossAppCard(kind, container, tableCodeForExpand, savedCfg) {
        var frag = els.crossAppCardTemplate.content.cloneNode(true);
        var card = frag.querySelector('.taf-crossapp-card');

        var appSelect = card.querySelector('.taf-crossapp-app-select');
        var appManualInput = card.querySelector('.taf-crossapp-app-manual');
        var matchTargetSelect = card.querySelector('.taf-crossapp-match-target-select');
        var matchSourceSelect = card.querySelector('.taf-crossapp-match-source-select');
        var fmContainer = card.querySelector('.taf-crossapp-fieldmap-container');
        var addFmBtn = card.querySelector('.taf-crossapp-add-fieldmap-btn');
        var deleteBtn = card.querySelector('.taf-crossapp-delete-btn');
        var inlineAddBtn = card.querySelector('.taf-crossapp-inline-add-btn');
        var buttonLabelRow = card.querySelector('.taf-crossapp-buttonlabel-row');
        var buttonLabelInput = card.querySelector('.taf-crossapp-button-label');

        inlineAddBtn.addEventListener('click', function () {
            createCrossAppCard(kind, container, tableCodeForExpand, null);
        });

        if (kind === 'expand') {
            buttonLabelRow.style.display = '';
        }

        populateAppSelect(appSelect);
        populateHeaderFieldSelect(matchSourceSelect, savedCfg && savedCfg.matchSourceField);

        function currentTargetAppId() {
            return (appManualInput.value || '').trim() || appSelect.value || '';
        }

        function refreshFromTargetApp() {
            var tId = currentTargetAppId();
            if (!tId) return;
            fetchTargetAppFields(tId, function (fields) {
                if (!fields) return;
                populateFieldSelect(matchTargetSelect, fields, null);
                fmContainer.querySelectorAll('.taf-crossapp-fieldmap-row').forEach(function (row) {
                    var srcSel = row.querySelector('.taf-crossapp-fm-source-select');
                    populateFieldSelect(srcSel, fields, null);
                });
            });
        }

        appSelect.addEventListener('change', function () {
            appManualInput.value = '';
            refreshFromTargetApp();
        });
        appManualInput.addEventListener('change', refreshFromTargetApp);

        addFmBtn.addEventListener('click', function () {
            appendCrossAppFieldMapRow(fmContainer, kind, tableCodeForExpand, currentTargetAppId(), null);
        });

        deleteBtn.addEventListener('click', function () {
            card.remove();
        });

        container.appendChild(card);

        if (savedCfg) {
            if (savedCfg.targetAppId) {
                if (optionExists(appSelect, savedCfg.targetAppId)) {
                    appSelect.value = savedCfg.targetAppId;
                } else {
                    // 存的App不在目前Space清單(可能是清單抓取失敗、或設定當時在別的Space)，退回手動輸入框
                    appManualInput.value = savedCfg.targetAppId;
                }
            }
            if (buttonLabelInput) buttonLabelInput.value = savedCfg.buttonLabel || '';

            var tId = savedCfg.targetAppId || '';
            if (tId) {
                fetchTargetAppFields(tId, function (fields) {
                    populateFieldSelect(matchTargetSelect, fields, savedCfg.matchTargetField);
                    var savedMappings = savedCfg.fieldMappings || [];
                    if (savedMappings.length) {
                        savedMappings.forEach(function (fm) {
                            appendCrossAppFieldMapRow(fmContainer, kind, tableCodeForExpand, tId, fm);
                        });
                    } else {
                        // 舊資料存的時候剛好0組對應，一樣至少顯示一列空白列，維持跟新卡片一致的預設狀態
                        appendCrossAppFieldMapRow(fmContainer, kind, tableCodeForExpand, tId, null);
                    }
                });
            } else {
                // 有存過設定但當時沒選目標App(理論上不該發生)，一樣給一列空白列可以填
                appendCrossAppFieldMapRow(fmContainer, kind, tableCodeForExpand, '', null);
            }
        } else {
            // 全新卡片：預設就顯示一組空白的欄位對應，不用使用者自己按+才看得到
            appendCrossAppFieldMapRow(fmContainer, kind, tableCodeForExpand, currentTargetAppId(), null);
        }

        return card;
    }

    // 建立單一列「目標App欄位 → 填入欄位」的對應
    function appendCrossAppFieldMapRow(container, kind, tableCodeForExpand, targetAppId, savedFm) {
        var frag = els.crossAppFieldMapTemplate.content.cloneNode(true);
        var row = frag.querySelector('.taf-crossapp-fieldmap-row');
        var sourceSelect = row.querySelector('.taf-crossapp-fm-source-select');
        var targetSelect = row.querySelector('.taf-crossapp-fm-target-select');
        var deleteBtn = row.querySelector('.taf-crossapp-fm-delete-btn');
        var inlineAddBtn = row.querySelector('.taf-crossapp-fm-inline-add-btn');

        inlineAddBtn.addEventListener('click', function () {
            appendCrossAppFieldMapRow(container, kind, tableCodeForExpand, targetAppId, null);
        });

        if (targetAppId) {
            fetchTargetAppFields(targetAppId, function (fields) {
                populateFieldSelect(sourceSelect, fields, savedFm && savedFm.sourceField);
            });
        }

        if (kind === 'header') {
            populateHeaderFieldSelect(targetSelect, savedFm && savedFm.targetField);
        } else {
            populateTargetFieldSelect(targetSelect, tableCodeForExpand);
            if (savedFm && savedFm.targetField) targetSelect.value = savedFm.targetField;
        }

        deleteBtn.addEventListener('click', function () { row.remove(); });
        container.appendChild(row);
    }

    // 收集單張跨App卡片的設定值
    function collectCrossAppCard(card, isExpand) {
        var appSelect = card.querySelector('.taf-crossapp-app-select');
        var appManual = card.querySelector('.taf-crossapp-app-manual');
        var targetAppId = (appManual.value || '').trim() || appSelect.value || '';

        var targetAppName = '';
        if (appSelect.value && appSelect.value === targetAppId) {
            var opt = appSelect.options[appSelect.selectedIndex];
            targetAppName = opt ? opt.textContent : '';
        }

        var matchTargetField = card.querySelector('.taf-crossapp-match-target-select').value;
        var matchSourceField = card.querySelector('.taf-crossapp-match-source-select').value;

        var fieldMappings = [];
        card.querySelectorAll('.taf-crossapp-fieldmap-row').forEach(function (row) {
            var sourceField = row.querySelector('.taf-crossapp-fm-source-select').value;
            var targetField = row.querySelector('.taf-crossapp-fm-target-select').value;
            if (sourceField && targetField) {
                fieldMappings.push({ sourceField: sourceField, targetField: targetField });
            }
        });

        var result = {
            targetAppId: targetAppId,
            targetAppName: targetAppName,
            matchTargetField: matchTargetField,
            matchSourceField: matchSourceField,
            fieldMappings: fieldMappings
        };

        if (isExpand) {
            var labelInput = card.querySelector('.taf-crossapp-button-label');
            result.buttonLabel = (labelInput && labelInput.value.trim()) || '帶入明細';
        }

        return result;
    }

    // ---- 2. Table group (one per subtable being configured) ----
    function createTableGroup(savedTableConfig) {
        var subtableCodes = window.__taf_subtableCodes || [];
        var frag = els.tableGroupTemplate.content.cloneNode(true);
        var group = frag.querySelector('.taf-table-group');
        var groupIndex = tableGroupCounter++;
        group.setAttribute('data-table-group-index', groupIndex);

        var tableSelect = group.querySelector('.taf-table-select');
        var rulesContainer = group.querySelector('.taf-rules-container');
        var addRuleBtn = group.querySelector('.taf-add-rule-btn');
        var deleteBtn = group.querySelector('.taf-delete-table-btn');
        var rowPresetsContainer = group.querySelector('.taf-row-presets-container');
        var addRowPresetBtn = group.querySelector('.taf-add-row-preset-btn');
        var crossAppExpandContainer = group.querySelector('.taf-crossapp-expand-container');
        var addCrossAppExpandBtn = group.querySelector('.taf-add-crossapp-expand-btn');

        var inlineAddTableBtn = group.querySelector('.taf-inline-add-table-btn');
        inlineAddTableBtn.addEventListener('click', function () {
            createTableGroup(null);
        });

        subtableCodes.forEach(function (code) {
            var opt = document.createElement('option');
            opt.value = code;
            opt.textContent = subtableLabel(code);
            tableSelect.appendChild(opt);
        });

        addRuleBtn.addEventListener('click', function () {
            appendRuleCard(rulesContainer, tableSelect.value, null);
        });

        addRowPresetBtn.addEventListener('click', function () {
            createRowPresetCard(rowPresetsContainer, tableSelect.value, null);
        });

        addCrossAppExpandBtn.addEventListener('click', function () {
            createCrossAppCard('expand', crossAppExpandContainer, tableSelect.value, null);
        });

        deleteBtn.addEventListener('click', function () {
            group.remove();
        });

        // Changing the table clears its rules (target field list would no longer be valid)
        tableSelect.addEventListener('change', function () {
            rulesContainer.innerHTML = '';
            rowPresetsContainer.innerHTML = '';
            crossAppExpandContainer.innerHTML = '';
        });

        els.tablesContainer.appendChild(group);

        if (savedTableConfig) {
            tableSelect.value = savedTableConfig.tableCode;
            (savedTableConfig.mappings || []).forEach(function (mapping) {
                appendRuleCard(rulesContainer, savedTableConfig.tableCode, mapping);
            });
            (savedTableConfig.rowPresets || []).forEach(function (preset) {
                createRowPresetCard(rowPresetsContainer, savedTableConfig.tableCode, preset);
            });
            (savedTableConfig.crossAppExpands || []).forEach(function (expandCfg) {
                createCrossAppCard('expand', crossAppExpandContainer, savedTableConfig.tableCode, expandCfg);
            });
        } else {
            // 新增的表格卡片一樣預設展開一筆，讓使用者一看就懂「展開列」在講什麼，
            // 不用先摸索才知道要點哪裡。
            createCrossAppCard('expand', crossAppExpandContainer, tableSelect.value, null);
        }
    }

    function subtableLabel(code) {
        // properties fetched above only stored non-subtable fields in allFields,
        // so look up the label via the raw subtableFields keys' parent — kept simple here.
        return code;
    }

    // ---- 3. Rule card creation, with type-compatibility filtering ----
    function appendRuleCard(rulesContainer, tableCode, savedRule) {
        var frag = els.ruleTemplate.content.cloneNode(true);
        var card = frag.querySelector('.taf-rule-card');
        var index = ruleCounter++;
        card.setAttribute('data-rule-index', index);

        var targetSelect = card.querySelector('.taf-target-field-select');
        var headerSelect = card.querySelector('.taf-source-header-select');
        var radios = card.querySelectorAll('.taf-source-type');
        var staticInput = card.querySelector('.taf-source-static-input');
        var staticSelect = card.querySelector('.taf-source-static-select');
        var headerRow = card.querySelector('.taf-source-header-row');
        var staticRow = card.querySelector('.taf-source-static-row');
        var onlyIfEmpty = card.querySelector('.taf-only-if-empty');
        var deleteBtn = card.querySelector('.taf-delete-rule-btn');
        var inlineAddBtn = card.querySelector('.taf-inline-add-rule-btn');
        var typeWarning = card.querySelector('.taf-type-warning');
        var staticMultiselect = card.querySelector('.taf-source-static-multiselect');
        setupMultiselectDropdown(staticMultiselect);

        radios.forEach(function (r) { r.name = 'taf-source-type-' + index; });

        populateTargetFieldSelect(targetSelect, tableCode);
        refreshStaticInputType(targetSelect, staticInput, staticSelect, staticMultiselect, tableCode);
        refreshHeaderOptions(targetSelect, headerSelect, typeWarning);

        // Re-filter header options whenever the target field changes,
        // since compatible source types depend on the target's type.
        targetSelect.addEventListener('change', function () {
            staticInput.value = '';
            staticSelect.innerHTML = '';
            refreshStaticInputType(targetSelect, staticInput, staticSelect, staticMultiselect, tableCode);
            refreshHeaderOptions(targetSelect, headerSelect, typeWarning);
            var group = card.closest('.taf-table-group');
            if (group) validateDuplicateTargets(group);
        });

        radios.forEach(function (radio) {
            radio.addEventListener('change', function () {
                if (radio.value === 'header' && radio.checked) {
                    headerRow.style.display = '';
                    staticRow.style.display = 'none';
                } else if (radio.value === 'static' && radio.checked) {
                    headerRow.style.display = 'none';
                    staticRow.style.display = '';
                }
            });
        });

        staticSelect.addEventListener('change', function () {
            staticInput.value = staticSelect.value;
        });

        deleteBtn.addEventListener('click', function () {
            var group = card.closest('.taf-table-group');
            card.remove();
            if (group) validateDuplicateTargets(group);
        });

        inlineAddBtn.addEventListener('click', function () {
            appendRuleCard(rulesContainer, tableCode, null);
        });

        rulesContainer.appendChild(card);

        if (savedRule) {
            targetSelect.value = savedRule.targetField;
            refreshStaticInputType(targetSelect, staticInput, staticSelect, staticMultiselect, tableCode);
            refreshHeaderOptions(targetSelect, headerSelect, typeWarning);

            if (savedRule.sourceType === 'static') {
                card.querySelector('.taf-source-type[value="static"]').checked = true;
                headerRow.style.display = 'none';
                staticRow.style.display = '';
                staticInput.value = savedRule.sourceValue || '';
                if (staticSelect.style.display !== 'none') {
                    staticSelect.value = savedRule.sourceValue || '';
                }
                if (Array.isArray(savedRule.sourceValue)) {
                    setCheckedValues(staticMultiselect, savedRule.sourceValue);
                    updateMsTriggerLabel(staticMultiselect);
                }
            } else {
                card.querySelector('.taf-source-type[value="header"]').checked = true;
                // If the saved source field isn't in the (now type-filtered) list,
                // add it back in so the saved setting isn't silently lost, but flag it.
                if (savedRule.sourceValue && !optionExists(headerSelect, savedRule.sourceValue)) {
                    var opt = document.createElement('option');
                    opt.value = savedRule.sourceValue;
                    opt.textContent = (allFields[savedRule.sourceValue] || {}).label || savedRule.sourceValue;
                    headerSelect.appendChild(opt);
                    typeWarning.style.display = '';
                }
                headerSelect.value = savedRule.sourceValue;
            }
            onlyIfEmpty.checked = savedRule.onlyIfEmpty !== false;
        }
        var parentGroup = rulesContainer.closest('.taf-table-group');
        if (parentGroup) validateDuplicateTargets(parentGroup);
    }

    function optionExists(selectEl, value) {
        for (var i = 0; i < selectEl.options.length; i++) {
            if (selectEl.options[i].value === value) return true;
        }
        return false;
    }

    function getCheckedValues(container) {
        var vals = [];
        container.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
            vals.push(cb.value);
        });
        return vals;
    }

    function setCheckedValues(container, values) {
        var set = {};
        (values || []).forEach(function (v) { set[v] = true; });
        container.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
            cb.checked = !!set[cb.value];
        });
    }

    function updateMsTriggerLabel(dropdownEl) {
        var trigger = dropdownEl.querySelector('.taf-ms-trigger');
        var checked = getCheckedValues(dropdownEl);
        trigger.textContent = checked.length ? ('已選 ' + checked.length + ' 項：' + checked.join('、')) : '請選擇';
        trigger.title = checked.join('、');
    }

    function setupMultiselectDropdown(dropdownEl) {
        var trigger = dropdownEl.querySelector('.taf-ms-trigger');
        var panel = dropdownEl.querySelector('.taf-ms-panel');
        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            var isOpen = panel.classList.contains('taf-ms-panel-open');
            document.querySelectorAll('.taf-ms-panel-open').forEach(function (p) { p.classList.remove('taf-ms-panel-open'); });
            document.querySelectorAll('.taf-ms-trigger-open').forEach(function (t) { t.classList.remove('taf-ms-trigger-open'); });
            if (!isOpen) {
                panel.classList.add('taf-ms-panel-open');
                trigger.classList.add('taf-ms-trigger-open');
            }
        });
    }

    // 點面板以外的地方 -> 全部收合（掛一次即可，放在檔案最外層）
    document.addEventListener('click', function () {
        document.querySelectorAll('.taf-ms-panel-open').forEach(function (p) { p.classList.remove('taf-ms-panel-open'); });
        document.querySelectorAll('.taf-ms-trigger-open').forEach(function (t) { t.classList.remove('taf-ms-trigger-open'); });
    });

    function populateTargetFieldSelect(selectEl, tableCode) {
        var fields = subtableFields[tableCode] || {};
        selectEl.innerHTML = '';
        Object.keys(fields).forEach(function (code) {
            var f = fields[code];
            if (f.type === 'SUBTABLE') return;
            var opt = document.createElement('option');
            opt.value = code;
            opt.textContent = f.label + '（' + code + '）';
            opt.setAttribute('data-field-type', f.type);
            selectEl.appendChild(opt);
        });
    }

    // Only list header fields whose type is compatible with the currently
    // selected target field's type.
    function refreshHeaderOptions(targetSelect, headerSelect, typeWarning) {
        var selectedOption = targetSelect.options[targetSelect.selectedIndex];
        var targetType = selectedOption ? selectedOption.getAttribute('data-field-type') : null;
        var compatibleTypes = (targetType && TYPE_COMPATIBILITY[targetType]) || [];

        var previousValue = headerSelect.value;
        headerSelect.innerHTML = '';
        headerFieldCodes.forEach(function (code) {
            var field = allFields[code];
            if (compatibleTypes.indexOf(field.type) === -1) return;
            var opt = document.createElement('option');
            opt.value = code;
            opt.textContent = field.label + '（' + code + '）';
            headerSelect.appendChild(opt);
        });

        typeWarning.style.display = 'none';
        if (previousValue && optionExists(headerSelect, previousValue)) {
            headerSelect.value = previousValue;
        }
    }

    function validateDuplicateTargets(groupEl) {
        var seen = {}; // 用來記錄「已經看過」的目標欄位
        var hasDuplicate = false;

        // 按照畫面上由上往下的順序，逐一檢查每一張規則卡片
        groupEl.querySelectorAll('.taf-rule-card').forEach(function (card) {
            var sel = card.querySelector('.taf-target-field-select');
            var warning = card.querySelector('.taf-duplicate-warning');

            if (!sel || !warning) return;

            var val = sel.value;
            if (val) {
                if (seen[val]) {
                    // 如果這個欄位前面已經出現過了，代表這個是「後面重複選的」，顯示紅字！
                    warning.style.display = 'inline-block';
                    hasDuplicate = true;
                } else {
                    // 如果是第一次看到，把它記下來，並確保不顯示紅字
                    seen[val] = true;
                    warning.style.display = 'none';
                }
            } else {
                warning.style.display = 'none';
            }
        });

        return hasDuplicate;
    }

    els.addTableBtn.addEventListener('click', function () {
        createTableGroup(null);
    });

    // ---- 4. Load / Save config ----
    function loadExistingConfig(subtableCodes) {
        var config = kintone.plugin.app.getConfig(PLUGIN_ID);
        var parsed = null;

        if (config && config.config) {
            try {
                parsed = JSON.parse(config.config);
            } catch (e) {
                parsed = null;
            }
        }

        if (parsed && parsed.tables && parsed.tables.length) {
            parsed.tables.forEach(function (tableConfig) {
                createTableGroup(tableConfig);
            });
        } else if (subtableCodes.length) {
            // No saved config yet — start with one empty table group for convenience.
            createTableGroup(null);
        }
    }

    els.saveBtn.addEventListener('click', function () {

        var hasError = false;

        // 👉 儲存前先強制掃描一次全場，確認沒有觸發重複目標的紅字
        els.tablesContainer.querySelectorAll('.taf-table-group').forEach(function (group) {
            if (validateDuplicateTargets(group)) {
                hasError = true;
            }
        });

        // 👉 如果有錯誤，直接中斷執行，什麼都不做 (依靠畫面上的紅字引導使用者)
        if (hasError) {
            return;
        }

        var tables = [];

        els.tablesContainer.querySelectorAll('.taf-table-group').forEach(function (group) {
            var tableCode = group.querySelector('.taf-table-select').value;
            var mappings = [];

            group.querySelectorAll('.taf-rule-card').forEach(function (card) {
                var targetField = card.querySelector('.taf-target-field-select').value;
                var checkedRadio = card.querySelector('.taf-source-type:checked');
                var sourceType = checkedRadio ? checkedRadio.value : 'header';
                var sourceValue = '';
                if (sourceType === 'static') {
                    var staticSelect = card.querySelector('.taf-source-static-select');
                    var staticInput = card.querySelector('.taf-source-static-input');
                    var staticMs = card.querySelector('.taf-source-static-multiselect');
                    if (staticMs.style.display !== 'none') {
                        sourceValue = getCheckedValues(staticMs);
                    } else if (staticSelect.style.display !== 'none') {
                        sourceValue = staticSelect.value;
                    } else {
                        sourceValue = staticInput.value;
                    }
                } else {
                    sourceValue = card.querySelector('.taf-source-header-select').value;
                }
                var onlyIfEmpty = card.querySelector('.taf-only-if-empty').checked;

                mappings.push({
                    targetField: targetField,
                    sourceType: sourceType,
                    sourceValue: sourceValue,
                    onlyIfEmpty: onlyIfEmpty
                });
            });
            var rowPresets = [];
            group.querySelectorAll('.taf-row-preset-card').forEach(function (presetCard) {
                var fields = {};
                presetCard.querySelectorAll('.taf-field-value-row').forEach(function (fvRow) {
                    var fieldCode = fvRow.querySelector('.taf-fv-field-select').value;
                    var fvStaticSelect = fvRow.querySelector('.taf-fv-static-select');
                    var fvStaticInput = fvRow.querySelector('.taf-fv-static-input');
                    var fvStaticMs = fvRow.querySelector('.taf-fv-static-multiselect');
                    var value;
                    if (fvStaticMs.style.display !== 'none') {
                        value = getCheckedValues(fvStaticMs);
                    } else if (fvStaticSelect.style.display !== 'none') {
                        value = fvStaticSelect.value;
                    } else {
                        value = fvStaticInput.value;
                    }
                    if (fieldCode) fields[fieldCode] = value;
                });
                rowPresets.push({ fields: fields });
            });

            var crossAppExpands = [];
            group.querySelectorAll('.taf-crossapp-expand-container > .taf-crossapp-card').forEach(function (card) {
                crossAppExpands.push(collectCrossAppCard(card, true));
            });

            tables.push({ tableCode: tableCode, mappings: mappings, rowPresets: rowPresets, crossAppExpands: crossAppExpands });
        });

        var configObj = { tables: tables };

        kintone.plugin.app.setConfig(
            { config: JSON.stringify(configObj) },
            function () {
                // 1. 更新畫面上的提示訊息
                els.saveMsg.textContent = '已儲存！即將自動返回應用程式設定...';

                // 2. 延遲 1.5 秒後跳轉回 kintone 後台
                setTimeout(function () {
                    // 跳轉至該 App 的設定首頁
                    window.location.href = '../../flow?app=' + kintone.app.getId();
                }, 1500);
            }
        );
    });

})(kintone.$PLUGIN_ID);
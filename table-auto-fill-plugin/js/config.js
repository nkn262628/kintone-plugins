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
        fieldValueTemplate: document.getElementById('taf-field-value-template')
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
            loadExistingConfig(subtableCodes);
        })
        .catch(function (err) {
            console.error('table-auto-fill-plugin: failed to fetch app fields', err);
            els.saveMsg.textContent = '欄位資訊取得失敗,請重新整理畫面。';
        });

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

        deleteBtn.addEventListener('click', function () {
            group.remove();
        });

        // Changing the table clears its rules (target field list would no longer be valid)
        tableSelect.addEventListener('change', function () {
            rulesContainer.innerHTML = '';
            rowPresetsContainer.innerHTML = '';
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
            tables.push({ tableCode: tableCode, mappings: mappings, rowPresets: rowPresets });
        });

        var configObj = { tables: tables };

        kintone.plugin.app.setConfig(
            { config: JSON.stringify(configObj) },
            function () {
                // 1. 更新畫面上的提示訊息
                els.saveMsg.textContent = '已儲存！即將自動返回應用程式設定...';
                els.saveMsg.style.color = '#5c8b6f'; // 視你的 UI 需求，也可以動態加個顏色

                // 2. 延遲 1.5 秒後跳轉回 kintone 後台
                setTimeout(function () {
                    // 跳轉至該 App 的設定首頁
                    window.location.href = '../../flow?app=' + kintone.app.getId();
                }, 1500);
            }
        );
    });

})(kintone.$PLUGIN_ID);
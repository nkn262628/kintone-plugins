# ERP 進出貨/調撥條碼掃描外掛 (barcode-plugin-v2)

kintone 外掛，提供「條碼掃描」自動帶入商品資料的功能，並依 App 用途分成三種模式：
1.進貨（採購入庫）
2.出貨（銷貨）
3.調撥（含借調/歸還）
三種模式共用同一支外掛、同一套掃碼 UI，差異透過設定頁面（config）的欄位代碼對應與 App 模式切換來處理。

提供三種條碼掃描自動帶入商品的方式：
1.鏡頭掃描
2.圖片上傳
3.手動輸入

---

## 目錄結構

```
barcode-plugin-v2/
├── manifest.json
├── icon.png
├── html/
│   └── config.html          # 外掛設定頁面
├── css/
│   ├── config.css
│   └── config-mode-switch.css
└── js/
    ├── zxing-browser.min.js # 第三方條碼辨識函式庫（勿修改）
    ├── config.js            # 設定頁面邏輯（三態模式切換、欄位下拉選單）
    ├── desktop-core.js      # 共用命名空間 SP、Toast、API 查詢、掃碼面板 UI
    ├── desktop-inbound.js   # 進貨模式專屬邏輯
    ├── desktop-outbound.js  # 出貨模式專屬邏輯
    ├── desktop-transfer.js  # 調撥模式專屬邏輯（含借還子系統）
    └── desktop-events.js    # 事件註冊與分派（進貨/出貨共用；調撥另有自行註冊部分）
```

桌面版與手機版共用同一組 JS（`desktop` 與 `mobile` 兩個區塊在 `manifest.json` 裡指向相同檔案），程式內部透過 `SP.isMobile` 與 `event.type.includes('mobile.')` 判斷來源、統一處理。

---

## 核心概念：App 模式（`appMode`）

外掛透過設定頁面的 `appMode` 決定行為，共三種：

| 值 | 說明 | 判斷變數 |
|---|---|---|
| `in` | 進貨（採購入庫） | `SP.OPT_APP_MODE === 'in'` |
| `out` | 出貨（銷貨） | `SP.OPT_IS_SHIPMENT === true` |
| `transfer` | 調撥（含借調/歸還） | `SP.OPT_IS_TRANSFER === true` |

> 舊版設定只有 `isShipment` 布林勾選框（沒有 `appMode`），`desktop-core.js` 與 `config.js` 都有相容判斷：若讀不到 `appMode`，會自動用 `isShipment` 換算成 `in`/`out`，避免舊外掛設定升級後失效。

每個 App（kintone 應用程式）安裝外掛時只設定**一種模式**，一個 App 對應一種單據類型。

---

## 檔案職責

### `desktop-core.js`（共用核心）
- 讀取設定頁面的所有欄位代碼，掛到 `window.SP` 命名空間
- `SP.showToast(message, type, duration)`：畫面右上角提示訊息（success/error/warn/info），已針對手機版加上寬度自適應
- `SP.fetchStockSync(whNames, itemCode)`：同步查詢庫存總表，支援單一倉庫字串（進貨/出貨用）或倉庫陣列（調撥雙倉庫用）
- `SP.scanPanel`：掃碼彈窗 UI（開鏡頭掃描 / 上傳圖片 / 手動輸入條碼），三種模式共用同一套面板，內部依 `SP.OPT_APP_MODE` 決定要不要做廠商比對、客戶售價比對

### `desktop-inbound.js`（進貨模式）
- 已入庫數量／退貨數量即時紅字提示
- 已結案（立帳狀態）警告 Toast
- 存檔前驗證：廠商必填、入庫+退貨不可超過採購量、倉庫必須有庫存建檔

### `desktop-outbound.js`（出貨模式）
- 依客戶類型即時查價（零售/批發/網路）
- 單行庫存即時提示（庫存不足會紅字）
- 存檔成功後同步庫存（出貨量／預約保留量），刪除記錄時歸還庫存
- 「是否結案」與「立帳狀態」雙欄位獨立判斷，只有兩者都成立才跳已結案警告

### `desktop-transfer.js`（調撥模式，含借還子系統）
- 撥出/撥入雙倉庫的即時庫存驗證（公式：進貨量 − 出貨量 − 預約保留量）
- 借調撥出／借調歸還兩種調撥性質，歸還狀態自動鎖定
- 「借調單下拉選單」+「借還紀錄面板」：選擇未歸還的借調單後自動帶出剩餘可歸還品項，並顯示借出/已歸還/剩餘的彙總表格與單據時間軸
- 這支檔案**自行註冊**一部分 `kintone.events.on`（不是透過 `desktop-events.js` 分派），因為借還子系統監聽的欄位/事件跟進貨出貨完全不同形狀（雙倉庫觸發欄位、調撥性質變更、唯讀檢視畫面）
- 存檔前驗證與刪除還原都會同步處理雙倉庫的庫存量

### `desktop-events.js`（事件分派層）
- 只負責「監聽事件 → 依模式呼叫對應模組」，不寫商業邏輯
- 統一掛載「📷 掃描條碼」按鈕（優先塞進使用者指定的 Space 欄位，失敗則退而求其次掛在標題列，最終備援用 `position:fixed` 貼在畫面右下角）
- 調撥模式的畫面顯示/欄位鎖定邏輯完全交給 `desktop-transfer.js` 自己處理，這裡略過避免重複

---

## 設定頁面（config）欄位總覽

設定頁面依模式分頁籤切換（`mode-btn-in` / `mode-btn-out` / `mode-btn-transfer`），切換時會套用對應模式的預設欄位代碼，方便快速上手；已存檔過的設定值優先於預設值。

### 通用設定（三種模式共用）

| Key | 說明 | 預設值 |
|---|---|---|
| `productAppId` | 商品主檔 App ID（**必填**） | — |
| `invAppId` | 庫存總表 App ID | — |
| `scanSpaceId` | 「📷 掃描條碼」按鈕要掛載的空白欄位代碼 | `scan_space` |
| `prodBarcode` | 商品主檔的條碼欄位代碼 | `條碼編號` |
| `prodNameField` | 商品主檔的名稱欄位代碼 | `中文名稱` |
| `prodCodeField` | 商品主檔的料號欄位代碼 | `商品料號` |
| `prodSuppTable` | 商品主檔的供應商選單子表格代碼（進貨用） | `供應商選單` |
| `suppName` | 供應商選單內的廠商名稱欄位 | `廠商名稱` |
| `suppPrice` | 供應商選單內的廠商定價欄位 | `廠商定價` |

### 進貨模式（`appMode = 'in'`）

| Key | 說明 | 預設值 |
|---|---|---|
| `fPoNum` | 採購單號欄位 | `採購單號` |
| `fSupplierName` | 廠商名稱欄位 | `廠商名稱` |
| `fSubtable` | 子表格代碼 | `採購內容` |
| `fProdName` / `fProdCode` / `fBarcode` | 子表格內商品名稱/料號/條碼 | `商品名稱` / `商品料號` / `條碼編號` |
| `fPrice` / `fListPrice` | 單價 / 廠商定價 | `單價` / `廠商定價` |
| `fPoQty` | 採購數量 | `採購數量` |
| `fInQty` | 已入庫數量 | `已入庫數量` |
| `fWh` | 收貨倉庫 | `收貨倉庫` |
| 功能開關 | `enableSupplierGuard`（廠商防呆）、`enableAutoFillSupplier`（自動帶入廠商） | 預設開啟 |

### 出貨模式（`appMode = 'out'`）

| Key | 說明 | 預設值 |
|---|---|---|
| `fPoNum` | 銷貨單號欄位 | `銷貨單號` |
| `fCustomerName` / `fCustomerType` | 客戶名稱 / 客戶類型 | `客戶名稱` / `客戶類型` |
| `fStatus` | 是否結案 | `是否結案` |
| `fSubtable` | 子表格代碼 | `銷售內容` |
| `fPrice` / `fListPrice` | 實際售價 / 商品售價 | `實際售價` / `商品售價` |
| `fPoQty` | 數量 | `數量` |
| `fWh` | 出貨倉庫 | `出貨倉庫` |
| `fWhTrigger` | 倉庫 Lookup 連動觸發欄位（⚠️ 見下方「Lookup 觸發欄位」說明） | `倉庫編號` |

### 調撥模式（`appMode = 'transfer'`）

| Key | 說明 | 預設值 |
|---|---|---|
| `fPoNum` | 調撥單號欄位 | `調撥單號` |
| `fSubtable` | 子表格代碼 | `調撥內容` |
| `fPoQty` | 調撥數量 | `調撥數量` |
| `fFromWh` / `fToWh` | 撥出倉庫 / 撥入倉庫 | `撥出倉庫` / `撥入倉庫` |
| `fFromWhTrigger` / `fToWhTrigger` | 雙倉庫各自的 Lookup 觸發欄位 | `撥出倉庫_單位編號` / `撥入倉庫_單位編號` |
| `fTransferStatus` | 調撥狀態（處理中／已發貨運輸中／調撥完成） | `調撥狀態` |
| `fTransferType` | 調撥性質（常態移轉／借調撥出／借調歸還） | `調撥性質` |
| `fReturnStatus` | 歸還狀態（—／未歸還／已歸還，程式自動鎖定唯讀） | `歸還狀態` |
| `fRefNo` | 對應借調單號 | `對應借調單號` |
| `fTransferDate` | 調撥日期 | `調撥日期` |
| `fUnit` | 單位 | `單位` |

**表單設計額外需求**：調撥模式需要在表單上放兩個**空白欄位**：
- `transfer_return_space`：借調單下拉選單掛載處，建議放在「對應借調單號」旁邊
- `transfer_history_space`：借還紀錄卡片掛載處，建議放在表單**最下方、獨立整行**，避免被其他欄位的排版寬度卡住

---

## ⚠️ Lookup 觸發欄位（`*Trigger`）— 常見誤區

kintone 的 Lookup 型欄位（例如「收貨倉庫」「出貨倉庫」「撥出倉庫」）本身**不會觸發 `change` 事件**；真正會觸發的是 Lookup 連動寫入的**唯讀欄位**（通常是「XX倉庫_單位編號」之類的欄位）。

因此 `fWhTrigger`、`fFromWhTrigger`、`fToWhTrigger` 這幾個設定值，**必須填寫真正會觸發 change 事件的欄位代碼**，而不是 Lookup 欄位本身。如果即時庫存驗證/紅字提示沒有反應，第一件事先檢查這幾個設定值是否對到正確的觸發欄位。

---

## 手機版相容性注意事項

1. **事件名稱前綴不同**：手機版事件是 `mobile.app.record.xxx`，桌面版是 `app.record.xxx`。`desktop-transfer.js` 用 `bothEvents()` helper 統一補上兩種前綴；`event.type` 一律用 `.includes()` 而非嚴格比對 `===`。
2. **事件鏈中斷風險**：kintone 同一事件可被多支檔案依 `manifest.json` 載入順序註冊，若前面的 handler 同步拋錯會讓後面排隊的 handler（例如負責掛「📷 掃描條碼」按鈕、或負責填入 Lookup 資料的 handler）完全不會被執行。因此凡是新增的 change 事件邏輯，務必包 `try/catch`，尤其是**掃碼/Lookup 帶入資料的過程會連續觸發多次 change 事件**，同步查詢型 API（`SP.fetchStockSync`）若卡在這條鏈上，容易造成連續打 API 或直接讓 Lookup 帶入失效。
3. `kintone.mobile.app.record.getFieldElement` 等部分桌面版 API 在手機版支援不穩定，用到的地方都要包 `try/catch` 並安靜降級，不能讓它擋住後續流程。

---

## 版本管理提醒

- 這支外掛用 `.ppk` 私鑰簽章，**改版時務必用同一把既有的 `.ppk` 重新打包**（`kintone-plugin-packer`），才會被 kintone 認成「同一個外掛的更新版本」，各 App 上已設定好的欄位對應才不會遺失。
- `.ppk` 不建議進 Git（尤其若專案未來可能公開），另外用雲端硬碟/密碼管理器備份一份。
- 建議搭配 `CHANGELOG.md` 記錄每次改版內容，方便回溯問題是哪一版引入的。

---

## Changelog

### v2.x（2026-07）
- 修正調撥模組手機版事件缺少 `mobile.` 前綴，導致借還子系統（下拉選單/歷史面板/即時驗證）在手機版完全失效
- 調撥借還紀錄卡片改為獨立空白欄位（`transfer_history_space`）滿版顯示，修正桌面版排版跑版問題
- `SP.showToast` 加上手機版寬度自適應（`max-width` + 允許換行），避免長訊息在窄螢幕破版
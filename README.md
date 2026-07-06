# Kintone 外掛集中管理區

這個儲存庫（Repository）用於集中維護與管理 Kintone 的客製化外掛專案。

## 👤 開發與維護者

* **開發者**：鈕愷娜
* **聯絡方式**：nkn262628@gmail.com

---

## 📂 包含的外掛 (Plugins)

目前此儲存庫包含以下外掛：

* **`barcode-plugin-v2/`**：用於 ERP 系統的條碼掃描、進出庫核對與生成外掛。
* **`auto-number-plugin/`**：根據特定規則自動產生單號的外掛。

---

## ⚠️ 安全性與私鑰 (`.ppk`) 管理

為了保護外掛的唯一性與安全性，**請勿將 `.ppk` 私鑰檔案提交到 Git 儲存庫**。
本專案的 `.gitignore` 已經設定忽略所有 `*.ppk` 檔案。

* **私鑰備份位置**：`(請在此填寫你實際存放 .ppk 的安全位置，例如：公司的 NAS、Google Drive 或是密碼管理器)`
* **重要**：如果遺失 `.ppk` 檔案，將無法發布外掛的更新版本（Kintone 會將其視為全新的外掛）。

---

## 🛠️ 打包與發布教學

本專案使用官方的 `@kintone/plugin-packer` 進行打包。
**請確保你是在本專案的根目錄 (`kintone-plugins`) 下執行以下指令。**

### 1. 安裝打包工具 (若尚未安裝)
```bash
npm install -g @kintone/plugin-packer
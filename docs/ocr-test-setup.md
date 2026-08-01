# OCR 測試工具設置指南

## 概述

OCR 測試工具是一個集成在 Admin 控制台的浮動窗口，用於測試 MinerU OCR 功能。用戶可以：

1. **上傳文件** - 拖放或點擊上傳 PDF 和圖片
2. **使用預加載樣本** - 直接點擊使用已準備的樣本文件
3. **查看實時結果** - 同時查看 OCR Markdown 和 LLM 分析結果

## 功能特性

### 後端功能

| 端點 | 方法 | 功能 |
|------|------|------|
| `/admin/api/ocr/samples` | GET | 列出所有可用樣本文件 |
| `/admin/api/ocr/samples/{id}` | GET | 下載特定樣本文件 |
| `/admin/api/ocr/test` | POST | 執行 OCR 測試 |

### 前端功能

- ✅ 拖放上傳區域
- ✅ 點擊選擇上傳
- ✅ 多格式支持：PDF、JPG、PNG、GIF、BMP、WebP、TIFF
- ✅ 預加載樣本列表（動態從後端加載）
- ✅ 實時 OCR 結果顯示
- ✅ 雙標籤頁查看（Markdown 和 JSON）
- ✅ 深色模式支持
- ✅ 完整的錯誤處理和用戶反饋

## 設置預加載樣本

### 步驟 1：創建樣本目錄

```bash
mkdir -p public/samples
```

### 步驟 2：添加樣本文件

將你的測試文件複製到 `public/samples/` 目錄：

```bash
# 例如，添加一個測試 PDF
cp /path/to/test-drug-insert.pdf public/samples/

# 例如，添加一個測試圖片
cp /path/to/medicine-label.jpg public/samples/
```

### 步驟 3：文件命名規則

文件名將自動作為樣本 ID 使用，並在 UI 中顯示。建議使用清晰的名稱：

```
public/samples/
├── test-drug-insert.pdf          → "test drug insert"
├── sample-medicine-box.jpg       → "sample medicine box"
├── supplement-label.png          → "supplement label"
└── complex-table-layout.pdf      → "complex table layout"
```

**支持的文件格式：**
- PDF: `.pdf`
- 圖片: `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.webp`, `.tiff`, `.tif`

### 步驟 4：重啟應用

```bash
# 重新構建並啟動
docker compose build
docker compose up -d
```

## 使用流程

### 基本測試

1. 進入 Admin 控制台 → Settings → OCR Server
2. 點擊 "Test OCR" 按鈕
3. 在浮動窗口中：
   - **使用樣本**：在 "Sample Files" 區域點擊預加載的樣本
   - **或上傳文件**：拖放或點擊上傳區域選擇文件
4. 點擊 "Convert" 按鈕執行 OCR
5. 查看結果：
   - **OCR Markdown 標籤**：原始 OCR 文本提取
   - **Analysis JSON 標籤**：LLM 結構化分析結果

### 模型選擇（可選）

1. 在 OCR Server 設定中找到 "Model name" 欄位
2. 點擊 "Load Models" 按鈕獲取 MinerU 已加載的模型列表
3. 從列表中選擇或手動輸入模型名稱
4. 點擊 "Save changes"
5. 之後的 OCR 測試將使用選定的模型

## API 響應格式

### `/admin/api/ocr/samples` 響應

```json
{
  "samples": [
    {
      "id": "test-drug-insert",
      "name": "test drug insert",
      "filename": "test-drug-insert.pdf",
      "type": "pdf",
      "description": "Sample pdf file for OCR testing",
      "mimeType": "application/pdf",
      "sizeBytes": 125432
    },
    {
      "id": "sample-medicine-box",
      "name": "sample medicine box",
      "filename": "sample-medicine-box.jpg",
      "type": "image",
      "description": "Sample image file for OCR testing",
      "mimeType": "image/jpeg",
      "sizeBytes": 284756
    }
  ]
}
```

### `/admin/api/ocr/test` 響應

```json
{
  "ok": true,
  "markdown": "# Drug Insert\n\n## Active Ingredients\n...",
  "analysis": {
    "藥品特性": "...",
    "有效成分及含量": [...],
    "用法用量": [...]
  },
  "ocrProvider": "mineru",
  "analysisProvider": "openai"
}
```

## 故障排除

### 問題：樣本文件列表為空

**可能原因：**
- `public/samples/` 目錄不存在
- 目錄中沒有支持的文件格式
- 文件權限問題

**解決方案：**
```bash
# 檢查目錄
ls -la public/samples/

# 確保文件權限正確
chmod 644 public/samples/*

# 確認文件格式
file public/samples/*
```

### 問題：OCR 測試失敗

**可能原因：**
- MinerU 服務器未配置或不可達
- OCR 服務器設定不正確
- 文件格式不支持或損壞

**解決方案：**
1. 進入 Settings → OCR Server
2. 點擊 "Test connection" 確認連接
3. 檢查 Base URL 和其他設定
4. 嘗試不同的文件

### 問題：模型列表為空

**可能原因：**
- MinerU 服務器沒有加載任何模型
- 模型發現端點失敗

**解決方案：**
1. 檢查 MinerU 服務器配置
2. 確保模型已正確加載
3. 檢查日誌查看詳細錯誤

## 性能注意事項

- **文件大小限制**：默認最大 100 MB（可在配置中調整）
- **超時設定**：OCR 測試超時 600 秒（可在 Settings 中調整）
- **並發限制**：單次一個測試（防止過載）

## 安全考慮

- ✅ 測試文件不被保存到數據庫
- ✅ 樣本文件位於受保護的 `public/` 目錄
- ✅ 需要管理員認證才能訪問測試工具
- ✅ FormData 解析器防止目錄遍歷攻擊

## 擴展和定制

### 添加自定義樣本類別

你可以修改 `ocrTestSamples.ts` 以支持樣本元數據：

```typescript
// 未來增強：支持樣本標籤和分類
interface SampleFile {
  // ... 現有字段
  tags?: string[];      // e.g., ["drug", "tfda"]
  category?: string;    // e.g., "drug-insert", "supplement"
  language?: string;    // e.g., "zh-TW", "en"
}
```

### 批量測試

計劃未來支持：
- 一次上傳多個文件
- 批量測試結果匯出
- OCR 準確度統計

## 相關文件

- 後端樣本管理：`node-server/src/admin/ocrTestSamples.ts`
- 前端 UI 組件：`web/admin-app/routes/settings/OcrTestModal.tsx`
- 樣本文件目錄：`public/samples/`
- API 端點：`node-server/src/admin/adminApp.ts` (第 1814-1836 行)

## 更新日誌

### v1.0 (2026-08-01)
- ✅ 初始版本發布
- ✅ 支持拖放上傳
- ✅ 預加載樣本支持
- ✅ 即時 OCR 結果
- ✅ 模型名稱配置
- ✅ 完整的深色模式支持

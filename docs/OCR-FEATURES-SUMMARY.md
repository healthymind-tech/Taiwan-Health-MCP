# OCR 功能完整總結

## 🎉 新增功能概述

### 1️⃣ OCR 模型名稱配置

**後端修改：**
- ✅ `adminSettings.ts` - 添加 `model_name` 字段到 OCR 設定
- ✅ `drugAnalysisService.ts` - 支持模型名稱參數傳遞

**前端表現：**
- Settings → OCR Server → "Model name" 欄位
- "Load Models" 按鈕會從 MinerU 動態獲取可用模型列表

```
Settings Form:
┌─────────────────────────────────┐
│ OCR Server                      │
├─────────────────────────────────┤
│ Provider: mineru                │
│ Base URL: http://...            │
│ Model name: [text] [Load...]    │  ← 新功能
│ Backend: hybrid-engine          │
│ Effort: medium                  │
│ ...                             │
└─────────────────────────────────┘
```

### 2️⃣ 動態模型發現

**新端點：**
```
GET /admin/api/settings/ocr/models
```

**功能：**
- 向 MinerU `/health` 端點查詢
- 獲取所有已加載的模型列表
- 在前端顯示為自動完成列表
- 用戶可快速選擇而無需手動輸入

**響應示例：**
```json
{
  "ok": true,
  "models": [
    "default-ocr-model",
    "document-layout-model",
    "table-recognition-model"
  ],
  "message": "Found 3 model(s) on MinerU."
}
```

### 3️⃣ OCR 測試工具（浮動窗口）

**新端點：**
```
POST /admin/api/ocr/test          (執行 OCR)
GET  /admin/api/ocr/samples       (列出樣本)
GET  /admin/api/ocr/samples/{id}  (獲取樣本)
```

**前端組件：**
- `OcrTestModal.tsx` - 完整的浮動窗口 UI
- `OcrTestModal.module.css` - 專業級樣式

**功能特性：**

```
┌─────────────────────────────────────────────────────────┐
│ OCR Test Tool                                       [×]  │
├──────────────────────┬──────────────────────────────────┤
│ Upload File          │ Results                          │
├──────────────────────┼──────────────────────────────────┤
│                      │                                  │
│ ┌────────────────┐   │ ┌──────────────────────────────┐ │
│ │ Drag & drop or │   │ │ Markdown │ JSON              │ │
│ │  click to add  │   │ ├──────────────────────────────┤ │
│ │ (PDF/Image)    │   │ │                              │ │
│ └────────────────┘   │ │ [OCR results here]           │ │
│                      │ │                              │ │
│ ✓ Selected:          │ │                              │ │
│   test.pdf (2.3 MB)  │ └──────────────────────────────┘ │
│                      │                                  │
│ Sample Files:        │                                  │
│ ─────────────        │                                  │
│ □ Drug Insert        │                                  │
│ □ Medicine Box       │                                  │
│ □ Supplement Label   │                                  │
│                      │                                  │
│ [Convert] [Clear]    │                                  │
└──────────────────────┴──────────────────────────────────┘
```

### 4️⃣ 預加載樣本支援

**後端模塊：**
- `ocrTestSamples.ts` - 樣本文件管理

**功能：**
- 自動發現 `public/samples/` 目錄中的文件
- 支持多種文件格式（PDF、JPG、PNG、GIF、BMP、WebP、TIFF）
- 動態生成樣本列表
- 安全的文件訪問（防止目錄遍歷）

**使用流程：**
```bash
# 1. 創建目錄
mkdir -p public/samples

# 2. 添加樣本文件
cp test-drug-insert.pdf public/samples/
cp medicine-label.jpg public/samples/

# 3. 重啟服務
docker compose up -d

# 4. 樣本自動出現在 UI 中
```

## 📊 功能對比

| 功能 | 模型配置 | 動態發現 | 測試工具 | 樣本支援 |
|------|--------|--------|--------|--------|
| **後端** | ✅ | ✅ | ✅ | ✅ |
| **前端** | ✅ | ✅ | ✅ | ✅ |
| **樣本** | - | - | ✅ | ✅ |
| **API** | ✅ | ✅ | ✅ | ✅ |

## 🚀 使用流程

### 完整 OCR 測試流程

```
1. 進入 Admin 控制台
   ↓
2. Settings → OCR Server
   ↓
3. 配置 MinerU
   ├─ Base URL: http://mineru-server:8000
   ├─ Backend: hybrid-engine
   └─ Effort: medium
   ↓
4. 點擊 "Load Models" 獲取可用模型列表
   ↓
5. 從列表中選擇模型（或留空使用默認）
   ↓
6. 點擊 "Save changes"
   ↓
7. 點擊 "Test OCR" 按鈕打開測試工具
   ↓
8. 在測試工具中：
   ├─ 選項 A：點擊預加載樣本文件
   └─ 選項 B：拖放或點擊上傳文件
   ↓
9. 點擊 "Convert" 執行 OCR
   ↓
10. 查看結果：
    ├─ Markdown 標籤：原始 OCR 文本
    └─ JSON 標籤：LLM 分析結果
```

## 📁 文件結構

```
node-server/src/
├── admin/
│   ├── adminApp.ts              (主 app，添加了3個新端點)
│   ├── adminSettings.ts         (模型配置 + 模型列表發現)
│   └── ocrTestSamples.ts        (✨ 新文件：樣本管理)
├── drugAnalysisService.ts       (添加 ocrModelName 支援)
└── formDataParser.ts            (✨ 新文件：FormData 解析)

web/admin-app/routes/settings/
├── SettingsPage.tsx             (集成 OCR 測試按鈕)
├── OcrTestModal.tsx             (✨ 新文件：浮動窗口 UI)
└── OcrTestModal.module.css      (✨ 新文件：專業級樣式)

public/
└── samples/                      (✨ 新目錄：樣本文件)

docs/
├── ocr-test-setup.md            (✨ 新文件：設置指南)
├── MinerU-vs-OpenAI.md          (✨ 新文件：技術對比)
└── OCR-FEATURES-SUMMARY.md      (本文件)

scripts/
└── setup-ocr-samples.sh         (✨ 新文件：初始化腳本)
```

## 🔧 新增 API 端點

### 1. 模型列表發現

```
POST /admin/api/settings/ocr/models
Content-Type: application/json

{
  "values": {
    "base_url": "http://mineru-server:8000"
  }
}

Response 200:
{
  "ok": true,
  "models": ["default", "table-optimized", "layout-model"],
  "message": "Found 3 model(s) on MinerU."
}
```

### 2. 執行 OCR 測試

```
POST /admin/api/ocr/test
Content-Type: multipart/form-data

[Binary PDF/Image Data]
form-data: filename="test.pdf"
form-data: file=[binary]

Response 200:
{
  "ok": true,
  "markdown": "# Drug Insert\n...",
  "analysis": { ... },
  "ocrProvider": "mineru",
  "analysisProvider": "openai"
}
```

### 3. 獲取樣本列表

```
GET /admin/api/ocr/samples

Response 200:
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
    }
  ]
}
```

### 4. 獲取樣本文件

```
GET /admin/api/ocr/samples/test-drug-insert

Response 200:
[Binary PDF Data]
Content-Type: application/pdf
Content-Disposition: inline; filename="test-drug-insert.pdf"
```

## 📋 支援的文件格式

### PDF
- ✅ `.pdf` - Adobe PDF

### 圖片
- ✅ `.jpg`, `.jpeg` - JPEG 圖像
- ✅ `.png` - PNG 圖像
- ✅ `.gif` - GIF 圖像
- ✅ `.bmp` - BMP 圖像
- ✅ `.webp` - WebP 圖像
- ✅ `.tiff`, `.tif` - TIFF 圖像

**大小限制：** 預設 100 MB（可配置）

## 🔐 安全特性

- ✅ FormData 解析器防止目錄遍歷
- ✅ 需要管理員認證
- ✅ 測試文件不被保存
- ✅ 樣本文件在受保護目錄
- ✅ 參數驗證和清理

## 🎨 UI/UX 特性

- ✅ **拖放支援** - 直觀的文件上傳
- ✅ **即時反饋** - 加載狀態和錯誤提示
- ✅ **深色模式** - 完整的亮/暗主題支援
- ✅ **響應式設計** - 適配各種屏幕尺寸
- ✅ **專業動畫** - 平滑的 UI 轉換
- ✅ **可訪問性** - 鍵盤導航和屏幕閱讀器支援

## 📊 性能考慮

| 指標 | 值 |
|------|---|
| 文件上傳大小限制 | 100 MB |
| OCR 超時 | 600 秒 |
| 模型列表超時 | 8 秒 |
| 樣本文件快取 | 無（動態加載） |

## 🐛 故障排除

### 問題 1：樣本列表為空

**原因：**
- `public/samples/` 目錄不存在
- 目錄中沒有支持的文件

**解決：**
```bash
mkdir -p public/samples
cp test.pdf public/samples/
docker compose restart app
```

### 問題 2：模型列表失敗

**原因：**
- MinerU 服務器不可達
- 端口配置錯誤

**解決：**
1. 檢查 MinerU 服務器狀態
2. 驗證 Base URL 設定
3. 點擊 "Test connection" 確認連接

### 問題 3：OCR 測試超時

**原因：**
- 文件太大
- MinerU 處理慢
- 網絡問題

**解決：**
1. 嘗試較小的文件
2. 檢查 Timeout 設定
3. 查看 MinerU 日誌

## 📈 未來擴展計劃

- [ ] 批量測試支援
- [ ] 測試結果歷史
- [ ] OCR 準確度統計
- [ ] 樣本文件標籤和分類
- [ ] 高級過濾和搜索
- [ ] 導出測試報告

## 🎯 代碼統計

| 類型 | 文件數 | 行數 |
|------|--------|------|
| 後端 TypeScript | 4 | ~500 |
| 前端 React | 1 | ~350 |
| 樣式 CSS | 1 | ~400 |
| 文檔 | 3 | ~800 |
| **總計** | **9** | **~2,050** |

## ✅ 質量保證

- ✅ TypeScript 類型檢查通過
- ✅ 編譯成功（無警告）
- ✅ 前後端集成完整
- ✅ 深色模式完整支援
- ✅ 響應式設計驗證
- ✅ 錯誤處理完善
- ✅ 安全驗證通過

## 🚀 部署指南

### 快速部署

```bash
# 1. 構建
npm run build        # 兩個目錄

# 2. 初始化樣本目錄
chmod +x setup-ocr-samples.sh
./setup-ocr-samples.sh

# 3. 啟動服務
docker compose up -d

# 4. 訪問
# http://localhost:8080/admin
```

### 添加樣本

```bash
# 方法 1：直接複製
cp my-test.pdf public/samples/

# 方法 2：使用腳本
./setup-ocr-samples.sh

# 重啟後自動出現在 UI 中
```

## 📚 參考資源

- [OCR 測試設置指南](./ocr-test-setup.md)
- [MinerU vs OpenAI 對比](./MinerU-vs-OpenAI.md)
- [MinerU GitHub](https://github.com/opendatalab/MinerU)
- [FHIR OCR Extension](../README.md)

## 📝 更新日誌

### v1.0 (2026-08-01)
- ✨ 初始版本發布
- ✨ 模型名稱配置
- ✨ 動態模型發現
- ✨ 完整 OCR 測試工具
- ✨ 預加載樣本支援
- ✨ 專業級 UI/UX
- ✨ 完整文檔

---

**版本：** 1.0  
**更新日期：** 2026-08-01  
**作者：** Taiwan Health MCP 開發團隊  
**狀態：** ✅ 生產就緒

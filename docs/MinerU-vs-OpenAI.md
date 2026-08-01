# MinerU vs OpenAI Vision API - 技術對比

## 快速對比

| 維度 | MinerU | OpenAI Vision API |
|------|--------|-------------------|
| **核心用途** | 專業文檔 OCR 和結構化提取 | 通用圖像理解和描述 |
| **專長** | 複雜 PDF、表格、多欄佈局 | 圖片描述、物體識別、場景理解 |
| **輸出格式** | Markdown、JSON、結構化數據 | 自然語言文本 |
| **部署方式** | 自托管 HTTP 服務 | 遠程 API（SaaS） |
| **API 類型** | RESTful API（自定義） | OpenAI Chat API |
| **成本模型** | 一次性部署成本 | 按 token 計費 |
| **延遲** | 低（本地化） | 中等（網絡依賴） |
| **隱私** | 完全本地控制 | 數據發送到 OpenAI |

## 詳細對比

### MinerU

**優點：**
- 🎯 **文檔優化**：專為 TFDA 藥物說明書、發票、表格等優化
- 📊 **複雜佈局**：卓越的多欄、表格、混合文本/圖像處理
- 🏠 **隱私**：完全本地部署，無數據上傳
- ⚡ **速度**：本地化，無網絡延遲
- 💰 **成本預測**：一次性部署，無持續成本
- 🔧 **可定制**：支持多個後端（hybrid-engine、pipeline、vlm-engine）
- 📁 **批量処理**：高效處理大量文檔
- 🛠️ **完全控制**：自托管意味著完全控制和集成靈活性

**缺點：**
- 🚀 **部署復雜**：需要自托管和維護
- 💻 **硬件要求**：需要投入硬件資源
- 📚 **知識庫小**：專注於文檔，通用理解能力有限
- 👥 **社區小**：相比 OpenAI，社區和集成較少

**最適用場景：**
```
✓ 大批量 TFDA 藥物說明書處理
✓ 表格識別和提取
✓ 隱私敏感的文檔（醫療、金融）
✓ 需要精確結構化提取的場景
✓ 成本效益考慮（大規模部署）
```

### OpenAI Vision API

**優點：**
- 🌟 **通用理解**：強大的圖像理解和常識推理
- 🚀 **易部署**：直接 API 調用，無需部署
- 📈 **持續改進**：自動升級到新模型
- 🌐 **多語言**：天然支持多語言理解
- 🎯 **精確度**：最先進的視覺 AI 模型
- 💡 **創意任務**：擅長場景描述、物體識別、內容分析

**缺點：**
- 📊 **表格弱點**：表格提取不如文檔 OCR 工具
- 💰 **持續成本**：按使用量計費（$0.01-0.03/1K tokens）
- 🔒 **隱私**：數據上傳到 OpenAI 服務器
- 🌐 **網絡依賴**：依賴 OpenAI API 可用性
- ⏱️ **延遲**：網絡往返延遲
- 📝 **格式**：輸出是自然語言，需額外處理結構化提取

**最適用場景：**
```
✓ 通用圖像理解（風景、人物、場景）
✓ 快速原型開發（無部署)
✓ 小規模應用或偶發使用
✓ 需要多語言支持
✓ 不關心隱私（公開內容）
```

## 在本系統中的角色

### MinerU（OCR 層）
```
藥物 PDF → MinerU OCR → Markdown 文本
                        (表格、圖像、文本識別)
```

### OpenAI Vision API（可選補充）
```
PDF → MinerU OCR → Markdown → OpenAI Vision
      (文本提取)                (可選：驗證或增強)
```

## 集成方式對比

### MinerU 集成示例
```typescript
// 自托管方式
const response = await fetch('http://mineru-server:8000/file_parse', {
  method: 'POST',
  body: formData,  // PDF 二進制數據
});
const markdown = response.data.results[0].md_content;
```

### OpenAI Vision 集成示例
```typescript
// SaaS 方式
const response = await openai.vision.create({
  model: "gpt-4-vision-preview",
  messages: [{
    role: "user",
    content: [
      { type: "image_url", image_url: { url: imageUrl } },
      { type: "text", text: "Extract table content" }
    ]
  }]
});
```

## 成本分析

### MinerU 成本（年度）

```
硬件投資：$500-2000 (GPU 服務器)
維護成本：$0-200 (可選)
人力成本：$0-500 (監控、更新)
────────────────────────
年度總成本：$500-2700

單位成本（假設 50,000 文檔/年）：
$500-2700 / 50,000 = $0.01-0.054/文檔
```

### OpenAI Vision 成本（年度）

```
假設：
- 50,000 文檔/年
- 平均 2,000 tokens/文檔
- $0.01/1K token (vision 價格)

年度成本 = 50,000 × 2,000 × $0.01/1K
        = 50,000 × 2 × $0.01
        = $1,000/年

單位成本：$1,000 / 50,000 = $0.02/文檔
```

### 成本結論

| 使用量 | MinerU 更便宜 | OpenAI 更便宜 |
|--------|-------------|-------------|
| < 10,000 文檔/年 | - | ✓ |
| 10,000-50,000 文檔/年 | ≈ | ≈ |
| > 50,000 文檔/年 | ✓ | - |

## 混合策略

許多企業採用**混合方案**：

```
層級1：MinerU
├─ 處理所有標準 TFDA 藥物說明書
├─ 95% 的文檔
└─ 成本：$0.01/文檔

層級2：OpenAI Vision（備用）
├─ 處理複雜或非標準文檔
├─ 5% 的文檔
└─ 成本：$0.02/文檔

總成本：$0.0095/文檔 + 備用容量
```

## 技術決策指南

### 選擇 MinerU 如果：
- ✓ 你正在大規模處理相似的文檔
- ✓ 文檔包含大量表格和複雜佈局
- ✓ 隱私是關鍵考慮
- ✓ 成本優化很重要
- ✓ 你需要完整控制和集成

### 選擇 OpenAI Vision 如果：
- ✓ 文檔類型多樣化
- ✓ 需要快速部署
- ✓ 量級較小（< 10K/年）
- ✓ 不關心隱私
- ✓ 需要無維護的解決方案

### 選擇混合方案如果：
- ✓ 需要最優成本
- ✓ 需要最大靈活性
- ✓ 處理混合文檔類型
- ✓ 需要故障轉移能力

## 系統中的實現

本系統已實現 **MinerU 為主，OpenAI 為補充**：

```typescript
// drugAnalysisService.ts
async analyzePdfBytes(opts) {
  // 層級 1：MinerU OCR（必需）
  const markdown = await this.ocrPdfBytes(pdfBytes);
  
  // 層級 2：分析 LLM（可配置）
  // - OpenAI (gpt-4)
  // - Ollama (本地)
  // - vLLM (本地)
  const analysis = await this.runAnalysis(markdown);
  
  return { markdown, analysis };
}
```

## 建議

**對於本系統（Taiwan Health MCP）：**

1. **保持 MinerU 為主**
   - 已優化用於 TFDA 文檔
   - 成本效益最佳
   - 隱私優先

2. **可選添加 OpenAI Vision**
   - 作為質量檢查層
   - 處理例外情況
   - 驗證 OCR 準確度

3. **不要替代 MinerU**
   - OpenAI Vision 不如 MinerU 擅長表格
   - 對於大規模部署成本過高
   - 隱私風險不值得

## 參考資源

- MinerU GitHub: https://github.com/opendatalab/MinerU
- OpenAI Vision: https://platform.openai.com/docs/guides/vision
- TFDA 藥物標籤要求: https://www.fda.gov.tw/

---

**更新日期：** 2026-08-01  
**作者：** Taiwan Health MCP 團隊

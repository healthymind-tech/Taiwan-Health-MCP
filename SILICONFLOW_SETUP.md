# SiliconFlow 設定指南

## 概述

Taiwan Health MCP Server 現在支援 **SiliconFlow LLM 和 Embedding**，包括：
- **速率限制** (RPM/TPM)
- **負載平衡** (Load Balance) 
- **故障轉移** (Failover)

## 核心特性

### 1. SiliconFlow Provider
- **相容性**: OpenAI 兼容的 API 格式
- **Embedding**: 支援所有 SiliconFlow embedding 模型
- **LLM**: 支援所有 SiliconFlow 聊天完成模型

### 2. 速率限制 (RPM/TPM)

在每個 profile 的 `params` 中設定：

```json
{
  "rpm": 30,        // 每分鐘最多 30 個請求
  "tpm": 100000     // 每分鐘最多 100,000 個 tokens
}
```

**行為**:
- 檢查發生在每次 API 調用前
- 超限時會拋出錯誤，調用方可以重試
- 採用滑動窗口（過去 60 秒）

### 3. 故障轉移 (Failover) 和負載平衡 (Load Balance)

系統支援每個 `kind`（embedding / analysis）配置**多個 profiles**：

#### 設定方式 (Admin Console)

1. **Admin → Settings → LLM Profiles**
2. 新增多個 SiliconFlow profile（例如多個 API key 或端點）
3. 每個 profile 有：
   - `enabled`: 啟用/停用
   - `priority`: 優先級（數字越小優先級越高）
   - `weight`: 負載平衡的權重（僅在 `weighted` 策略下使用）

#### 策略選擇 (Admin Console)

**Settings → Embedding / Analysis** 中選擇：

- **Failover** (預設)
  - 嚴格按 `priority` 順序嘗試
  - 第一個成功的 profile 被使用
  - 故障的 profile 自動冷卻 60 秒，之後重試

- **Weighted**
  - 每次請求隨機選擇一個 profile（按 `weight` 概率）
  - 選中的 profile 故障時，自動轉移到其他可用的
  - 用於主動負載分散

## 使用範例

### 例子 1: 多個 SiliconFlow Embedding 端點（故障轉移）

| 名稱 | Provider | Base URL | Model | Priority | Enabled |
|------|----------|----------|-------|----------|---------|
| SiliconFlow-CN | siliconflow | https://api.siliconflow.cn/v1 | BAAI/bge-large-zh-v1.5 | 1 | ✓ |
| SiliconFlow-Backup | siliconflow | https://api-backup.siliconflow.cn/v1 | BAAI/bge-large-zh-v1.5 | 2 | ✓ |

**結果**: 主端點故障時，自動轉向備份

### 例子 2: 多個 API Key（負載平衡 + 速率限制）

| 名稱 | API Key | Priority | Weight | Params |
|------|---------|----------|--------|--------|
| API-Key-1 | sk_xxx1 | 1 | 50 | `{"rpm": 20, "tpm": 50000}` |
| API-Key-2 | sk_xxx2 | 1 | 50 | `{"rpm": 20, "tpm": 50000}` |

**結果**: 50/50 負載分散，每個 key 各限制 20 RPM

### 例子 3: 階層式 Fallback (主要 + 備份 + 低優先級)

```
優先級 1 (Primary):  SiliconFlow (RPM: 100, TPM: 500k)
優先級 2 (Secondary): OpenAI (RPM: 50, TPM: 250k)  
優先級 3 (Fallback):   Ollama Local (無限制)
```

## SiliconFlow API 設定

### 基本資訊

- **服務**: https://siliconflow.cn
- **API Base**: https://api.siliconflow.cn/v1
- **認證**: Bearer Token (`API_KEY`)

### 支援的 Embedding 模型

- `BAAI/bge-large-zh-v1.5` (1024-dim)
- `BAAI/bge-large-en-v1.5` (1024-dim)
- 其他 SiliconFlow 提供的 embedding 模型

### 支援的 LLM 模型

- `Qwen/Qwen2.5-72B-Instruct`
- `meta-llama/Llama-3.1-70B-Instruct`
- 其他 SiliconFlow 提供的模型

## Admin Console UI 變更

### 新增欄位

在 **LLM Profiles** 表單中：

1. **Provider** 下拉: 現已包含 `siliconflow`
2. **Params (JSON)** 欄位中可設定:
   ```json
   {
     "rpm": 30,
     "tpm": 100000,
     "dimensions": 1024
   }
   ```

## 故障排除

### 速率限制錯誤
```
Error: Rate limit: RPM limit (30) reached. Wait 45s.
```
→ 檢查 `rpm` 設定，或增加 RPM 值

### API 認證失敗
```
HTTP 401 from https://api.siliconflow.cn/v1/embeddings
```
→ 檢查 API Key 是否正確、是否過期

### 所有 profile 故障
```
All embedding profiles failed — falling back to keyword search
```
→ 檢查網路連線、endpoint URL、API key
→ 查看 Admin → Logs 中的詳細錯誤

## 監控

### Admin Console 指標

1. **Settings → Profile Stats** (待實裝)
   - 每個 profile 的成功率
   - 冷卻狀態
   - 速率限制使用率

2. **Logs → Profile Errors**
   - HTTP 錯誤
   - 超時
   - 速率限制事件

## API 細節

### 速率限制實現

使用滑動窗口（過去 60 秒）：
- 每次請求前檢查 RPM/TPM
- 記錄成功請求的時間戳和 token 數
- 過期記錄自動清理

### Profile 故障處理

1. **Circuit Breaker 機制**
   - 3 次連續失敗 → 進入冷卻（60 秒）
   - 冷卻期間不嘗試該 profile
   - 冷卻後自動重試
   - 成功則重置失敗計數

2. **Failover 邏輯**
   - 嘗試故障 profile 的下一個（按 priority）
   - 所有 profile 都故障時，返回 null（embedding 使用關鍵字搜尋）

## 環境變數 (不適用)

⚠️ **SiliconFlow 設定不從 `.env` 讀取** — 必須通過 Admin Console → Settings 配置。

這允許在執行時無需重啟即可更改端點和 API key。

## 資源限制建議

基於 SiliconFlow 的官方 API 限制：

| 方案 | RPM | TPM | 用途 |
|------|-----|-----|------|
| 免費層 | 5 | 50k | 開發/測試 |
| Pro | 30 | 500k | 中等負載 |
| Business | 100+ | 2M+ | 生產環境 |

## 相關檔案

- `src/rateLimiter.ts` - 速率限制實現
- `src/embeddingService.ts` - Embedding client
- `src/analysisLlmClient.ts` - LLM client
- `src/admin/llmProfiles.ts` - Profile 管理

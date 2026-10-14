# SiliconFlow 實現總結

## 新增功能

### 1. SiliconFlow Provider 支援 ✅

**files**:
- `src/embeddingService.ts` - 支援 SiliconFlow embedding API
- `src/analysisLlmClient.ts` - 支援 SiliconFlow chat completions
- `src/admin/adminSettings.ts` - SiliconFlow 端點驗證和模型列表

**特性**:
- OpenAI 兼容 API 格式
- 支援所有 SiliconFlow 模型
- 自動端點驗證和測試

### 2. 速率限制 (RPM/TPM) ✅

**files**:
- `src/rateLimiter.ts` - 新建速率限制器（滑動窗口）
- `src/admin/llmProfiles.ts` - params 驗證（rpm/tpm）

**特性**:
- 每個 profile 可設定 RPM（每分鐘請求數）和 TPM（每分鐘 token 數）
- 滑動窗口實現（過去 60 秒）
- 超限時拋出明確錯誤，支援重試

**使用**:
```json
{
  "rpm": 30,        // 限制每分鐘 30 個請求
  "tpm": 100000     // 限制每分鐘 100,000 個 tokens
}
```

### 3. 負載平衡和故障轉移 ✅

**已存在的系統** (無需修改):
- `src/admin/llmProfiles.ts` 中的 `candidateOrder()` 函數
- 支援 `priority` 和 `weight` 欄位
- 支援兩種策略: `failover` 和 `weighted`

**Failover 策略**:
- 按 `priority` 順序嘗試 profiles
- 故障 profile 進入 60 秒冷卻
- 自動恢復後重試

**Weighted 策略**:
- 按 `weight` 概率隨機選擇 profile
- 選中 profile 故障時自動轉移

## 使用流程

### Admin Console 配置

1. **Admin → Settings → LLM Profiles**
   
2. **新增 SiliconFlow Embedding Profile**:
   ```
   名稱: SiliconFlow-Embedding
   種類: embedding
   Provider: siliconflow
   Base URL: https://api.siliconflow.cn/v1
   API Key: sk_xxxxxxxxxxxx
   Model: BAAI/bge-large-zh-v1.5
   Enabled: ✓
   Priority: 1
   Weight: 1
   Params (JSON):
   {
     "rpm": 30,
     "tpm": 100000,
     "dimensions": 1024
   }
   ```

3. **新增 SiliconFlow LLM Profile** (類似):
   ```
   名稱: SiliconFlow-LLM
   種類: analysis
   Provider: siliconflow
   Base URL: https://api.siliconflow.cn/v1
   Model: Qwen/Qwen2.5-72B-Instruct
   Params:
   {
     "rpm": 20,
     "tpm": 500000
   }
   ```

4. **設定策略** (Admin → Settings → Embedding/Analysis):
   - **Strategy**: 選擇 `failover` 或 `weighted`

## 架構圖

```
應用層 (Tool Calls)
    ↓
embeddingService.ts / analysisLlmClient.ts
    ↓
[Rate Limiter 檢查]  ← 新增
    ↓
candidateOrder()
    ↓
[Failover/Weighted 策略] ← 既有
    ↓
providerEmbed() / callOneProfile()
    ↓
[記錄速率限制使用] ← 新增
    ↓
SiliconFlow API
```

## 代碼修改詳情

### rateLimiter.ts (新建)
- `canRequest()` - 檢查是否可以發送請求
- `waitUntilMs()` - 計算需要等待的時間
- `recordRequest()` - 記錄成功請求
- 滑動窗口實現，自動清理過期記錄

### embeddingService.ts
```typescript
// 現在支援 siliconflow provider
if (p.provider === "openai" || p.provider === "siliconflow") {
  // OpenAI 兼容的 API
}

// 調用前檢查速率限制
const { allowed, reason } = canRequest(p.id, limits);

// 調用後記錄使用
recordRequest(p.id, totalTokens);
```

### analysisLlmClient.ts
```typescript
// 支援 siliconflow provider (openai 兼容格式)
if (provider === "openai" || provider === "vllm" || provider === "siliconflow") {
  // OpenAI 兼容的 API 調用
}

// 相同的速率限制檢查和記錄邏輯
```

### llmProfiles.ts
```typescript
// 驗證 rpm/tpm 參數
if (params?.rpm !== undefined && !Number.isInteger(rpm) || rpm <= 0) {
  throw new ProfileValidationError("RPM must be a positive integer.");
}
```

### adminSettings.ts
```typescript
// 支援 siliconflow 的模型列表和測試
if (provider === "siliconflow" || provider === "openai") {
  return openaiModels(base, key);
}
```

## 測試清單

- [ ] Admin Console 中能否建立 SiliconFlow profile
- [ ] API 端點驗證通過
- [ ] 模型列表能否正確顯示
- [ ] RPM 限制生效
- [ ] TPM 限制生效
- [ ] Failover 轉移到備份端點
- [ ] Weighted 策略正確分散負載
- [ ] 故障 profile 自動冷卻和恢復
- [ ] Embedding 能否正常工作
- [ ] LLM 分析能否正常工作

## 下一步

1. **前端更新** (web/admin-app/)
   - LLM Profiles 表單中顯示 `rpm`/`tpm` 欄位
   - Profile Stats 頁面顯示速率限制使用情況

2. **監控和指標**
   - 新增 profile 故障率監控
   - 速率限制事件日誌
   - Prometheus 指標

3. **文檔**
   - 見 `SILICONFLOW_SETUP.md`

## 相容性

- ✅ 不破壞現有 OpenAI/Google/Ollama profiles
- ✅ 向後相容（rpm/tpm 為可選）
- ✅ 與現有 failover/weighted 策略相容

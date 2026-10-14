# Job Integrity Safeguards

系統級防護措施，確保 embedding 和其他 long-running jobs 不會在不完整時被標記為成功。

## 🎯 核心原則

1. **驗證完整性** - 必須驗證工作量和完成量
2. **自動重試** - 失敗自動重試，無需人工干預
3. **詳細日誌** - 記錄所有完成度異常
4. **告警通知** - 不完整完成立即告警

## ✅ Embedding Job 完成檢查

### 新規則（v1.0）

```
嵌入完成度檢查：
  
  completion_ratio = embedded_count / source_count
  
  100%:         ✓ SUCCESS (成功)
  95-99.9%:     ⚠ SUCCESS + 警告日誌 (可接受損失)
  <95%:         ✗ RETRYABLE_FAILED (自動重試)
```

### 實現位置

- **檔案**: `node-server/src/admin/adminJobs.ts` (Line 3102+)
- **函數**: `runEmbeddingJob()`
- **觸發點**: Job completion phase

### 詳細邏輯

```typescript
// 計算完成度
const completionRatio = embeddedCount / sourceCount;
const isIncomplete = embeddedCount < sourceCount;

// 定義閾值
const completionThreshold = 0.95; // 允許 5% 損失
const isPartiallyFailed = isIncomplete && 
                          completionRatio < completionThreshold;

// 根據比例決定狀態
if (completionRatio < 0.95) {
  status = "retryable_failed"  // 自動重試
} else if (completionRatio < 1.0) {
  status = "success"           // 成功 + 警告
} else {
  status = "success"           // 完美完成
}
```

## 🔄 自動重試機制

### Retryable Failed Job

```
最初失敗：
  status = 'retryable_failed'
  attempt_count = 1
  next_retry_at = NOW() + 2min

第二次失敗：
  attempt_count = 2
  next_retry_at = NOW() + 4min (指數退避)

第三次失敗：
  attempt_count = 3
  next_retry_at = NOW() + 8min

最多重試：5 次 (可配置)
```

### 重試失敗終止條件

- 達到最大重試次數 → 標記為 `failed` (停止重試)
- 遇到不可重試的錯誤 → 立即標記為 `failed`

## 📊 監控和告警

### 日誌記錄

**不完整完成時**:
```
ERROR: Embedding incomplete: 134096/373953 (35.9%) 
       — falling back to retryable failure
```

**部分損失時**:
```
WARN: Embedding slightly incomplete: 355000/373953 (95.1%) 
      — within acceptable threshold
```

### 結果摘要

```json
{
  "job_type": "snomed_embed",
  "module": "SNOMED CT",
  "embedded_count": 373953,
  "source_count": 373953,
  "completion_ratio": "100.0"
}
```

## 🛡️ 其他 Job 類型

### ICD Import / LOINC Import / 等

相同的完成度驗證邏輯應適用於所有批量 job：

```typescript
// 通用驗證函數（待實現）
function validateJobCompletion(jobType, processedCount, totalCount) {
  const ratio = processedCount / totalCount;
  
  if (ratio < 0.95) {
    return "retryable_failed"; // 自動重試
  } else if (ratio < 1.0) {
    return "success_with_warning";
  }
  return "success";
}
```

**待實現的 Job 類型**:
- `icd_import` - 診斷代碼導入
- `loinc_import` - 實驗室代碼導入
- `snomed_import` - SNOMED 代碼導入
- `food_nutrition_sync` - 食品營養同步
- `health_supplements_sync` - 健康補充品同步

## 📈 未來改進

### Phase 2
- [ ] 所有 job 類型應用相同的完成度檢查
- [ ] 添加 job 健康監控 dashboard
- [ ] 實現自動告警通知（Slack/Email）
- [ ] Job 超時檢測和中斷保護

### Phase 3
- [ ] 分布式 job 追蹤（支援多 worker）
- [ ] 部分失敗恢復（從最後 checkpoint 繼續）
- [ ] 並行 job 依賴管理
- [ ] Job 回滾支援（失敗時自動回滾數據）

## ✨ 即時保護

### 預防措施

1. **連接池監控** - 檢測連接斷開
2. **超時檢測** - Long-running job 添加心跳
3. **記憶體告警** - Embedding service OOM 保護
4. **速率限制** - RPM/TPM 防止過載

### 部署檢查清單

- [ ] 測試 embedding job 自動重試
- [ ] 驗證不完整 job 不標記為 success
- [ ] 檢查日誌是否記錄完成度異常
- [ ] 監控重試次數和延遲

## 相關檔案

- `node-server/src/admin/adminJobs.ts` - Job 完成邏輯
- `node-server/src/admin/adminWorker.ts` - Worker 執行邏輯
- `db/schema.sql` - `admin.import_jobs` schema

## 版本

- v1.0 - Embedding job 完成度檢查 (2026-10-15)
- v0.0 - 初始系統（有 bug）(2026-10-14)

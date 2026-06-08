# FHIR 伺服器工具 (FHIR Server Tools)

此類別工具用於探索與操作由管理後台登錄的**外部 FHIR R4 伺服器**。這些工具永遠註冊（不受資料模組載入狀態影響）。伺服器的新增 / 編輯、認證憑證與健康檢查設定皆在 Admin Console → FHIR Servers 完成；MCP 端只看到安全摘要，**絕不會**取得或傳遞 token、client secret、private key。

## list_fhir_servers
列出可用的外部 FHIR 伺服器，作為探索入口。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `include_disabled` | boolean | 否 | 是否納入已停用（`enabled=false`）的伺服器，預設 `false` |

### 回傳
`{count, servers: [...]}`。每筆 server 含 `server_key`（呼叫其他工具時請用此值）、`name`、`base_url`、`enabled`、`default`、`allowed_resource_types`、`allowed_operations`、`fhir_version`、`supported_resources`、`auth`（僅資訊性）與 `probe`（最近一次連線檢查結果）。

## get_fhir_server_status
取得**單一**伺服器的狀態與設定，欄位與 `list_fhir_servers` 相同。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `server_key` | string | 是 | 伺服器穩定識別碼（非 name） |

### 用途
在呼叫 `crud_fhir_server` 前先確認 `enabled=true` 且 `probe.ok=true`；若否，建議先做一次 `metadata` 操作或提醒使用者。

## crud_fhir_server
對指定伺服器執行 FHIR REST 操作。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `server_key` | string | 是 | 目標伺服器識別碼（`"default"` 對應預設伺服器） |
| `operation` | string | 是 | `metadata` / `read` / `search` / `create` / `update` / `patch` / `delete` |
| `resource_type` | string | 視操作 | FHIR 資源型別（如 `Patient`、`Observation`） |
| `resource_id` | string | 視操作 | 目標資源 ID（read / update / patch / delete） |
| `confirm_write` | boolean | 寫入時必填 | 寫入類操作（create / update / patch / delete）需 `true` 才會執行 |
| `token_strategy` | string | 否 | 覆寫該伺服器的預設 token 策略（`fresh` / `cached`） |

### 注意
- 操作與資源型別會受伺服器的 `allowed_operations` / `allowed_resource_types` 限制；不被允許者直接拒絕。
- 路徑由 `operation` / `resource_type` / `resource_id` 組成，呼叫端**不**直接傳遞 URL。
- OAuth token 由 MCP 伺服器代為處理，呼叫端不經手。

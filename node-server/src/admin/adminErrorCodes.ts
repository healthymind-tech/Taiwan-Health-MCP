/**
 * Operator-facing explanations for admin API errors (everything except the
 * LLM / model-endpoint API, which has its own `llmErrorCodes.ts`).
 *
 * The admin backend historically answers failures with an English `error`
 * (e.g. "Failed to create admin job") plus the raw exception text in `detail`
 * (a SQL error, "connect ECONNREFUSED …", "HTTP 404 from …"). The console
 * printed both verbatim. Rather than thread a code through every throw site,
 * `sendJson` passes every error body through `describeAdminError`, which adds
 *
 *   code        stable machine code (e.g. SOURCE_MISSING, DB_SCHEMA_OUTDATED)
 *   message_zh  what happened, in Traditional Chinese
 *   hint_zh     what the operator should do next
 *
 * The original `error` / `detail` fields stay untouched (backward compatible;
 * the console shows `detail` only under "技術細節").
 *
 * Classification order: a known English message (the `error`, or for a 4xx
 * the message itself) → the technical cause found in `detail` (Postgres error
 * text, network failure, object storage, upstream HTTP status) → a generic
 * fallback that still names the failed operation. Pure; `adminErrorCodes.test.ts`
 * pins the patterns against the real message strings.
 */

export interface AdminErrorInfo {
  code: string;
  message_zh: string;
  hint_zh?: string;
}

type Explain = (m: RegExpMatchArray) => AdminErrorInfo;
type Rule = [RegExp, Explain];

const RETRY_HINT = "請稍後再試；若持續發生，請到「服務健康」檢查資料庫與外部服務狀態，或查看 app 容器日誌。";
const MIGRATION_HINT =
  "資料庫結構比程式舊：請依檔名日期順序，手動套用 db/migrations/ 中尚未套用的 migration（部署文件「資料庫遷移」一節），再重試。";
const MINIO_HINT = "請到「外部服務 → 物件儲存（MinIO）」確認端點、帳密與 bucket，按「測試連線」成功後再重試。";

const info = (code: string, message_zh: string, hint_zh?: string): AdminErrorInfo =>
  hint_zh ? { code, message_zh, hint_zh } : { code, message_zh };

const MODULE_ZH: Record<string, string> = {
  icd: "ICD-10",
  loinc: "LOINC",
  snomed: "SNOMED CT",
  rxnorm: "RxNorm",
  drug: "藥品",
  ig: "FHIR IG",
  health_supplements: "健康食品",
  food_nutrition: "食品營養",
  umls: "UMLS",
};
const moduleLabel = (k: string): string => MODULE_ZH[k] ?? k;

/** Known English messages thrown by the admin modules (4xx validation + named failures). */
const MESSAGE_RULES: Rule[] = [
  // ── auth / security ──
  [/^Invalid username or password\.?$/, () => info("AUTH_INVALID", "帳號或密碼錯誤。", "請確認大小寫與鍵盤輸入法後再試一次。")],
  [/^Authentication required/, () => info("AUTH_REQUIRED", "登入已過期，請重新登入。")],
  [/^Passkey challenge expired/, () => info("PASSKEY_CHALLENGE_EXPIRED", "通行金鑰驗證已逾時。", "請重新按一次通行金鑰按鈕，並在 5 分鐘內完成驗證。")],
  [/^Passkey could not be verified/, () => info("PASSKEY_NOT_VERIFIED", "無法驗證這把通行金鑰。", "請確認使用的是已在「帳號安全」註冊的金鑰，或改用密碼登入。")],
  [/^Passkey registration failed/, () => info("PASSKEY_REGISTRATION_FAILED", "通行金鑰註冊失敗。", "請重試；若裝置不支援，請改用其他瀏覽器或安全金鑰。")],
  [/^Passkey not found\.?$/, () => info("PASSKEY_NOT_FOUND", "找不到這把通行金鑰（可能已被移除）。", "請重新整理頁面。")],
  [/^Failed to start passkey login/, () => info("PASSKEY_LOGIN_UNAVAILABLE", "目前無法使用通行金鑰登入。", "請改用帳號密碼登入。")],
  [/^Current password is incorrect\.?$/, () => info("PASSWORD_CURRENT_WRONG", "目前密碼不正確。", "請重新輸入目前使用的登入密碼。")],
  [/^New password is required\.?$/, () => info("PASSWORD_REQUIRED", "請輸入新密碼。")],
  [/^New password must be at least (\d+) characters/, (m) => info("PASSWORD_TOO_SHORT", `新密碼至少需要 ${m[1]} 個字元。`, "建議使用一段好記的長句，或密碼管理器產生的隨機密碼。")],
  [/^New password is too long\.?$/, () => info("PASSWORD_TOO_LONG", "新密碼太長（最多 512 字元）。")],

  // ── request shape ──
  [/^Body is not valid JSON/, () => info("INVALID_JSON", "送出的內容不是有效的 JSON。", "請檢查檔案或輸入是否完整（括號、逗號、引號）。")],
  [/^Unsupported admin job type/, () => info("JOB_TYPE_UNSUPPORTED", "不支援的背景工作類型。", "請重新整理頁面後再試；若仍發生，代表前後端版本不一致，請重新部署 web-v2 與 app。")],

  // ── sources / uploads ──
  [
    /^Missing uploaded source\(s\) for ([\w-]+): (.+)$/,
    (m) =>
      info(
        "SOURCE_MISSING",
        `${moduleLabel(m[1])} 尚未上傳必要的來源檔：${m[2]}。`,
        "請到該模組頁的「來源檔案」上傳對應檔案並設為啟用，再開始匯入。",
      ),
  ],
  [
    /^File type not allowed for ([\w-]+)\. Accepted: (.+)$/,
    (m) => info("SOURCE_FILE_TYPE", `這個來源（${m[1]}）不接受此檔案類型。`, `可接受的副檔名：${m[2]}。請確認上傳的是官方原始檔。`),
  ],
  [
    /^File content type rejected: Magika detected '([^']*)' but ([\w-]+) requires one of \[([^\]]*)\]/,
    (m) =>
      info(
        "SOURCE_CONTENT_MISMATCH",
        `檔案內容看起來是${m[1] === "unknown" ? "無法辨識的二進位檔" : `「${m[1]}」`}，不是 ${m[2]} 需要的格式。`,
        `需要的格式：${m[3]}。請確認沒有選錯檔案、檔案未損毀（重新下載官方檔案後再上傳）。`,
      ),
  ],
  [/^Unsupported module source: (.+)$/, (m) => info("SOURCE_ROLE_UNKNOWN", `不支援的來源類型：${m[1]}。`, "請重新整理頁面後再試。")],
  [/^CSV for ([\w-]+) is missing required column\(s\): (.+?)\. Expected header: (.+)\.$/, (m) => info("CSV_COLUMNS_MISSING", `${m[1]} 的 CSV 缺少必要欄位：${m[2]}。`, `第一列必須是欄位名稱，至少包含：${m[3]}。請確認選對檔案與分隔符號（逗號）。`)],
  [/^Archive for ([\w-]+) does not contain the expected file \((.+?)\)\. Found: (.*)$/s, (m) => info("SOURCE_ARCHIVE_WRONG", `這個壓縮檔不是 ${m[1]} 的官方發布檔：找不到 ${m[2]}。`, `壓縮檔內容：${m[3]}。請從官方網站重新下載完整的發布檔再上傳。`)],
  [/^CSV is empty/, () => info("CSV_EMPTY", "CSV 是空的（找不到標題列）。", "請確認上傳的是 TFDA 藥品許可證 CSV（36_2.csv）。")],
  [/^CSV is missing required column\(s\): (.+?)\. Expected/, (m) => info("CSV_COLUMNS_MISSING", `CSV 缺少必要欄位：${m[1]}。`, "需要 TFDA 藥品許可證檔的欄位（許可證字號、中文品名、英文品名）；請從 TFDA 開放資料重新下載 36_2.csv。")],
  [/^CSV has no data rows/, () => info("CSV_NO_ROWS", "CSV 沒有任何含「許可證字號」的資料列。", "請確認檔案內容完整，或重新下載。")],
  [/^This file has already been imported into the drug index/, () => info("SOURCE_ALREADY_IMPORTED", "這個檔案已經匯入過藥品索引。", "不需要重新上傳；如要更新資料請上傳較新的 36_2.csv。")],
  [/^MinIO is required for admin source uploads/, () => info("STORAGE_UNAVAILABLE", "物件儲存（MinIO）無法使用，檔案無法上傳。", MINIO_HINT)],
  [/^(Uploaded source|Uploaded file|Module source) not found/, () => info("SOURCE_NOT_FOUND", "找不到這個上傳檔（可能已被刪除）。", "請重新整理頁面。")],
  [/^Cannot delete while a (\w+) job is (\w+)\. Stop it in Jobs first\.?$/, (m) => info("SOURCE_IN_USE", `有一個 ${m[1]} 工作正在${statusZh(m[2])}，目前不能刪除來源檔。`, "請到「背景工作」停止該工作後再刪除。")],
  [/^Missing upload metadata/, () => info("UPLOAD_METADATA_MISSING", "上傳缺少模組或來源類型資訊。", "請從模組頁的「來源檔案」重新上傳。")],
  [/^(No file data provided|Upload body is empty)/, () => info("UPLOAD_EMPTY", "沒有收到檔案內容（檔案是空的或上傳中斷）。", "請重新選擇檔案上傳。")],
  [/^Upload exceeds max size/, () => info("UPLOAD_TOO_LARGE", "檔案超過上傳大小上限。", "請確認檔案是否正確；大型官方檔案可調高 ADMIN_MAX_UPLOAD_MB（.env）後重啟 app。")],
  [/^Supplement exceeds 64 MB/, () => info("UPLOAD_TOO_LARGE", "CodeSystem supplement 超過 64 MB 上限。")],
  [/^uploaded_file_id must be a UUID|^uploaded_file_id is required|^object_key or a valid uploaded_file_id is required/, () => info("UPLOAD_REFERENCE_INVALID", "找不到要匯入的上傳檔。", "請重新上傳檔案後再匯入。")],

  // ── jobs ──
  [/^Job not found\.?$|^Admin job not found/, () => info("JOB_NOT_FOUND", "找不到這個背景工作（可能已被清除）。", "請重新整理「背景工作」頁面。")],
  [/^Action '(\w+)' is not allowed for job status=(\w+)/, (m) => info("JOB_ACTION_NOT_ALLOWED", `工作目前是「${statusZh(m[2])}」，不能執行「${actionZh(m[1])}」。`, "請重新整理頁面查看最新狀態。")],
  [/^Selected source belongs to module '([\w-]+)', not '([\w-]+)'/, (m) => info("SOURCE_WRONG_MODULE", `選取的來源檔屬於 ${moduleLabel(m[1])}，不是 ${moduleLabel(m[2])}。`, "請在正確模組頁選擇來源檔。")],
  [/^Job type '([\w-]+)' must use module_key/, (m) => info("JOB_MODULE_MISMATCH", `工作類型 ${m[1]} 與模組不符。`, "請重新整理頁面後再試。")],
  [/^badly formed hexadecimal UUID string/, () => info("INVALID_ID", "識別碼格式不正確。", "請從清單重新選擇項目。")],

  // ── maintenance / module clear ──
  [/^Module '([\w-]+)' does not support maintenance mode/, (m) => info("MAINTENANCE_UNSUPPORTED", `${moduleLabel(m[1])} 不支援維護模式。`)],
  [/^Module '([\w-]+)' cannot be cleared/, (m) => info("MODULE_CLEAR_UNSUPPORTED", `${moduleLabel(m[1])} 不支援清除資料。`)],
  [/^A (\w+) job is (\w+)\. Stop it in Jobs before clearing this module/, (m) => info("MODULE_BUSY", `有一個 ${m[1]} 工作正在${statusZh(m[2])}，目前不能清除這個模組。`, "請到「背景工作」停止該工作後再清除。")],
  [/^Module '([\w-]+)' has no embeddings/, (m) => info("MODULE_NO_EMBEDDINGS", `${moduleLabel(m[1])} 沒有向量資料可清除。`)],

  // ── schedules ──
  [/^No schedule configured for this module/, () => info("SCHEDULE_NOT_FOUND", "這個模組還沒有排程。", "請先在「排程」區塊建立並儲存排程。")],
  [/^Schedule fetch_url must use HTTPS/, () => info("SCHEDULE_URL_NOT_HTTPS", "排程下載網址必須是 https://。", "請改用 HTTPS 網址（為避免伺服器端請求偽造）。")],
  [/^Unknown frequency/, () => info("SCHEDULE_FREQUENCY_INVALID", "排程頻率只能是每日、每週或每月。")],
  [/^No job type found for role/, () => info("SCHEDULE_ROLE_INVALID", "排程的來源類型不存在。", "請重新選擇來源類型後儲存。")],
  [/^(invalid int value|invalid literal for int\(\)|int\(\) argument must be)/, () => info("SCHEDULE_NUMBER_INVALID", "排程的時間欄位必須是整數。")],

  // ── settings ──
  [/^Unknown settings group: (.+)$/, (m) => info("SETTINGS_GROUP_UNKNOWN", `沒有「${m[1]}」這個設定群組。`, "請重新整理頁面。")],
  [/^([\w-]+)\.([\w-]+): '(.*)' is not one of (.+)$/s, (m) => info("SETTING_NOT_ALLOWED", `設定「${m[1]}.${m[2]}」的值「${m[3]}」不在允許的選項內。`, `允許的值：${m[4]}。`)],
  [/^([\w-]+)\.([\w-]+): '(.*)' is not a valid http\(s\) URL$/s, (m) => info("SETTING_URL_INVALID", `設定「${m[1]}.${m[2]}」不是有效的網址：${m[3]}。`, "請輸入以 http:// 或 https:// 開頭的完整網址。")],
  [/^([\w-]+)\.([\w-]+): '(.*)' is not (an integer|a number)$/s, (m) => info("SETTING_NOT_NUMBER", `設定「${m[1]}.${m[2]}」的值「${m[3]}」不是${m[4] === "an integer" ? "整數" : "數字"}。`, "請輸入數字；未修改任何設定。")],
  [/^([\w-]+)\.([\w-]+): (.*) is out of range \((.+)\.\.(.+)\)$/s, (m) => info("SETTING_OUT_OF_RANGE", `設定「${m[1]}.${m[2]}」的值 ${m[3]} 超出範圍。`, `允許範圍：${m[4]} 到 ${m[5]}。`)],
  [/^([\w-]+) is managed by the deployment/, (m) => info("SETTINGS_MANAGED_BY_ENV", `「${m[1]}」由部署設定（.env / compose）管理，無法在此修改。`, "請修改伺服器上的 .env 後重新啟動服務。")],
  [/^Unsupported settings export version: (.+)$/, (m) => info("SETTINGS_IMPORT_VERSION", `不支援的設定匯出檔版本：${m[1]}。`, "請使用本系統「備份與設定 → 匯出設定」產生的檔案（版本 1–3）。")],
  [/^Malformed export/, () => info("SETTINGS_IMPORT_MALFORMED", "這不是有效的設定匯出檔（缺少 groups 區塊）。", "請使用本系統「備份與設定 → 匯出設定」產生的 JSON 檔。")],
  [/^Unknown action '(.+)'$/, (m) => info("UNKNOWN_ACTION", `不支援的操作：${m[1]}。`, "請重新整理頁面。")],

  // ── backups ──
  [/^Backup not found\.?$/, () => info("BACKUP_NOT_FOUND", "找不到這個備份（可能已被清除）。", "請重新整理備份清單。")],
  [/^Backup is not ready for download/, () => info("BACKUP_NOT_READY", "這個備份尚未完成或建立失敗，無法下載。", "請等待備份工作完成；若失敗，請到「背景工作」查看原因後重新建立。")],
  [/^Backup artifact is invalid/, () => info("BACKUP_INVALID", "備份檔記錄不正確，無法下載。", "請重新建立一次備份。")],
  [/^Select at least one backup component/, () => info("BACKUP_NO_COMPONENT", "請至少選擇一個備份項目。")],
  [/^MinIO is required to store backup artifacts/, () => info("STORAGE_UNAVAILABLE", "物件儲存（MinIO）無法使用，備份無法儲存。", MINIO_HINT)],
  [/^Backup download failed/, () => info("BACKUP_DOWNLOAD_FAILED", "從物件儲存讀取備份檔失敗。", MINIO_HINT)],

  // ── FHIR servers / OAuth ──
  [/^FHIR server not found/, () => info("FHIR_SERVER_NOT_FOUND", "找不到這個 FHIR 伺服器（可能已被刪除）。", "請回到 FHIR 伺服器清單重新整理。")],
  [/^base_url must be an absolute HTTP\(S\) URL/, () => info("FHIR_BASE_URL_INVALID", "Base URL 必須是完整的 http(s) 網址。", "例如 https://hapi.fhir.org/baseR4。")],
  [/^base_url cannot include query string or fragment/, () => info("FHIR_BASE_URL_INVALID", "Base URL 不能包含 ? 查詢字串或 # 片段。", "只填伺服器根路徑，例如 https://example.org/fhir。")],
  [/^server_key must be 2-64 chars/, () => info("FHIR_SERVER_KEY_INVALID", "識別碼需為 2–64 個字元，只能使用英數字、點、底線或連字號。")],
  [/^name is required/, () => info("FIELD_REQUIRED", "請輸入名稱。")],
  [/^client_id is required/, () => info("FHIR_OAUTH_CLIENT_ID_REQUIRED", "OAuth2 需要 Client ID。")],
  [/^client_secret is required/, () => info("FHIR_OAUTH_SECRET_REQUIRED", "這個授權方式需要 Client Secret。")],
  [/^client_private_key \(PEM\) is required/, () => info("FHIR_OAUTH_KEY_REQUIRED", "private_key_jwt 需要私鑰（PEM）。", "可在表單按「產生金鑰」自動建立。")],
  [/^Provide token_endpoint, metadata_url, or auth_server_url for OAuth2/, () => info("FHIR_OAUTH_ENDPOINT_REQUIRED", "OAuth2 需要 Token 端點、Metadata URL 或授權伺服器網址其中一個。")],
  [/^Provide a metadata URL or auth server URL first/, () => info("FHIR_OAUTH_ENDPOINT_REQUIRED", "請先填入 Metadata URL 或授權伺服器網址，再執行自動探索。")],
  [/^default FHIR server must be enabled/, () => info("FHIR_DEFAULT_DISABLED", "預設 FHIR 伺服器必須是啟用狀態。", "請先啟用這台伺服器，再設為預設。")],
  [/^test_path must be a path relative/, () => info("FHIR_TEST_PATH_INVALID", "測試路徑必須是相對於 Base URL 的路徑（例如 metadata），不能是完整網址。")],
  [/^timeout_seconds must be an integer/, () => info("FIELD_INTEGER", "逾時秒數必須是整數。")],
  [/^resource_type must be a valid FHIR ResourceType/, () => info("FHIR_RESOURCE_TYPE_INVALID", "資源類型不是有效的 FHIR ResourceType（例如 Patient）。")],
  [/^resource_id must be a valid FHIR logical id/, () => info("FHIR_RESOURCE_ID_INVALID", "資源 ID 不是有效的 FHIR logical id（1–64 個英數字、- 或 .）。")],
  [/^(\w+) must be valid JSON/, (m) => info("INVALID_JSON", `${m[1]} 不是有效的 JSON。`, "請檢查括號、逗號與引號。")],
  [/^headers must be a JSON object/, () => info("FHIR_HEADERS_INVALID", "自訂標頭必須是 JSON 物件，例如 {\"X-Tenant\": \"a\"}。")],
  [/^custom headers cannot set Authorization/, () => info("FHIR_HEADERS_AUTH", "自訂標頭不能設定 Authorization。", "請改用「驗證」區塊設定 OAuth2。")],
  [/^Token request failed: (.*)$/s, (m) => oauthTokenFailure(m[1])],
  [/^Could not resolve the (token|authorization) endpoint/, (m) => info("FHIR_OAUTH_ENDPOINT_UNRESOLVED", `找不到 OAuth2 ${m[1] === "token" ? "Token" : "授權"}端點。`, "請直接填入端點網址，或確認 Metadata URL 能回傳 SMART / OpenID 設定。")],
  [/^Server is not configured for OAuth2|^Server does not use OAuth2/, () => info("FHIR_OAUTH_NOT_CONFIGURED", "這台伺服器沒有設定這種 OAuth2 授權方式。", "請先編輯伺服器的「驗證」設定。")],

  // ── IG / registry ──
  [/^IG not found/, () => info("IG_NOT_FOUND", "找不到這個 IG 套件（可能已被移除）。", "請重新整理 IG 套件庫。")],
  [/^Not a readable FHIR package/, () => info("IG_PACKAGE_INVALID", "這個檔案不是可讀取的 FHIR 套件。", "FHIR IG 套件是 .tgz，內含 package/package.json；請從 IG 發布頁或 packages.fhir.org 下載 package.tgz 後再上傳。")],
  [/^The package has no name\/version in package\/package.json/, () => info("IG_PACKAGE_NO_IDENTITY", "套件的 package/package.json 沒有 name 或 version。", "請確認上傳的是正式發布的套件（package.tgz），而不是原始碼或自行打包的檔案。")],
  [/^Uploaded IG file not found/, () => info("SOURCE_NOT_FOUND", "找不到這個上傳檔（可能已被刪除）。", "請重新上傳 .tgz。")],
  [/^IG package (\S+) is not available from the registry/, (m) => info("IG_PACKAGE_NOT_FOUND", `FHIR 套件 Registry 找不到 ${m[1]}。`, "請確認套件 ID 與版本拼字（可在新增 IG 的搜尋框查詢）；若套件未公開發布，請改為上傳 package.tgz。")],
  [/^package_id is required for registry import/, () => info("IG_PACKAGE_ID_REQUIRED", "請輸入要從 Registry 匯入的套件 ID。")],
  [/^source must be 'registry' or 'upload'/, () => info("IG_SOURCE_INVALID", "匯入來源只能是 Registry 或上傳檔。")],
  [/^Registry search failed/, () => info("REGISTRY_UNREACHABLE", "無法查詢 FHIR 套件 Registry。", "請確認伺服器能連上網際網路，或到「外部服務 → FHIR Registry」確認網址；也可以直接上傳 .tgz。")],

  // ── MCP 工具 playground (adminMcp.ts) ──
  [/^unknown_tool$/, () => info("UNKNOWN_TOOL", "沒有這個 MCP 工具。", "請從「工具目錄」選擇工具；工具名稱可能已變更，請重新整理頁面。")],
  [/^tool_disabled$/, () => info("TOOL_DISABLED", "這個工具目前未啟用（模組資料不足或服務未就緒）。", "到「工具目錄」查看停用原因，依提示匯入資料後再試。")],
  [/^arguments_must_be_a_json_object$/, () => info("INVALID_ARGUMENTS", "參數必須是 JSON 物件，例如 {\"keyword\": \"diabetes\"}。")],
  [/^rate_limited$/, () => info("RATE_LIMITED", "執行太頻繁（每分鐘上限 60 次）。", "請稍候一分鐘再試。")],
  [/^write_confirmation_required$/, () => info("WRITE_CONFIRMATION_REQUIRED", "這個呼叫會寫入外部 FHIR 伺服器，需要先確認。", "請在測試台勾選寫入確認（輸入伺服器識別碼）後再送出。")],

  [/^HTTP (\d{3}) from \S*\/file_parse/, (m) => info("OCR_HTTP_ERROR", `OCR 伺服器（MinerU）回應 HTTP ${m[1]}${m[1] === "504" ? "（處理逾時）" : ""}。`, m[1] === "504" ? "大型 PDF 可能超過 MinerU 前端代理的逾時；請調高代理逾時或檢查 MinerU 負載，再重試失敗項目。" : "請查看 MinerU 的日誌，修正後再重試失敗項目。")],

  // ── drug pipeline preconditions (drugAnalysisService readiness) ──
  [/^OCR (server|base URL) is not configured yet/, () => info("OCR_NOT_CONFIGURED", "尚未設定 OCR 伺服器（MinerU），藥品仿單無法辨識。", "請到「外部服務 → OCR」填入 MinerU 網址並按「測試連線」，成功後再重試。")],
  [/^Analysis LM is not configured yet/, () => info("ANALYSIS_LM_NOT_CONFIGURED", "尚未設定分析 LLM，藥品仿單無法分析。", "請到「模型端點」建立模型帳號，並把一個路由指定給「分析」角色後再重試。")],
  [/^Analysis prompt not found/, () => info("ANALYSIS_PROMPT_MISSING", "找不到分析用的系統提示詞檔（src/prompts/）。", "部署映像缺少 src/prompts/，請重新建置 app 與 admin-worker 映像。")],
  [/^Unsupported OCR provider: (.+)$/, (m) => info("OCR_PROVIDER_UNSUPPORTED", `不支援的 OCR 服務類型「${m[1]}」。`, "請到「外部服務 → OCR」改為 MinerU。")],
  [/^Profile '(.+)': unsupported provider '(.+)'$/, (m) => info("ANALYSIS_PROVIDER_UNSUPPORTED", `分析路由裡的「${m[1]}」使用了不支援分析的供應商（${m[2]}）。`, "請到「模型端點」把它換成支援聊天模型的帳號。")],
  [/^MinIO not configured/, () => info("STORAGE_UNAVAILABLE", "物件儲存（MinIO）無法使用。", MINIO_HINT)],

  // ── worker job failures (adminJobs.ts last_error_message) ──
  [
    /^Required service\(s\) not healthy: (.+?)\. Run an active service probe/,
    (m) =>
      info(
        "SERVICE_DEPENDENCY_DOWN",
        `必要的服務目前無法使用：${m[1].split(", ").map(serviceZh).join("、")}。`,
        "請到「服務健康」查看錯誤原因並修正（OCR / MinIO 在「外部服務」、分析 LLM 在「模型端點」），再按「重新執行」。",
      ),
  ],
  [/^(.+) has no loaded records\. Import, sync, or seed the module before embedding/, (m) => info("EMBED_NO_RECORDS", `${m[1]} 還沒有資料，無法建立向量。`, "請先完成該模組的匯入或同步，再執行嵌入。")],
  [/^No admin adapter registered for job type '(.+)'/, (m) => info("JOB_TYPE_NO_HANDLER", `Worker 不認得工作類型 ${m[1]}。`, "admin-worker 映像可能比 app 舊：請重新建置並部署 admin-worker。")],
  [/requires 'packages' in job_options|requires 'package_id' in job_options|requires 'object_key' in job_options/, () => info("JOB_OPTIONS_MISSING", "工作缺少必要參數（套件或上傳檔）。", "請從 IG 套件庫重新開始匯入。")],
  [/^no active umls_metathesaurus source/, () => info("SOURCE_MISSING", "尚未上傳 UMLS 檔案。", "請在 IG 套件庫的概念索引面板上傳 UMLS 檔並啟用，再開始匯入。")],
  [/^MinIO is required to read the uploaded IG package/, () => info("STORAGE_UNAVAILABLE", "物件儲存（MinIO）無法使用，讀不到上傳的 IG 套件。", MINIO_HINT)],

  // ── drug / misc ──
  [/^Drug service not available/, () => info("DRUG_SERVICE_UNAVAILABLE", "藥品服務尚未就緒。", "請確認已匯入藥品索引；若剛部署，請稍候數秒再重新整理。")],
  [/^Drug not found/, () => info("DRUG_NOT_FOUND", "找不到這個藥品許可證。", "請回到藥品總覽重新搜尋。")],
  [/^Asset file is missing from object storage/, () => info("ASSET_MISSING", "物件儲存中找不到這個檔案（可能已被清除）。", "請重新執行該藥品的「資料補全」以重新下載仿單與圖片。")],
  [/^Asset not found or has no stored content/, () => info("ASSET_NOT_FOUND", "這個檔案尚未下載。", "請先執行藥品「資料補全」。")],
  [/^LLM call not found/, () => info("LLM_CALL_NOT_FOUND", "找不到這筆模型呼叫紀錄（可能已被清除）。")],
  [/^Sample not found/, () => info("SAMPLE_NOT_FOUND", "找不到這個範例檔。")],
  [/^Unsupported service probe keys?/, () => info("PROBE_KEY_UNKNOWN", "不支援的服務探測項目。", "請重新整理頁面。")],
];

/** Technical causes recognised inside a raw exception text (`detail`). */
const CAUSE_RULES: Rule[] = [
  [/relation "([^"]+)" does not exist/, (m) => info("DB_SCHEMA_OUTDATED", `資料庫缺少資料表 ${m[1]}。`, MIGRATION_HINT)],
  [/column "([^"]+)"(?: of relation "([^"]+)")? does not exist/, (m) => info("DB_SCHEMA_OUTDATED", `資料庫缺少欄位 ${m[2] ? `${m[2]}.` : ""}${m[1]}。`, MIGRATION_HINT)],
  [/(?:type|function) "?([\w.]+)"? does not exist/, (m) => info("DB_SCHEMA_OUTDATED", `資料庫缺少 ${m[1]}。`, MIGRATION_HINT)],
  [/duplicate key value violates unique constraint/, () => info("DB_DUPLICATE", "相同的資料已經存在。", "請重新整理頁面確認是否已建立；要修改請編輯既有項目。")],
  [/violates foreign key constraint/, () => info("DB_REFERENCE", "這筆資料仍被其他項目使用，或引用的項目已不存在。", "請重新整理頁面；若要刪除，請先移除引用它的項目。")],
  [/violates (?:not-null|check) constraint/, () => info("DB_CONSTRAINT", "資料不符合資料庫的限制（缺少必要欄位或值不允許）。", "請檢查輸入的欄位後再試。")],
  [/invalid input syntax for type (\w+)/, (m) => info("DB_INVALID_INPUT", `有欄位的格式不正確（需要 ${m[1]}）。`, "請檢查輸入的數字、日期或識別碼格式。")],
  [/value too long for type/, () => info("DB_VALUE_TOO_LONG", "有欄位的內容太長。", "請縮短輸入內容後再試。")],
  [/canceling statement due to statement timeout|query_wait_timeout/, () => info("DB_TIMEOUT", "資料庫查詢逾時。", "請縮小查詢範圍後重試；若持續發生，可能有大型匯入正在執行。")],
  [/deadlock detected|could not serialize access/, () => info("DB_CONFLICT", "與另一個同時進行的操作衝突。", "請稍候幾秒再試一次。")],
  [/too many clients|remaining connection slots|Connection terminated|connection.*(?:refused|reset).*5432|no more connections allowed/i, () => info("DB_UNAVAILABLE", "暫時無法連線到資料庫。", "請稍候再試；若持續發生，請確認 postgres / pgbouncer 容器正在執行。")],
  [/MinIO|S3Error|NoSuchBucket|NoSuchKey|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/, () => info("STORAGE_UNAVAILABLE", "物件儲存（MinIO）無法使用。", MINIO_HINT)],
  [/HTTP (40[13])\b/, (m) => info("UPSTREAM_AUTH", `外部服務拒絕授權（HTTP ${m[1]}）。`, "請確認該服務的帳號、金鑰或權杖是否正確、仍有效。")],
  [/HTTP 404\b/, () => info("UPSTREAM_NOT_FOUND", "外部服務回應找不到（HTTP 404）。", "請確認設定的網址與路徑正確，以及目標資源仍存在。")],
  [/HTTP 429\b/, () => info("UPSTREAM_RATE_LIMITED", "外部服務限制請求頻率（HTTP 429）。", "請稍候幾分鐘再試。")],
  [/HTTP 5\d\d\b/, () => info("UPSTREAM_ERROR", "外部服務發生錯誤（HTTP 5xx）。", "這是對方伺服器的問題，請稍後再試。")],
  [/\bbad port\b/i, () => info("UPSTREAM_PORT_BLOCKED", "這個連接埠被 Node.js 的安全規則封鎖（例如 9、25 等保留埠），無法連線。", "請改用服務實際監聽的一般連接埠（例如 8000）。")],
  [/OCR markdown is empty/, () => info("OCR_EMPTY", "OCR 沒有辨識出任何文字。", "仿單 PDF 可能是空白或純影像品質太差；可在「外部服務 → OCR」用該檔測試，或改用其他解析方式後重試。")],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/, () => info("UPSTREAM_DNS", "無法解析外部服務的主機名稱。", "請確認網址拼字正確，且伺服器的 DNS 能解析該主機。")],
  [/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|socket hang up|fetch failed|other side closed|All connection attempts failed/, () => info("UPSTREAM_UNREACHABLE", "無法連線到外部服務。", "請確認網址與連接埠正確、服務正在執行，且 app 容器的網路能連到它。")],
  [/ETIMEDOUT|timed? ?out|TimeoutError|aborted due to timeout/i, () => info("UPSTREAM_TIMEOUT", "外部服務在時限內沒有回應。", "請確認服務負載與網路；必要時調高逾時設定後再試。")],
  [/certificate|self[- ]signed|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS/i, () => info("UPSTREAM_TLS", "外部服務的 TLS 憑證無法驗證。", "請確認對方使用有效的憑證，或改用正確的主機名稱。")],
  [/Unexpected token .* in JSON|is not valid JSON|JSON at position/, () => info("UPSTREAM_BAD_RESPONSE", "收到的內容不是預期的 JSON。", "請確認網址指向正確的服務（而不是網頁或錯誤頁）。")],
];

/** zh-TW label for the operation named by a "Failed to …" message. */
const OPERATION_ZH: Array<[RegExp, string]> = [
  [/create admin job|create restart job/, "建立背景工作"],
  [/apply job control/, "控制背景工作"],
  [/list admin jobs|load admin job|load job (steps|logs)/, "讀取背景工作"],
  [/persist uploaded source/, "儲存上傳檔"],
  [/(activate|deactivate|delete) module source/, "變更來源檔"],
  [/set maintenance mode/, "切換維護模式"],
  [/list worker heartbeats/, "讀取 Worker 狀態"],
  [/service probes/, "執行服務探測"],
  [/IG|CodeSystem supplement|concept index|dependenc|uploaded package/i, "處理 IG 套件"],
  [/FHIR server|keypair|OAuth|token/i, "處理 FHIR 伺服器"],
  [/settings|Settings operation/i, "處理系統設定"],
  [/schedule/i, "處理排程"],
  [/clear module/, "清除模組資料"],
  [/drug|Drug/, "讀取藥品資料"],
  [/sample/i, "讀取範例檔"],
  [/version history/, "讀取版本紀錄"],
  [/admin overview/, "載入儀表板"],
  [/Preview failed/, "載入資料預覽"],
  [/mcp_admin_failed/, "處理 MCP 工具"],
  [/OCR test/, "OCR 測試"],
];

function operationZh(error: string): string | null {
  for (const [re, zh] of OPERATION_ZH) if (re.test(error)) return zh;
  return null;
}

function serviceZh(k: string): string {
  return ({ minio: "物件儲存（MinIO）", ocr_server: "OCR（MinerU）", analysis_server: "分析 LLM", embedding_model: "Embedding", database: "資料庫", redis: "Redis" } as Record<string, string>)[k] ?? k;
}

function statusZh(s: string): string {
  return ({ queued: "排隊中", running: "執行中", paused: "暫停中", pausing: "暫停中", stopping: "停止中", succeeded: "已完成", success: "已完成", failed: "失敗", cancelled: "已取消", stopped: "已停止" } as Record<string, string>)[s] ?? s;
}

function actionZh(a: string): string {
  return ({ pause: "暫停", resume: "繼續", stop: "停止", restart: "重新執行" } as Record<string, string>)[a] ?? a;
}

/** An OAuth token request failed: say whether the server refused or could not be reached. */
function oauthTokenFailure(text: string): AdminErrorInfo {
  const cause = classifyCause(text);
  if (cause?.code === "UPSTREAM_AUTH" || /invalid_client|invalid_grant|unauthorized_client|HTTP 400\b/.test(text)) {
    return info("FHIR_OAUTH_TOKEN_REJECTED", "授權伺服器拒絕發給權杖。", "請確認 Client ID / Secret（或私鑰）、scope 與 Token 端點；授權伺服器的回應見技術細節。");
  }
  if (cause) return info("FHIR_OAUTH_TOKEN_FAILED", `取得權杖失敗：${cause.message_zh}`, cause.hint_zh);
  return info("FHIR_OAUTH_TOKEN_FAILED", "向授權伺服器取得權杖失敗。", "請確認 Token 端點與授權設定；授權伺服器的回應見技術細節。");
}

function match(rules: Rule[], text: string): AdminErrorInfo | null {
  for (const [re, explain] of rules) {
    const m = re.exec(text);
    if (m) return explain(m);
  }
  return null;
}

/** Classify a raw technical error text (SQL / network / storage / upstream HTTP). */
export function classifyCause(text: string): AdminErrorInfo | null {
  return text ? match(CAUSE_RULES, text) : null;
}

/** Explain a known English admin message, without falling back to cause rules. */
export function classifyMessage(text: string): AdminErrorInfo | null {
  return text ? match(MESSAGE_RULES, text.trim()) : null;
}

/**
 * Describe an error response body. Returns null when the body already carries
 * a code (LLM API, IG removal, MODULE_MAINTENANCE …) or is not an error.
 */
export function describeAdminError(status: number, error: string, detail?: string): AdminErrorInfo {
  const known = classifyMessage(error);
  if (known) return known;
  // 4xx messages are usually self-contained validation errors.
  if (detail) {
    const cause = classifyCause(detail);
    if (cause) {
      const op = operationZh(error);
      return { ...cause, message_zh: op ? `${op}失敗：${cause.message_zh}` : cause.message_zh };
    }
  }
  const causeInError = classifyCause(error);
  if (causeInError) return causeInError;
  const op = operationZh(error);
  if (status === 404) return info("NOT_FOUND", op ? `${op}失敗：找不到指定的項目。` : "找不到指定的項目（可能已被刪除）。", "請重新整理頁面。");
  if (status === 409) return info("CONFLICT", op ? `${op}失敗：與目前狀態衝突。` : "與目前狀態衝突。", "請重新整理頁面查看最新狀態後再試。");
  if (status === 503) return info("SERVICE_UNAVAILABLE", op ? `${op}失敗：相關服務暫時無法使用。` : "相關服務暫時無法使用。", RETRY_HINT);
  if (status >= 500) return info("INTERNAL_ERROR", op ? `${op}時發生未預期的錯誤。` : "伺服器發生未預期的錯誤。", RETRY_HINT);
  return info("INVALID_REQUEST", op ? `${op}失敗：輸入內容不正確。` : "輸入內容不正確。", "請檢查表單欄位；原始訊息見技術細節。");
}

/**
 * Add `code` / `message_zh` / `hint_zh` to an outgoing error body (status ≥ 400)
 * that has an `error` string and no `code` yet. Other bodies pass through.
 */
export function enrichErrorBody(status: number, payload: unknown): unknown {
  if (status < 400 || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (body.code !== undefined || body.message_zh !== undefined) return payload;
  const error = typeof body.error === "string" ? body.error : "";
  if (!error) return payload;
  if (error === "database_unavailable") return payload; // handled by the console's DB-health overlay
  const detail = typeof body.detail === "string" ? body.detail : undefined;
  const d = describeAdminError(status, error, detail);
  return { ...body, code: d.code, message_zh: d.message_zh, ...(d.hint_zh ? { hint_zh: d.hint_zh } : {}) };
}


/** The minimal heartbeat shape needed to decide whether any worker is alive. */
export interface HeartbeatLike {
  stale: boolean;
}

/**
 * Warning attached to a response that queued a background job while no
 * admin-worker is heartbeating: the job is safely queued but will not start.
 */
export function workerOfflineWarning(workers: HeartbeatLike[]): AdminErrorInfo | null {
  if (workers.some((w) => !w.stale)) return null;
  return info(
    "WORKER_OFFLINE",
    workers.length === 0 ? "工作已排入佇列，但目前沒有任何背景 Worker 回報心跳，工作不會開始執行。" : "工作已排入佇列，但所有背景 Worker 都已失聯，工作不會開始執行。",
    "請啟動 admin-worker 容器（docker compose up -d admin-worker）；Worker 上線後會自動接手排隊中的工作，不需重新建立。",
  );
}

// ── 外部服務 connection tests (OCR / MinIO / TFDA) ─────────────────────────────

export interface ServiceTestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
  code?: string;
  params?: Record<string, unknown>;
  message_zh?: string;
  hint_zh?: string;
}

const SERVICE_ZH: Record<string, { label: string; where: string }> = {
  ocr: { label: "OCR（MinerU）", where: "請確認 MinerU 服務正在執行，Base URL 為其根網址（例如 http://mineru:8000，不含 /file_parse），且 app 容器能連到它。" },
  minio: { label: "物件儲存（MinIO）", where: "請確認端點（host:port，不含 http://）、Access / Secret Key 與 bucket 名稱，以及是否需要勾選 TLS。" },
  tfda: { label: "TFDA 網站", where: "請確認 Base URL 正確，且伺服器能連上網際網路（TFDA 偶爾維護，可稍後再試）。" },
};

/**
 * Add zh-TW `message_zh` / `hint_zh` to a settings connection test result. The
 * raw English `message` is kept (shown as technical detail). Results that already
 * carry a `code` (embedding diagnosis) are left alone.
 */
export function explainServiceTest(group: string, r: ServiceTestResult): ServiceTestResult {
  if (r.code || r.message_zh) return r;
  const svc = SERVICE_ZH[group];
  if (!svc) return r;
  const msg = String(r.message ?? "");
  if (r.ok) {
    let m: RegExpMatchArray | null;
    if ((m = /^MinerU (\S+) reachable at (\S+?)\.?$/.exec(msg))) return { ...r, message_zh: `已連線到 MinerU ${m[1]}（${m[2]}）。` };
    if ((m = /^Connected; bucket '(.+)' available\.?$/.exec(msg))) return { ...r, message_zh: `連線成功，bucket「${m[1]}」可以使用。` };
    if ((m = /^GET (\S+) → HTTP (\d+) in (\d+) ms\.?$/.exec(msg))) return { ...r, message_zh: `連線成功：${m[1]} 回應 HTTP ${m[2]}（${m[3]} ms）。` };
    return { ...r, message_zh: `${svc.label}連線測試成功。` };
  }
  if (/^(Base URL is (empty|required))/.test(msg)) return { ...r, code: "SERVICE_URL_MISSING", message_zh: `請先填入${svc.label}的網址。`, hint_zh: svc.where };
  if (/not reachable \/ bucket missing/.test(msg)) return { ...r, code: "SERVICE_CONFIG_INCOMPLETE", message_zh: `${svc.label}設定不完整（端點、帳密與 bucket 都必須填寫）。`, hint_zh: svc.where };
  let m = /reports status '(.+)'/.exec(msg);
  if (m) return { ...r, code: "SERVICE_UNHEALTHY", message_zh: `${svc.label}有回應，但回報狀態為「${m[1]}」。`, hint_zh: "服務本身尚未就緒（模型載入中或發生錯誤），請查看 MinerU 的日誌後再試。" };
  if (group === "tfda" && (m = /HTTP (\d{3})/.exec(msg))) return { ...r, code: "UPSTREAM_ERROR", message_zh: `TFDA 網站回應 HTTP ${m[1]}。`, hint_zh: svc.where };
  const cause = classifyCause(msg);
  if (cause) {
    const hint =
      cause.code === "UPSTREAM_PORT_BLOCKED" || cause.code === "UPSTREAM_TLS"
        ? (cause.hint_zh ?? svc.where)
        : cause.code === "UPSTREAM_NOT_FOUND" && group === "ocr"
          ? "找不到 /health：Base URL 可能多了路徑或指到其他服務。" + svc.where
          : svc.where;
    return { ...r, code: cause.code, message_zh: `${svc.label}連線測試失敗：${cause.message_zh}`, hint_zh: hint };
  }
  if (group === "minio" && /Access Denied|InvalidAccessKeyId|SignatureDoesNotMatch|S3Error/i.test(msg)) {
    return { ...r, code: "STORAGE_AUTH", message_zh: "MinIO 拒絕這組帳密或權限不足。", hint_zh: svc.where };
  }
  return { ...r, code: "SERVICE_TEST_FAILED", message_zh: `${svc.label}連線測試失敗。`, hint_zh: svc.where };
}

/**
 * zh-TW explanation for a failed job's `last_error_message` (worker side), or
 * null when the message is not recognised (the console then shows it as is).
 */
export function explainJobError(message: string | null | undefined): AdminErrorInfo | null {
  const m = String(message ?? "").trim();
  if (!m) return null;
  return classifyMessage(m) ?? classifyCause(m);
}

/** Add `last_error_zh` / `last_error_hint_zh` to a job dict that has a recognised error. */
export function withJobErrorExplanation<T extends { last_error_message?: string | null }>(job: T): T {
  const e = explainJobError(job.last_error_message);
  if (!e) return job;
  return { ...job, last_error_zh: e.message_zh, ...(e.hint_zh ? { last_error_hint_zh: e.hint_zh } : {}) };
}

// ── 服務健康 probe rows ─────────────────────────────────────────────────────────

export interface ProbeRowLike {
  service_key: string;
  status: string;
  message: string;
  details?: Record<string, unknown>;
}

const PROBE_FIX: Record<string, string> = {
  database: "請確認 postgres / pgbouncer 容器正在執行。",
  redis: "請確認 redis 容器正在執行；Redis 只影響即時事件，資料不受影響。",
  minio: MINIO_HINT,
  ocr_server: "請到「外部服務 → OCR」確認 MinerU 網址並按「測試連線」。",
  embedding_model: "請到「模型端點」確認 Embedding 角色的路由與帳號。",
  analysis_server: "請到「模型端點」確認分析角色的路由與帳號。",
};

/**
 * zh-TW `message_zh` / `hint_zh` for a service probe row (ok rows get a short
 * zh line; failing rows say why and where to fix it). Rows with an LLM issue
 * code are explained by the console's model-endpoint translations instead.
 */
export function explainProbe<T extends ProbeRowLike>(row: T): T & { message_zh?: string; hint_zh?: string } {
  const msg = String(row.message ?? "");
  const fix = PROBE_FIX[row.service_key];
  const out = (message_zh: string, hint_zh?: string) => ({ ...row, message_zh, ...(hint_zh ? { hint_zh } : {}) });
  if (msg === "No cached probe result yet.") return out("尚未探測過。", "按「探測」立即檢查。");
  if (row.status === "ok") {
    if (msg === "SELECT 1 succeeded.") return out("資料庫連線正常。");
    if (msg === "Redis PING succeeded.") return out("Redis 連線正常。");
    let m = /^Bucket (.+) reachable\.$/.exec(msg);
    if (m) return out(`Bucket「${m[1]}」可以存取。`);
    m = /^OCR server reachable \((.+)\)\.$/.exec(msg);
    if (m) return out(`OCR 伺服器連線正常（${m[1]}）。`);
    return row;
  }
  if (/is not configured yet/.test(msg)) return out("尚未設定。", fix);
  // Model-endpoint rows carry their own issue codes (llmErrorCodes) — leave them to that layer.
  if (row.service_key === "embedding_model" || row.service_key === "analysis_server") return row;
  if (msg === "MinIO disabled by configuration.") return out("物件儲存已停用；上傳、藥品資產與備份都無法使用。", MINIO_HINT);
  if (msg === "MinIO service has not been initialized.") return out("物件儲存尚未初始化。", MINIO_HINT);
  if (/^Unsupported OCR provider/.test(msg)) return out("不支援的 OCR 服務類型。", fix);
  const cause = classifyCause(msg);
  if (cause) return out(cause.message_zh, fix ?? cause.hint_zh);
  if (row.status === "error") return out("探測失敗。", fix);
  return row;
}

/** zh-TW `detail_zh` / `hint_zh` for the dashboard's infrastructure entries (adminOverview). */
export function explainInfrastructure(
  infra: Record<string, { status: string; detail: string }>,
): Record<string, { status: string; detail: string; detail_zh?: string; hint_zh?: string }> {
  const out: Record<string, { status: string; detail: string; detail_zh?: string; hint_zh?: string }> = {};
  for (const [key, v] of Object.entries(infra)) {
    if (key === "mcp") {
      out[key] = v;
      continue;
    }
    const d = String(v.detail ?? "");
    let zh: string | undefined;
    let hint: string | undefined;
    if (d === "PostgreSQL reachable") zh = "資料庫連線正常";
    else if (d === "Redis reachable") zh = "Redis 連線正常";
    else if (/^Bucket: /.test(d)) zh = `Bucket「${d.slice(8)}」可以存取`;
    else if (v.status !== "ok") {
      const e = explainProbe({
        service_key: key === "ocr" ? "ocr_server" : key,
        status: v.status,
        message: d === "MinIO service not initialized" ? "MinIO service has not been initialized." : d === "MinIO disabled by configuration" ? "MinIO disabled by configuration." : d,
      });
      zh = e.message_zh;
      hint = e.hint_zh ?? PROBE_FIX[key === "ocr" ? "ocr_server" : key];
    }
    out[key] = { ...v, ...(zh ? { detail_zh: zh } : {}), ...(hint ? { hint_zh: hint } : {}) };
  }
  return out;
}

// ── FHIR server connection test / probe ───────────────────────────────────────

interface StepLike {
  name?: string;
  status?: string;
  message?: string;
  message_zh?: string;
  hint_zh?: string;
  [k: string]: unknown;
}

/** zh-TW text for one connection-workflow message (step or overall). */
function fhirMessageZh(msg: string): { message_zh: string; hint_zh?: string } | null {
  const m0 = msg.trim();
  if (!m0) return null;
  const fixed: Record<string, string> = {
    "Using stored access token": "使用已儲存的存取權杖。",
    "Authorization metadata discovered": "已取得授權伺服器設定（metadata）。",
    "Metadata discovery disabled or not configured": "未啟用或未設定授權 metadata 探索。",
    "Client Credentials access token acquired": "已取得 Client Credentials 存取權杖。",
    "OAuth2 is disabled for this server": "此伺服器未使用 OAuth2。",
    "FHIR CapabilityStatement reachable": "可讀取 FHIR CapabilityStatement（/metadata）。",
    "Full connection workflow succeeded": "完整連線流程皆通過。",
  };
  if (fixed[m0]) return { message_zh: fixed[m0] };
  if (/^Save the server and click Authorize before probing/.test(m0)) {
    return { message_zh: "這台伺服器使用 OAuth2 授權碼流程，尚未授權。", hint_zh: "請先儲存伺服器，再按「授權」完成登入後重新探測。" };
  }
  let m = /^Test path reachable \(HTTP (\d+)\)/.exec(m0);
  if (m) return { message_zh: `測試路徑可以連線（HTTP ${m[1]}）。` };
  m = /^(?:FHIR )?(metadata|test path|Test path) HTTP (\d+)/i.exec(m0);
  if (m) {
    const code = Number(m[2]);
    const what = /metadata/i.test(m[1]) ? "/metadata" : "測試路徑";
    if (code === 0) return { message_zh: `連不到 ${what}。`, hint_zh: "請確認 Base URL、連接埠與網路。" };
    if (code === 401 || code === 403)
      return { message_zh: `伺服器拒絕存取 ${what}（HTTP ${code}）。`, hint_zh: "請確認驗證方式、權杖 scope 與 audience；需要 OAuth2 時請在「驗證」區塊設定。" };
    if (code === 404)
      return { message_zh: `伺服器找不到 ${what}（HTTP 404）。`, hint_zh: "Base URL 應是 FHIR 根路徑（例如 https://example.org/fhir 或 …/baseR4），請勿包含資源類型。" };
    if (code >= 500) return { message_zh: `FHIR 伺服器發生錯誤（HTTP ${code}）。`, hint_zh: "這是對方伺服器的問題，請稍後再試或聯絡其管理者。" };
    return { message_zh: `${what} 回應 HTTP ${code}。`, hint_zh: "請確認 Base URL 與伺服器設定。" };
  }
  const known = classifyMessage(m0);
  if (known) return { message_zh: known.message_zh, hint_zh: known.hint_zh };
  const cause = classifyCause(m0);
  if (cause) return { message_zh: cause.message_zh, hint_zh: cause.hint_zh };
  if (/^Invalid URL/.test(m0)) return { message_zh: "Base URL 不是有效的網址。", hint_zh: "請輸入完整的 http(s) 網址。" };
  return null;
}

/**
 * Add `message_zh` / `hint_zh` to a FHIR connection test / probe result
 * (`probe.message` and each workflow step). Original fields are kept.
 */
export function explainFhirConnection<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  const probe = r.probe as Record<string, unknown> | undefined;
  if (!probe || typeof probe !== "object") return result;
  const zh = fhirMessageZh(String(probe.message ?? ""));
  const details = (probe.details ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(details.steps)
    ? (details.steps as StepLike[]).map((s) => {
        const z = fhirMessageZh(String(s.message ?? ""));
        return z ? { ...s, ...z } : s;
      })
    : details.steps;
  return {
    ...r,
    probe: { ...probe, ...(zh ?? {}), details: { ...details, ...(steps !== undefined ? { steps } : {}) } },
  } as T;
}

/** Add `last_probe_error_zh` (+ hint) to a FHIR server row with a stored probe error. */
export function withFhirProbeErrorExplanation<T extends { last_probe_error?: unknown }>(server: T): T {
  const msg = typeof server.last_probe_error === "string" ? server.last_probe_error : "";
  const z = msg ? fhirMessageZh(msg) : null;
  if (!z) return server;
  return { ...server, last_probe_error_zh: z.message_zh, ...(z.hint_zh ? { last_probe_error_hint_zh: z.hint_zh } : {}) };
}

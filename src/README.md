# src/

這個目錄**已不再包含程式碼**。

後端在 2026-07 全面遷移到 Node.js / TypeScript 之後，原本的 `src/*.py`
（MCP 伺服器、各服務、管理後台、loader）全部移除，改由 `node-server/src/` 取代。

目前 `src/` 只剩下一項執行期資產：

| 路徑 | 用途 |
|------|------|
| `src/prompts/drug/analysis_prompt.txt` | 藥品仿單分析 LLM 的 system prompt。由 `node-server/src/drugAnalysisService.ts` 在執行期讀取，`Dockerfile.worker` 會把它 COPY 進 worker 映像，路徑可用 `DRUG_ANALYSIS_PROMPT_PATH` 覆寫。 |

**請勿刪除 `src/prompts/`** —— 藥品分析階段會在執行期讀取它。

後端程式碼請見 [`node-server/`](../node-server/README.md)。

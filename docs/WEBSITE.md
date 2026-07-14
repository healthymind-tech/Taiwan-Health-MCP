# 文件網站（GitHub Pages）

本文件網站由 **MkDocs + Material** 產生，並自動發佈到 GitHub Pages。

## 組成

| 項目 | 位置 |
|------|------|
| 內容來源 | `docs/`（全部為 Markdown） |
| 網站設定與導覽 | `mkdocs.yml`（`nav` 區塊） |
| 建置產物 | `site/`（**由 mkdocs 產生，未納入 git，請勿手動編輯**） |
| 部署工作流程 | `.github/workflows/deploy-docs.yml` |
| 發佈網址 | <https://healthymind-tech.github.io/Taiwan-Health-MCP> |

> MkDocs 會建置 `docs/` 底下**所有** `.md`，即使它沒有出現在 `nav` 裡。
> 也就是說，沒掛在導覽上的檔案仍然會公開發佈（只是沒有連結入口）。

## 本機預覽

文件工具鏈與專案執行期無關（專案本身已無 Python 相依）：

```bash
pip install mkdocs mkdocs-material pymdown-extensions
mkdocs serve          # http://127.0.0.1:8000
mkdocs build --strict # 驗證：任何警告都視為錯誤
```

> `requirements-docs.txt` 額外列了 `mkdocs-minify-plugin` 與
> `mkdocs-git-revision-date-localized-plugin`，但這兩個**未在 `mkdocs.yml` 啟用、
> 也不在 CI 安裝清單中**。安裝它們不會改變輸出。

## 部署流程

`.github/workflows/deploy-docs.yml`：

1. **觸發條件**：push 到 `main`，且變更包含 `docs/**`、`mkdocs.yml` 或該 workflow 自身。
   （只改 `README.md` 或程式碼**不會**觸發網站重建。）
2. **建置**：Python 3.11，安裝 `mkdocs mkdocs-material pymdown-extensions mike`，執行 `mkdocs build`。
3. **發佈**：`peaceiris/actions-gh-pages@v3` 把 `./site` 推送到 **`gh-pages` 分支**（需要 `contents: write` 權限，使用內建的 `GITHUB_TOKEN`）。

未設定自訂網域（無 `CNAME`）。`.nojekyll` 由 `peaceiris/actions-gh-pages` 自動寫入發佈分支，不需在倉庫中維護。

## 內容維護原則

- **程式碼是唯一事實來源。** 文件與程式不符時，改文件，不要為了符合文件而改程式。
- 新增頁面後，記得在 `mkdocs.yml` 的 `nav` 加上入口，否則使用者找不到它（但它仍會被發佈）。
- 不要編輯 `site/`（產物）。
- 指令範例要能從文中指定的目錄直接執行；埠號請用 `:8080`（nginx 前門），不要用 `:8000`。
- 已完成或被取代的規劃文件，請在開頭加上狀態標註（本站的歷史文件都採此作法），不要直接刪除——它們是決策紀錄。
- 對外的公開頁面（`/`、`/status`、`/privacy`、`/dpa`）**不在這個網站上**，它們由 `web` 服務提供，內容在 `web/legacy/*.html`。

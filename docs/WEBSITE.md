# 文件網站（GitHub Pages）

本文件網站由 **MkDocs + Material** 產生，並自動發佈到 GitHub Pages。網站為**繁體中文 / 英文雙語**。

## 組成

| 項目 | 位置 |
|------|------|
| 內容來源（繁中） | `docs/**/<page>.md` |
| 內容來源（英文） | `docs/**/<page>.en.md` |
| 網站設定與導覽 | `mkdocs.yml`（`nav` 與 `plugins.i18n`） |
| 語言切換 shim | `docs/javascripts/lang-switch.js` |
| 建置產物 | `site/`（**由 mkdocs 產生，未納入 git，請勿手動編輯**） |
| 部署工作流程 | `.github/workflows/deploy-docs.yml` |
| 發佈網址 | <https://healthymind-tech.github.io/Taiwan-Health-MCP> |

> MkDocs 會建置 `docs/` 底下**所有** `.md`，即使它沒有出現在 `nav` 裡。
> 也就是說，沒掛在導覽上的檔案仍然會公開發佈（只是沒有連結入口）。

---

## 雙語規則（最重要）

!!! danger "改內容時，中英兩份必須同時改"
    每一頁都以**兩個檔案**存在：`<page>.md`（繁體中文）與 `<page>.en.md`（英文）。

    **任何內容變更都必須同時套用到兩個檔案，並放在同一個 commit 裡。**
    只改一邊會讓兩種語言悄悄發散——而且因為啟用了 `fallback_to_default`，
    缺漏的翻譯不會報錯、只會默默顯示中文版，問題會被隱藏很久。

    新增頁面時，一次就要建立 `.md` 與 `.en.md` 兩個檔案，並在 `mkdocs.yml`
    的 `nav` 加上入口、在 `nav_translations` 加上對應的英文標題。

檢查有沒有漏掉翻譯：

```bash
# 列出只有中文、缺英文版的頁面
comm -23 \
  <(find docs -name '*.md' ! -name '*.en.md' | sed 's/\.md$//' | sort) \
  <(find docs -name '*.en.md' | sed 's/\.en\.md$//' | sort)
```

目前預期的輸出只有這三頁：`docs/datasets`、`docs/MinerU-vs-OpenAI`、`docs/ocr-test-setup`。
它們**不在 `nav` 內、也沒有任何頁面連結到它們**（`datasets.md` 開頭甚至自述為過時的
Python 時代文件），因此尚未翻譯；英文站會以 fallback 顯示中文原文。
**除此之外任何出現在輸出裡的項目，都代表漏翻，要補。**

## 語言與網址

| 語言 | 網址 |
|------|------|
| 繁體中文（預設） | `https://healthymind-tech.github.io/Taiwan-Health-MCP/<page>/` |
| 英文 | `https://healthymind-tech.github.io/Taiwan-Health-MCP/en/<page>/` |

由 [`mkdocs-static-i18n`](https://ultrabug.github.io/mkdocs-static-i18n/) 以 `docs_structure: suffix`
模式產生兩棵靜態網站樹。Material 主題右上角的語言切換器由外掛自動產生。

### 用 URL parameter 切換

除了切換器之外，任何頁面都可以加上 `?lang=` 參數：

| 參數 | 效果 |
|------|------|
| `?lang=en` | 切到英文版 |
| `?lang=zh-TW` | 切到繁體中文版 |

例如 `.../Taiwan-Health-MCP/deployment/?lang=en` 會導向 `.../Taiwan-Health-MCP/en/deployment/`。

實作在 `docs/javascripts/lang-switch.js`：GitHub Pages 是純靜態、無法依 query string 路由，
所以由前端讀取參數後 `location.replace()` 到對應路徑，並把參數從網址移除。
`zh`、`zh-hant`、`tw`、`en-US` 等常見寫法都會被正規化。

> 各語言的**正式網址仍是路徑形式**（`/` 與 `/en/`）；`?lang=` 只是入口，
> 搜尋引擎索引與深層連結都用正式網址。

## 本機預覽

文件工具鏈與專案執行期無關（專案本身已無 Python 相依）：

```bash
pip install -r requirements-docs.txt
mkdocs serve          # http://127.0.0.1:8000
mkdocs build --strict # 驗證：任何警告都視為錯誤
```

只建置單一語言以加快迭代：

```bash
mkdocs build --strict -f mkdocs.yml   # 兩種語言
# 或在 mkdocs.yml 的 i18n 設定暫時加上 build_only_locale: en
```

## 部署流程

`.github/workflows/deploy-docs.yml`：

1. **觸發條件**：push 到 `main`，且變更包含 `docs/**`、`mkdocs.yml` 或該 workflow 自身。
   （只改 `README.md` 或程式碼**不會**觸發網站重建。）
2. **建置**：Python 3.11，安裝 `requirements-docs.txt`，執行 `mkdocs build --strict`。
3. **發佈**：`peaceiris/actions-gh-pages@v3` 把 `./site` 推送到 **`gh-pages` 分支**（需要 `contents: write` 權限，使用內建的 `GITHUB_TOKEN`）。

未設定自訂網域（無 `CNAME`）。`.nojekyll` 由 `peaceiris/actions-gh-pages` 自動寫入發佈分支，不需在倉庫中維護。

## 已知限制

- **搜尋索引是兩種語言共用的。** `mkdocs-static-i18n` 只產生一份合併後的
  `search_index.json`，因此在英文站搜尋也可能出現中文頁面的結果（反之亦然）。
  外掛只會移除內容完全相同的重複項（也就是尚未翻譯、fallback 的頁面）。
- MkDocs 對**純中文標題**產生的錨點 id 是 `_1`、`_2` 這類流水號，且會隨標題增減而位移。
  需要被連結的中文標題請用 `attr_list` 明確指定 id：

  ```markdown
  ## 對外埠與強化 { #external-ports }
  ```

## 內容維護原則

- **改內容時中英兩份一起改**（見上方雙語規則）。
- **程式碼是唯一事實來源。** 文件與程式不符時，改文件，不要為了符合文件而改程式。
- 新增頁面後，記得在 `mkdocs.yml` 的 `nav` 加上入口，否則使用者找不到它（但它仍會被發佈）。
- 不要編輯 `site/`（產物）。
- 指令範例要能從文中指定的目錄直接執行；埠號請用 `:8080`（nginx 前門），不要用 `:8000`。
- 已完成或被取代的規劃文件，請在開頭加上狀態標註（本站的歷史文件都採此作法），不要直接刪除——它們是決策紀錄。
- 對外的公開頁面（`/`、`/status`、`/privacy`、`/dpa`）**不在這個網站上**，它們由 `web` 服務提供，內容在 `web/legacy/*.html`。

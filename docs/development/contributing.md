# 貢獻指南

## 提交流程 (Pull Request)
1. Fork 本專案到您的 GitHub 帳號。
2. 建立新的分支：`git checkout -b feature/your-feature-name`
3. 提交修改：`git commit -m "feat: Add new drug search filter"`
4. 推送分支：`git push origin feature/your-feature-name`
5. 在 GitHub 上發起 Pull Request (PR)。

## Commit Message 規範
請遵循 [Conventional Commits](https://www.conventionalcommits.org/) 規範：
- `feat`: 新功能
- `fix`: 修復 Bug
- `docs`: 文件修改
- `refactor`: 程式碼重構 (無功能變動)

## 文件變更

文件網站為雙語。每一頁都以 `<page>.md`（繁體中文）與 `<page>.en.md`（英文）兩個檔案存在，
**兩者必須在同一個 commit 內一起更新**。詳見[文件網站維護](../WEBSITE.md)。

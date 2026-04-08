# 安裝問題

### Q: 啟動後工具回傳 "service not available"？
**A**: 這表示對應服務的資料尚未載入。請執行 data-loader，例如：
```bash
docker compose --profile loader run --rm data-loader --icd      # ICD-10 資料
docker compose --profile loader run --rm data-loader --loinc    # LOINC 資料
docker compose --profile loader run --rm data-loader --fda      # FDA 藥品/健康食品/營養
```
SNOMED CT 和 RxNorm 載入前需先下載原始授權檔案，請參閱 `config/datasets.yaml`。

### Q: Docker 容器一直重啟 (Restarting)？
**A**:
1. 檢查記憶體分配是否足夠（建議至少 4GB）。
2. 檢查日誌 (`docker compose logs app`) 是否有 Python 拋出的例外錯誤。
3. 確認 PostgreSQL 容器已正常啟動，且 `DATABASE_URL` 設定正確。
4. 確認埠號 (8000) 未被佔用。

### Q: 為什麼第一次資料載入這麼慢？
**A**: SNOMED CT（RF2 zip）和 RxNorm 包含數十萬筆記錄，載入需 5-15 分鐘屬正常現象。ICD-10、LOINC 等載入時間均在 1-3 分鐘以內。載入完成後重啟伺服器時服務啟動迅速，因為資料已存放於 PostgreSQL。

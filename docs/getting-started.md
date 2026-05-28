# 快速開始

## 啟動服務

```bash
cp .env.example .env
cp config/datasets.example.yaml config/datasets.yaml
docker compose up -d
```

## 載入資料

```bash
docker compose --profile loader run --rm data-loader --all
```

或依需求個別載入：

```bash
docker compose --profile loader run --rm data-loader --icd
docker compose --profile loader run --rm data-loader --loinc
docker compose --profile loader run --rm data-loader --twcore
docker compose --profile loader run --rm data-loader --guideline
docker compose --profile loader run --rm data-loader --snomed
docker compose --profile loader run --rm data-loader --health-food
docker compose --profile loader run --rm data-loader --food-nutrition
```

## 驗證

```bash
python -m pytest tests/test_tools_fhir.py -v
python -m pytest tests/test_dataset_resolver.py -v
```

"""Unit tests for Phase 1 drug record normalization helpers."""

from datetime import datetime

from drug_record_builder import (
    build_drug_record,
    build_index_only_record,
    is_active_index_row,
    normalize_license_token,
    split_index_text,
)


def test_split_index_text_handles_common_separators():
    assert split_index_text("退燒；止痛、消炎;鎮咳") == ["退燒", "止痛", "消炎", "鎮咳"]


def test_normalize_license_token_strips_non_alnum():
    assert normalize_license_token("衛署藥製字第000480號") == "000480"


def test_is_active_index_row_uses_cancellation_fields():
    assert is_active_index_row({"註銷狀態": "", "註銷日期": ""}) is True
    assert is_active_index_row({"註銷狀態": "已註銷", "註銷日期": ""}) is False


def test_build_index_only_record_matches_canonical_shape():
    row = {
        "許可證字號": "衛署藥製字第000480號",
        "註銷狀態": "",
        "註銷日期": "",
        "註銷理由": "",
        "有效日期": "2028/12/31",
        "發證日期": "2008/01/01",
        "許可證種類": "製劑",
        "舊證字號": "",
        "通關簽審文件編號": "ABC123",
        "中文品名": "測試藥品",
        "英文品名": "Test Drug",
        "適應症": "退燒；止痛",
        "劑型": "錠劑",
        "包裝": "盒裝",
        "藥品類別": "醫師藥師藥劑生指示藥品",
        "管制藥品分類級別": "",
        "主成分略述": "Acetaminophen；Caffeine",
        "申請商名稱": "申請商A",
        "申請商地址": "台北市",
        "申請商統一編號": "12345678",
        "製造商名稱": "製造商B",
        "製造廠廠址": "新北市",
        "製造廠公司地址": "新北市公司地址",
        "製造廠國別": "TW",
        "製程": "委託製造",
        "異動日期": "2025/05/01",
        "用法用量": "每次一錠；每日三次",
        "包裝與國際條碼": "4710000000000",
    }

    record = build_index_only_record(row, normalized_at=datetime(2026, 1, 1))

    assert record["license_no"] == "衛署藥製字第000480號"
    assert record["source"]["primary_insert_source"] == "index_only"
    assert record["drug"]["chinese_name"] == "測試藥品"
    assert record["drug"]["indications"] == ["退燒", "止痛"]
    assert record["ingredients"]["active"][0]["name"] == "Acetaminophen"
    assert record["usage"]["dosage_and_administration"] == ["每次一錠", "每日三次"]
    assert record["appearance"]["records"] == []
    assert record["quality"]["confidence"] == "low"


def test_build_drug_record_includes_minio_locators():
    row = {
        "許可證字號": "衛署藥製字第000480號",
        "註銷狀態": "",
        "註銷日期": "",
        "註銷理由": "",
        "有效日期": "2028/12/31",
        "發證日期": "2008/01/01",
        "許可證種類": "製劑",
        "舊證字號": "",
        "通關簽審文件編號": "",
        "中文品名": "測試藥品",
        "英文品名": "Test Drug",
        "適應症": "退燒",
        "劑型": "錠劑",
        "包裝": "盒裝",
        "藥品類別": "醫師藥師藥劑生指示藥品",
        "管制藥品分類級別": "",
        "主成分略述": "Acetaminophen",
        "申請商名稱": "申請商A",
        "申請商地址": "台北市",
        "申請商統一編號": "12345678",
        "製造商名稱": "製造商B",
        "製造廠廠址": "新北市",
        "製造廠公司地址": "新北市公司地址",
        "製造廠國別": "TW",
        "製程": "委託製造",
        "異動日期": "2025/05/01",
        "用法用量": "每次一錠",
        "包裝與國際條碼": "",
    }
    electronic_insert = {
        "source_url": "https://mcp.fda.gov.tw/im_detail_1/x",
        "basic_info": {"中文品名": "測試藥品"},
        "sections": {"儲存方式": ["室溫保存"], "用法用量": ["每次一錠"]},
        "ingredients": {"成分": [{"成分": "Acetaminophen", "含量": "500", "單位": "mg"}]},
        "atc_codes": [{"ATC Code": "N02BE01", "ATC名稱": "Acetaminophen"}],
        "label_pdfs": [],
        "history_pdfs": [],
        "public_pdfs": [],
        "paper_pdfs": [],
        "manufacturers": [],
    }
    insert_assets = [
        {
            "asset_type": "insert_pdf",
            "normalized_filename": "insert-2025-01-01.pdf",
            "source_filename": "insert.pdf",
            "upload_date": "2025-01-01",
            "source_url": "https://example.com/insert.pdf",
            "bucket": "drug-assets",
            "object_key": "drug/L001/insert/asset/insert.pdf",
            "minio_uri": "minio://drug-assets/drug/L001/insert/asset/insert.pdf",
            "is_latest_for_analysis": False,
        }
    ]
    label_assets = [
        {
            "asset_type": "label_pdf",
            "normalized_filename": "label-2025-01-01.pdf",
            "source_filename": "label.pdf",
            "upload_date": "2025-01-01",
            "source_url": "https://example.com/label.pdf",
            "bucket": "drug-assets",
            "object_key": "drug/L001/label/asset/label.pdf",
            "minio_uri": "minio://drug-assets/drug/L001/label/asset/label.pdf",
        }
    ]
    appearance_records = [
        {
            "shape_id": "shape-1",
            "appearance_no": "A001",
            "description": "白色圓形錠",
            "color": "白色",
            "shape": "圓形",
            "scoring": "",
            "symbol": "",
            "size": "10mm",
            "imprint": "A1",
            "raw_json": {"外觀編號": "A001"},
            "images": [
                {
                    "normalized_filename": "shape-1_image_01.jpg",
                    "source_filename": "shape.jpg",
                    "upload_date": "2025-01-01",
                    "source_url": "https://example.com/shape.jpg",
                    "bucket": "drug-assets",
                    "object_key": "drug/L001/shape/asset/shape.jpg",
                    "minio_uri": "minio://drug-assets/drug/L001/shape/asset/shape.jpg",
                }
            ],
        }
    ]

    record = build_drug_record(
        row,
        electronic_insert=electronic_insert,
        insert_assets=insert_assets,
        label_assets=label_assets,
        appearance_records=appearance_records,
        source_errors=[],
    )

    assert record["source"]["primary_insert_source"] == "electronic_insert"
    assert record["source"]["has_pdf_insert"] is True
    assert record["insert_content"]["insert_documents"][0]["minio"]["bucket"] == "drug-assets"
    assert record["packaging_and_labeling"]["label_documents"][0]["minio"]["uri"].startswith("minio://")
    assert record["appearance"]["records"][0]["images"][0]["minio"]["object_key"].endswith("shape.jpg")
    assert record["quality"]["confidence"] in {"high", "medium"}


def test_build_drug_record_prefers_pdf_analysis_when_present():
    row = {
        "許可證字號": "衛署藥製字第000481號",
        "註銷狀態": "",
        "註銷日期": "",
        "註銷理由": "",
        "有效日期": "2028/12/31",
        "發證日期": "2008/01/01",
        "許可證種類": "製劑",
        "舊證字號": "",
        "通關簽審文件編號": "",
        "中文品名": "測試藥品二號",
        "英文品名": "Test Drug 2",
        "適應症": "退燒",
        "劑型": "錠劑",
        "包裝": "盒裝",
        "藥品類別": "醫師藥師藥劑生指示藥品",
        "管制藥品分類級別": "",
        "主成分略述": "Acetaminophen",
        "申請商名稱": "申請商A",
        "申請商地址": "台北市",
        "申請商統一編號": "12345678",
        "製造商名稱": "製造商B",
        "製造廠廠址": "新北市",
        "製造廠公司地址": "新北市公司地址",
        "製造廠國別": "TW",
        "製程": "委託製造",
        "異動日期": "2025/05/01",
        "用法用量": "每次一錠",
        "包裝與國際條碼": "",
    }
    analysis = {
        "藥品特性": "白色圓形錠",
        "有效成分及含量": [{"成分": "Acetaminophen", "含量": "500 mg"}],
        "其他成分": [{"成分": "Lactose", "含量": "10 mg"}],
        "用途(適應症)": ["退燒"],
        "使用上注意事項": {
            "有下列情形者，請勿使用": [],
            "有下列情形者，使用前請洽醫師診治": [],
            "有下列情形者，使用前請先諮詢醫師藥師藥劑生": [],
            "其他使用上注意事項": ["不可過量"],
        },
        "用法用量": ["每次一錠"],
        "警語": {
            "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生": [],
            "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治": [],
        },
        "儲存方式": ["室溫保存"],
    }
    insert_assets = [
        {
            "asset_type": "insert_pdf",
            "normalized_filename": "insert-2025-01-02.pdf",
            "source_filename": "insert.pdf",
            "upload_date": "2025-01-02",
            "source_url": "https://example.com/insert.pdf",
            "bucket": "drug-assets",
            "object_key": "drug/L002/insert/asset/insert.pdf",
            "minio_uri": "minio://drug-assets/drug/L002/insert/asset/insert.pdf",
            "is_latest_for_analysis": True,
        }
    ]

    record = build_drug_record(
        row,
        electronic_insert=None,
        analysis=analysis,
        insert_assets=insert_assets,
        label_assets=[],
        appearance_records=[],
        source_errors=[],
    )

    assert record["source"]["primary_insert_source"] == "pdf_insert"
    assert record["source"]["used_latest_pdf"] is True
    assert record["ingredients"]["active"][0]["amount"] == "500 mg"
    assert record["storage"] == ["室溫保存"]
    assert record["quality"]["confidence"] in {"high", "medium"}

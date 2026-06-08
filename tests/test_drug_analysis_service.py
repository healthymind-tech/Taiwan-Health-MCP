from pathlib import Path

from drug_analysis_service import (
    DrugAnalysisConfig,
    DrugAnalysisService,
    normalize_analysis_data,
    validate_analysis_shape,
)


def test_normalize_analysis_data_converts_keys_and_ingredients():
    data = {
        "药品特性": ["白色錠劑", "圓形"],
        "有效成分及含量": [{"name": "Acetaminophen", "amount": "500 mg"}],
        "其他成分": "Lactose 10 mg",
        "用途(适应症)": "退燒",
        "使用上注意事项": {"其他使用上注意事項": "不可過量"},
        "用法用量": "每次一錠",
        "警语": {
            "使用本药后，若有发生以下症状时，请立即停止使用，并接受医师诊治": "呼吸困難"
        },
        "储存方式": "室溫保存",
    }

    normalized = normalize_analysis_data(data)

    assert normalized["藥品特性"] == "白色錠劑；圓形"
    assert normalized["有效成分及含量"] == [{"成分": "Acetaminophen", "含量": "500 mg"}]
    assert normalized["其他成分"] == [{"成分": "Lactose", "含量": "10mg"}]
    assert normalized["用途(適應症)"] == ["退燒"]
    assert normalized["用法用量"] == ["每次一錠"]
    assert normalized["儲存方式"] == ["室溫保存"]
    assert normalized["警語"]["使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治"] == [
        "呼吸困難"
    ]


def test_validate_analysis_shape_rejects_extra_fields():
    payload = {
        "藥品特性": "",
        "有效成分及含量": [],
        "其他成分": [],
        "用途(適應症)": [],
        "使用上注意事項": {
            "有下列情形者，請勿使用": [],
            "有下列情形者，使用前請洽醫師診治": [],
            "有下列情形者，使用前請先諮詢醫師藥師藥劑生": [],
            "其他使用上注意事項": [],
        },
        "用法用量": [],
        "警語": {
            "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生": [],
            "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治": [],
        },
        "儲存方式": [],
        "額外欄位": "x",
    }

    errors = validate_analysis_shape(payload)

    assert any("多出欄位: 額外欄位" in error for error in errors)


def test_analysis_readiness_uses_bundled_prompt_files():
    prompts_dir = Path(__file__).resolve().parents[1] / "src" / "prompts" / "drug"
    config = DrugAnalysisConfig(
        ocr_provider="dots_ocr",
        ocr_vllm_server_ip="127.0.0.1",
        ocr_vllm_port=8002,
        ocr_model_name="Qwen/Qwen2.5-VL-7B-Instruct",
        ocr_prompt_mode="prompt_layout_all_en",
        ocr_prompt_path=prompts_dir / "prompt_layout_all_en.txt",
        analysis_provider="openai",
        analysis_base_url="http://127.0.0.1:8001/v1",
        analysis_model_name="qwen2.5:7b",
        analysis_api_key="0",
        analysis_prompt_path=prompts_dir / "analysis_prompt.txt",
        analysis_temperature=0.1,
        analysis_max_tokens=4096,
        analysis_max_retries=3,
    )

    service = DrugAnalysisService(config)
    ready, reason = service.analysis_readiness()

    assert ready is True
    assert reason == ""

"""
Phase 3 OCR and structured analysis helpers for drug insert PDFs.

This module deliberately stays independent from RxNorm and only operates on
the TFDA-backed drug assets already persisted by the loaders.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any
import uuid

import httpx

from llm_profiles import (
    LlmProfile,
    candidate_order,
    report_failure,
    report_success,
)
from utils import log_error, log_info, log_warning

try:
    from dots_ocr.parser import DotsOCRParser
    from dots_ocr.utils import dict_promptmode_to_prompt
    from dots_ocr.utils.consts import MAX_PIXELS, MIN_PIXELS

    DOTS_OCR_AVAILABLE = True
except ImportError:
    DotsOCRParser = None  # type: ignore[assignment]
    dict_promptmode_to_prompt = {}  # type: ignore[assignment]
    MIN_PIXELS = 0  # type: ignore[assignment]
    MAX_PIXELS = 0  # type: ignore[assignment]
    DOTS_OCR_AVAILABLE = False

ANALYSIS_TEMPLATE: dict[str, Any] = {
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
}

_S2T_PHRASES = {
    "药品": "藥品",
    "有效成分": "有效成分",
    "其他成分": "其他成分",
    "用途": "用途",
    "适应症": "適應症",
    "使用上注意事项": "使用上注意事項",
    "请勿使用": "請勿使用",
    "使用前请洽医师诊治": "使用前請洽醫師診治",
    "使用前请先咨询医师药师药剂生": "使用前請先諮詢醫師藥師藥劑生",
    "用法用量": "用法用量",
    "警语": "警語",
    "副作用": "副作用",
    "立即停止使用": "立即停止使用",
    "说明书": "說明書",
    "咨询": "諮詢",
    "医师": "醫師",
    "药师": "藥師",
    "药剂生": "藥劑生",
    "症状": "症狀",
    "接受医师诊治": "接受醫師診治",
    "储存方式": "儲存方式",
    "含量": "含量",
    "成分": "成分",
}

_S2T_CHARS = str.maketrans(
    {
        "药": "藥",
        "医": "醫",
        "师": "師",
        "剂": "劑",
        "咨": "諮",
        "询": "詢",
        "说": "說",
        "书": "書",
        "语": "語",
        "储": "儲",
        "适": "適",
        "应": "應",
        "项": "項",
        "请": "請",
        "诊": "診",
        "则": "則",
        "时": "時",
        "后": "後",
        "发": "發",
        "处": "處",
        "阳": "陽",
        "儿": "兒",
        "与": "與",
        "为": "為",
        "无": "無",
        "湿": "濕",
        "温": "溫",
        "过": "過",
        "内": "內",
        "类": "類",
        "体": "體",
        "复": "複",
        "补": "補",
        "营": "營",
        "养": "養",
        "并": "並",
    }
)

_DATA_IMG_MD_RE = re.compile(
    r"!\[[^\]]*\]\(\s*data:image/[^;\s)]+;base64,[^)]+\)", re.I
)
_DATA_IMG_HTML_RE = re.compile(
    r"<img\b[^>]*\bsrc=[\"']data:image/[^;\"']+;base64,[^\"']+[\"'][^>]*>", re.I
)
_DATA_IMG_URI_RE = re.compile(
    r"data:image/[^;\s)\"']+;base64,[A-Za-z0-9+/_=\-.\r\n]+", re.I
)

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts" / "drug"
_DEFAULT_ANALYSIS_PROMPT_PATH = _PROMPTS_DIR / "analysis_prompt.txt"
_DEFAULT_OCR_PROMPT_PATH = _PROMPTS_DIR / "prompt_layout_all_en.txt"

_INGREDIENT_AMOUNT_RE = re.compile(
    r"^(?P<name>.+?)\s*(?P<amount>\d+(?:\.\d+)?\s*"
    r"(?:mg|g|mcg|μg|ug|mL|ml|IU|%|毫克|公克|微克|毫升|單位).*)$",
    re.IGNORECASE,
)


def convert_text_to_traditional(text: str) -> str:
    try:
        from opencc import OpenCC

        return OpenCC("s2twp").convert(text)
    except Exception:
        converted = text
        for simplified, traditional in _S2T_PHRASES.items():
            converted = converted.replace(simplified, traditional)
        return converted.translate(_S2T_CHARS)


def convert_json_to_traditional(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            convert_text_to_traditional(str(key)): convert_json_to_traditional(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [convert_json_to_traditional(item) for item in value]
    if isinstance(value, str):
        return convert_text_to_traditional(value)
    return value


def validate_analysis_shape(
    data: Any,
    template: Any = ANALYSIS_TEMPLATE,
    path: str = "$",
) -> list[str]:
    errors: list[str] = []
    if isinstance(template, dict):
        if not isinstance(data, dict):
            return [f"{path} 必須是 object。"]
        expected = set(template)
        actual = set(data)
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        if missing:
            errors.append(f"{path} 缺少欄位: {', '.join(missing)}")
        if extra:
            errors.append(f"{path} 多出欄位: {', '.join(extra)}")
        for key in expected & actual:
            errors.extend(
                validate_analysis_shape(data[key], template[key], f"{path}.{key}")
            )
        return errors
    if isinstance(template, list):
        return [] if isinstance(data, list) else [f"{path} 必須是 array。"]
    if isinstance(template, str):
        return [] if isinstance(data, str) else [f"{path} 必須是 string。"]
    return errors


def validate_ingredient_items(data: Any) -> list[str]:
    errors: list[str] = []
    for field_name in ("有效成分及含量", "其他成分"):
        items = data.get(field_name, []) if isinstance(data, dict) else []
        if not isinstance(items, list):
            continue
        for idx, item in enumerate(items):
            path = f"$.{field_name}[{idx}]"
            if not isinstance(item, dict):
                errors.append(f"{path} 必須是 object。")
                continue
            expected = {"成分", "含量"}
            for key in sorted(expected - set(item)):
                errors.append(f"{path} 缺少欄位: {key}")
            for key in sorted(set(item) - expected):
                errors.append(f"{path} 多出欄位: {key}")
            for key in expected & set(item):
                if not isinstance(item[key], str):
                    errors.append(f"{path}.{key} 必須是 string。")
    return errors


def _parse_ingredient_text(text: str) -> dict[str, str]:
    text = text.strip()
    if not text:
        return {"成分": "", "含量": ""}
    match = _INGREDIENT_AMOUNT_RE.match(text)
    if match:
        return {
            "成分": match.group("name").strip(" ,，:：;；"),
            "含量": match.group("amount").replace(" ", "").strip(),
        }
    return {"成分": text, "含量": ""}


def _normalize_ingredient_list(value: Any) -> list[dict[str, str]]:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        value = [value]
    result: list[dict[str, str]] = []
    for item in value:
        if item in (None, ""):
            continue
        if isinstance(item, str):
            result.append(_parse_ingredient_text(convert_text_to_traditional(item)))
        elif isinstance(item, dict):
            item = convert_json_to_traditional(item)
            name = item.get("成分") or item.get("名稱") or item.get("name") or ""
            amount = item.get("含量") or item.get("劑量") or item.get("amount") or ""
            if not name and len(item) == 1:
                only_key, only_val = next(iter(item.items()))
                name = str(only_key)
                amount = str(only_val) if only_val is not None else ""
            result.append({"成分": str(name), "含量": str(amount)})
        else:
            result.append({"成分": str(item), "含量": ""})
    return result


def _normalize_array(value: Any) -> list[Any]:
    if value in (None, ""):
        return []
    if isinstance(value, list):
        return [
            convert_json_to_traditional(item)
            for item in value
            if item not in (None, "")
        ]
    return [convert_json_to_traditional(value)]


def _normalize_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "；".join(str(item) for item in value if item not in (None, ""))
    if isinstance(value, dict):
        return json.dumps(convert_json_to_traditional(value), ensure_ascii=False)
    return convert_text_to_traditional(str(value))


def _first_mapping_value(mapping: Any, *keys: str) -> Any:
    if not isinstance(mapping, dict):
        return []
    for key in keys:
        if key in mapping:
            return mapping.get(key)
    return []


def normalize_analysis_data(data: Any) -> dict[str, Any]:
    data = convert_json_to_traditional(data)
    if not isinstance(data, dict):
        data = {}

    usage = data.get("使用上注意事項", {})
    if not isinstance(usage, dict):
        usage = {"其他使用上注意事項": usage}

    warnings = data.get("警語", {})
    if not isinstance(warnings, dict):
        warnings = {
            "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生": warnings
        }

    return {
        "藥品特性": _normalize_string(data.get("藥品特性", "")),
        "有效成分及含量": _normalize_ingredient_list(data.get("有效成分及含量", [])),
        "其他成分": _normalize_ingredient_list(
            data.get("其他成分", data.get("其他成分(賦形劑)", []))
        ),
        "用途(適應症)": _normalize_array(
            data.get("用途(適應症)", data.get("用途(适应症)", []))
        ),
        "使用上注意事項": {
            "有下列情形者，請勿使用": _normalize_array(
                _first_mapping_value(
                    usage,
                    "有下列情形者，請勿使用",
                    "有下列情形者，请勿使用",
                )
            ),
            "有下列情形者，使用前請洽醫師診治": _normalize_array(
                _first_mapping_value(
                    usage,
                    "有下列情形者，使用前請洽醫師診治",
                    "有下列情形者，使用前请洽医师诊治",
                )
            ),
            "有下列情形者，使用前請先諮詢醫師藥師藥劑生": _normalize_array(
                _first_mapping_value(
                    usage,
                    "有下列情形者，使用前請先諮詢醫師藥師藥劑生",
                    "有下列情形者，使用前请先咨询医师药师药剂生",
                )
            ),
            "其他使用上注意事項": _normalize_array(
                _first_mapping_value(usage, "其他使用上注意事項", "其他使用上注意事项")
            ),
        },
        "用法用量": _normalize_array(data.get("用法用量", [])),
        "警語": {
            "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生": _normalize_array(
                _first_mapping_value(
                    warnings,
                    "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生",
                    "使用本药后，若有发生以下副作用，请立即停止使用，并持此说明书咨询医师药师药剂生",
                )
            ),
            "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治": _normalize_array(
                _first_mapping_value(
                    warnings,
                    "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治",
                    "使用本药后，若有发生以下症状时，请立即停止使用，并接受医师诊治",
                )
            ),
        },
        "儲存方式": _normalize_array(data.get("儲存方式", [])),
    }


@dataclass
class DrugAnalysisConfig:
    ocr_provider: str
    ocr_vllm_server_ip: str
    ocr_vllm_port: int
    ocr_model_name: str
    ocr_prompt_mode: str
    ocr_prompt_path: Path
    analysis_prompt_path: Path
    analysis_max_retries: int
    # The Analysis LM endpoints to try, already in the order this run should try
    # them (see llm_profiles.candidate_order). More than one means failover.
    analysis_profiles: list[LlmProfile] = field(default_factory=list)
    analysis_strategy: str = "failover"
    # Whether an operator has actually configured OCR in the admin console. The
    # endpoint has no machine-wide default worth dialling, so it is never seeded
    # from the environment — see `load_drug_analysis_config`.
    ocr_configured: bool = True

    # ── Views of the primary profile ────────────────────────────────────────
    # The pipeline records "which provider produced this analysis" and the admin
    # probe shows "what is this configured against"; both mean the profile that
    # would be tried first. A call may end up on a later one — analyze_pdf_bytes
    # reports the profile it actually used.

    @property
    def analysis_configured(self) -> bool:
        return bool(self.analysis_profiles)

    @property
    def _primary(self) -> "LlmProfile | None":
        return self.analysis_profiles[0] if self.analysis_profiles else None

    @property
    def analysis_provider(self) -> str:
        p = self._primary
        return p.provider if p else ""

    @property
    def analysis_base_url(self) -> str:
        p = self._primary
        return p.base_url if p else ""

    @property
    def analysis_model_name(self) -> str:
        p = self._primary
        return p.model if p else ""

    @property
    def analysis_api_key(self) -> str:
        p = self._primary
        return p.api_key if p else ""

    @classmethod
    def from_values(
        cls,
        *,
        ocr: dict,
        analysis: dict,
        analysis_profiles: list[LlmProfile] | None = None,
        ocr_configured: bool = True,
    ) -> "DrugAnalysisConfig":
        """Build from DB settings (admin_settings 'ocr' + 'analysis' groups) and
        the Analysis LM profiles.

        The prompt files are not configurable: they ship with the code, and a
        path pointing anywhere else was only ever a way to break the pipeline.
        """
        return cls(
            ocr_provider=str(ocr.get("provider", "dots_ocr") or "dots_ocr")
            .strip()
            .lower(),
            ocr_vllm_server_ip=str(
                ocr.get("server_ip", "127.0.0.1") or "127.0.0.1"
            ).strip(),
            ocr_vllm_port=int(ocr.get("port", 8002) or 8002),
            ocr_model_name=str(ocr.get("model", "") or "").strip(),
            ocr_prompt_mode=str(
                ocr.get("prompt_mode", "prompt_layout_all_en") or ""
            ).strip(),
            ocr_prompt_path=_DEFAULT_OCR_PROMPT_PATH,
            analysis_prompt_path=_DEFAULT_ANALYSIS_PROMPT_PATH,
            analysis_max_retries=int(analysis.get("max_retries", 3) or 3),
            analysis_profiles=list(analysis_profiles or []),
            analysis_strategy=str(analysis.get("strategy", "failover") or "failover"),
            ocr_configured=ocr_configured,
        )


async def load_drug_analysis_config(pool) -> DrugAnalysisConfig:
    """The one way to build a drug OCR/analysis config.

    OCR settings come from `admin.app_settings` (group `ocr`); the Analysis LM
    endpoints come from `admin.llm_profiles`, already ordered for this call by
    the configured strategy. Neither is seeded from the environment, so "nothing
    there" means the operator has not set it up yet — which `get_group` cannot
    express on its own (it answers with schema defaults so the admin form has
    something to prefill). Readiness can then say "not configured" instead of
    failing against an endpoint nobody chose.
    """
    import admin_settings as _admin_settings

    analysis = await _admin_settings.get_group(pool, "analysis")
    strategy = str(analysis.get("strategy", "failover") or "failover")
    return DrugAnalysisConfig.from_values(
        ocr=await _admin_settings.get_group(pool, "ocr"),
        analysis=analysis,
        analysis_profiles=await candidate_order(pool, "analysis", strategy),
        ocr_configured=await _admin_settings.is_group_configured(pool, "ocr"),
    )


@dataclass
class DrugAnalysisResult:
    markdown: str
    analysis_json: dict[str, Any]
    ocr_provider: str
    analysis_provider: str


_NOT_CONFIGURED = (
    "{what} is not configured yet — set it up in the admin console "
    "(Settings → {group})."
)


class DrugAnalysisService:
    def __init__(self, config: DrugAnalysisConfig):
        self.config = config
        # The profile that actually served the last call — may not be the primary
        # one if it had failed over. Recorded on the analysis result.
        self.last_profile_used: LlmProfile | None = None

    def ocr_readiness(self) -> tuple[bool, str]:
        if not self.config.ocr_configured:
            return False, _NOT_CONFIGURED.format(what="OCR server", group="OCR Server")
        if self.config.ocr_provider != "dots_ocr":
            return False, f"Unsupported OCR provider: {self.config.ocr_provider}"
        if not DOTS_OCR_AVAILABLE:
            return False, "dots_ocr is not installed"
        if not self.config.ocr_prompt_path.exists():
            return False, f"OCR prompt not found: {self.config.ocr_prompt_path}"
        return True, ""

    def analysis_readiness(self) -> tuple[bool, str]:
        if not self.config.analysis_configured:
            return False, _NOT_CONFIGURED.format(
                what="Analysis LM", group="Analysis LM"
            )
        if not self.config.analysis_prompt_path.exists():
            return (
                False,
                f"Analysis prompt not found: {self.config.analysis_prompt_path}",
            )
        for profile in self.config.analysis_profiles:
            if profile.provider not in {"openai", "vllm", "ollama"}:
                return (
                    False,
                    f"Profile '{profile.name}': unsupported provider "
                    f"'{profile.provider}'",
                )
        return True, ""

    def readiness(self) -> tuple[bool, str]:
        ready, reason = self.ocr_readiness()
        if not ready:
            return ready, reason
        return self.analysis_readiness()

    async def analyze_pdf_bytes(
        self,
        *,
        license_id: str,
        source_filename: str,
        pdf_bytes: bytes,
        existing_markdown: str | None = None,
    ) -> DrugAnalysisResult:
        ready, reason = (
            self.analysis_readiness() if existing_markdown else self.readiness()
        )
        if not ready:
            raise RuntimeError(reason)

        markdown = existing_markdown
        if not markdown:
            markdown = await self._ocr_pdf_bytes(
                pdf_bytes, source_filename=source_filename
            )
        analysis_json = await self._run_analysis(markdown)
        used = self.last_profile_used
        return DrugAnalysisResult(
            markdown=markdown,
            analysis_json=analysis_json,
            ocr_provider=self.config.ocr_provider,
            # The profile that actually answered, which failover may have made a
            # different one from the primary.
            analysis_provider=used.provider if used else self.config.analysis_provider,
        )

    async def _ocr_pdf_bytes(self, pdf_bytes: bytes, *, source_filename: str) -> str:
        return await asyncio.to_thread(
            self._ocr_pdf_bytes_sync,
            pdf_bytes,
            source_filename,
        )

    def _ocr_pdf_bytes_sync(self, pdf_bytes: bytes, source_filename: str) -> str:
        self._configure_ocr_prompt()
        parser = DotsOCRParser(
            ip=self.config.ocr_vllm_server_ip,
            port=self.config.ocr_vllm_port,
            dpi=200,
            min_pixels=MIN_PIXELS,
            max_pixels=MAX_PIXELS,
        )
        self._apply_vllm_model_patch(parser, self.config.ocr_model_name)

        with tempfile.TemporaryDirectory(prefix="drug_ocr_") as temp_dir:
            pdf_path = Path(temp_dir) / source_filename
            pdf_path.write_bytes(pdf_bytes)
            results = parser.parse_pdf(
                input_path=str(pdf_path),
                filename=f"task_{uuid.uuid4().hex[:8]}",
                prompt_mode=self.config.ocr_prompt_mode,
                save_dir=temp_dir,
            )
            if not results:
                raise RuntimeError("OCR parser returned no results")
            pages: list[str] = []
            for idx, result in enumerate(results, start=1):
                markdown_path = result.get("md_content_path")
                if markdown_path and os.path.exists(markdown_path):
                    pages.append(Path(markdown_path).read_text(encoding="utf-8"))
                else:
                    log_warning("OCR page produced no markdown", page=idx)
            combined = "\n\n\n\n".join(pages).strip()
            if not combined:
                raise RuntimeError("OCR markdown is empty")
            return combined

    def _configure_ocr_prompt(self) -> None:
        dict_promptmode_to_prompt[self.config.ocr_prompt_mode] = (
            self.config.ocr_prompt_path.read_text(encoding="utf-8")
        )

    @staticmethod
    def _apply_vllm_model_patch(parser_instance: Any, model_name: str) -> None:
        parser_instance.model = model_name
        parser_instance.model_name = model_name

        if hasattr(parser_instance, "_parse_image"):
            original = parser_instance._parse_image

            def _patched(*args: Any, **kwargs: Any) -> Any:
                if "model" in kwargs:
                    kwargs["model"] = model_name
                return original(*args, **kwargs)

            parser_instance._parse_image = _patched

        if hasattr(parser_instance, "client") and parser_instance.client:
            original_create = parser_instance.client.chat.completions.create

            def _patched_create(*args: Any, **kwargs: Any) -> Any:
                if kwargs.get("model") == "model" or "model" not in kwargs:
                    kwargs["model"] = model_name
                return original_create(*args, **kwargs)

            parser_instance.client.chat.completions.create = _patched_create

    async def _run_analysis(self, ocr_markdown: str) -> dict[str, Any]:
        sanitized_markdown, removed_images, removed_chars = (
            self._strip_embedded_base64_images(ocr_markdown)
        )
        if removed_images:
            log_info(
                "Removed embedded base64 images from OCR markdown",
                removed_images=removed_images,
                removed_chars=removed_chars,
            )
        prompt = self.config.analysis_prompt_path.read_text(encoding="utf-8")
        template_json = json.dumps(ANALYSIS_TEMPLATE, ensure_ascii=False, indent=2)
        user_content = (
            "以下是 OCR 轉出的藥品說明書 Markdown 內容。"
            "請只根據這份內容抽取資訊，並輸出和指定模板完全一致的 JSON。\n\n"
            f"指定 JSON 模板：\n{template_json}\n\n"
            f"OCR Markdown：\n{sanitized_markdown}"
        )
        messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": user_content},
        ]

        last_error = ""
        for attempt in range(1, self.config.analysis_max_retries + 1):
            content = await self._call_analysis_llm(messages)
            try:
                parsed = normalize_analysis_data(self._extract_json_object(content))
                errors = validate_analysis_shape(parsed)
                errors.extend(validate_ingredient_items(parsed))
                if not errors:
                    return parsed
                last_error = "; ".join(errors)
            except (json.JSONDecodeError, ValueError) as exc:
                last_error = str(exc)

            log_warning(
                "Analysis output failed validation",
                attempt=attempt,
                max_retries=self.config.analysis_max_retries,
                error=last_error,
            )
            messages.append({"role": "assistant", "content": content})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "上一次輸出不合格。請重新輸出單一合法 JSON object。"
                        "不要輸出說明、不要輸出 Markdown code fence、不要加入模板外欄位。"
                        f"錯誤原因: {last_error}"
                    ),
                }
            )
        raise RuntimeError(
            f"Analysis LLM failed after {self.config.analysis_max_retries} attempts: {last_error}"
        )

    async def _call_analysis_llm(self, messages: list[dict[str, str]]) -> str:
        """Call the Analysis LM, moving to the next profile when one fails.

        The profiles arrive already ordered for this call (failover by priority,
        or weighted with the rest as fallbacks). A transport error, a timeout or
        an HTTP failure means *this endpoint* is unusable right now, so we record
        that against it — feeding the cool-down — and try the next one. Only when
        every profile has failed does the call fail, and then the error names each
        one, so an operator can see whether it was one bad key or the whole fleet.
        """
        profiles = self.config.analysis_profiles
        if not profiles:
            raise RuntimeError(
                _NOT_CONFIGURED.format(what="Analysis LM", group="Analysis LM")
            )

        failures: list[str] = []
        for profile in profiles:
            try:
                content = await self._call_one_profile(profile, messages)
            except Exception as exc:  # transport, HTTP, or an unusable response
                message = f"{profile.name}: {exc}"
                failures.append(message)
                report_failure(profile.id, str(exc))
                log_warning(
                    "analysis_profile_failed",
                    profile=profile.name,
                    provider=profile.provider,
                    model=profile.model,
                    error=str(exc),
                )
                continue
            report_success(profile.id)
            self.last_profile_used = profile
            return content

        raise RuntimeError(
            "Every Analysis LM profile failed: " + "; ".join(failures)
        )

    async def _call_one_profile(
        self, profile: LlmProfile, messages: list[dict[str, str]]
    ) -> str:
        if profile.provider in {"openai", "vllm"}:
            url = f"{self._normalize_openai_base_url(profile.base_url)}/chat/completions"
            payload: dict[str, Any] = {
                "model": profile.model,
                "messages": messages,
                "temperature": profile.temperature(),
                "response_format": {"type": "json_object"},
            }
            token_param = (
                "max_completion_tokens"
                if profile.provider == "openai"
                and self._uses_max_completion_tokens(profile.model)
                else "max_tokens"
            )
            payload[token_param] = profile.max_tokens()
            # Only authenticate when a key is configured: a local vLLM/Ollama
            # OpenAI-compatible server needs no key, and sending an empty or
            # placeholder bearer token makes some of them reject the request.
            headers = (
                {"Authorization": f"Bearer {profile.api_key}"}
                if profile.api_key
                else {}
            )

            # Different OpenAI-compatible model families reject different request
            # parameters (newer OpenAI reasoning models require
            # `max_completion_tokens` instead of `max_tokens`, only allow the
            # default `temperature`, and may not support `response_format`). Adapt
            # the payload across a few attempts so one rejection doesn't abort —
            # the original code only retried once and missed the "Unsupported
            # value" temperature error.
            async with httpx.AsyncClient(timeout=300) as client:
                last_message = ""
                response = None
                for _attempt in range(4):
                    try:
                        response = await client.post(url, json=payload, headers=headers)
                        response.raise_for_status()
                        break
                    except httpx.HTTPStatusError as exc:
                        body = exc.response.text or ""
                        low = body.lower()
                        last_message = (
                            f"HTTP {exc.response.status_code} from {url}: {body}"
                        )
                        adapted = False
                        # 1. token-limit parameter naming
                        if "max_completion_tokens" in low and "max_tokens" in payload:
                            payload["max_completion_tokens"] = payload.pop("max_tokens")
                            adapted = True
                        elif (
                            "max_tokens" in low
                            and "max_completion_tokens" in payload
                            and ("unsupported" in low or "not supported" in low)
                        ):
                            payload["max_tokens"] = payload.pop("max_completion_tokens")
                            adapted = True
                        # 2. temperature rejected (reasoning models only allow default)
                        if (
                            not adapted
                            and "temperature" in payload
                            and "temperature" in low
                            and ("unsupported" in low or "does not support" in low)
                        ):
                            payload.pop("temperature", None)
                            adapted = True
                        # 3. response_format not supported by this model/server
                        if (
                            not adapted
                            and "response_format" in payload
                            and "response_format" in low
                            and ("unsupported" in low or "not supported" in low)
                        ):
                            payload.pop("response_format", None)
                            adapted = True
                        if not adapted:
                            raise RuntimeError(last_message) from exc
                else:
                    raise RuntimeError(
                        last_message
                        or "Analysis LLM call failed after parameter-adaptation retries"
                    )
                data = response.json()
            return data["choices"][0]["message"]["content"]

        if profile.provider == "ollama":
            url = f"{profile.base_url.rstrip('/')}/api/chat"
            payload = {
                "model": profile.model,
                "messages": messages,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": profile.temperature(),
                    "num_predict": profile.max_tokens(),
                },
            }
            async with httpx.AsyncClient(timeout=300) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
            return data["message"]["content"]

        raise ValueError(f"Unsupported analysis provider: {profile.provider}")

    @staticmethod
    def _normalize_openai_base_url(base_url: str) -> str:
        base_url = base_url.rstrip("/")
        return base_url if base_url.endswith("/v1") else f"{base_url}/v1"

    @staticmethod
    def _uses_max_completion_tokens(model_name: str) -> bool:
        lowered = model_name.lower()
        return lowered.startswith(("gpt-5", "o1", "o3", "o4"))

    @staticmethod
    def _extract_json_object(content: str) -> Any:
        content = content.strip()
        if content.startswith("```"):
            lines = content.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            content = "\n".join(lines).strip()
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError("No JSON object found in model reply.")
        return json.loads(content[start : end + 1])

    @staticmethod
    def _strip_embedded_base64_images(markdown: str) -> tuple[str, int, int]:
        if not markdown:
            return markdown, 0, 0
        original_len = len(markdown)
        markdown, count1 = _DATA_IMG_MD_RE.subn("", markdown)
        markdown, count2 = _DATA_IMG_HTML_RE.subn("", markdown)
        markdown, count3 = _DATA_IMG_URI_RE.subn("", markdown)
        return markdown, count1 + count2 + count3, original_len - len(markdown)

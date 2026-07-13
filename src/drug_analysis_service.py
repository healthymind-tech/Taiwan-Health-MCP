"""
Phase 3 OCR and structured analysis helpers for drug insert PDFs.

This module deliberately stays independent from RxNorm and only operates on
the TFDA-backed drug assets already persisted by the loaders.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
import re
from typing import Any

import httpx

from llm_profiles import (
    LlmProfile,
    candidate_order,
    is_reasoning_model,
    report_failure,
    report_success,
)
from utils import log_info, log_warning

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
    ocr_base_url: str
    ocr_backend: str
    ocr_effort: str
    ocr_parse_method: str
    ocr_lang: str
    ocr_timeout_seconds: int
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

        The prompt file is not configurable: it ships with the code, and a path
        pointing anywhere else was only ever a way to break the pipeline.
        """
        return cls(
            ocr_provider=str(ocr.get("provider", "mineru") or "mineru")
            .strip()
            .lower(),
            ocr_base_url=str(ocr.get("base_url", "") or "").strip().rstrip("/"),
            ocr_backend=str(
                ocr.get("backend", "hybrid-engine") or "hybrid-engine"
            ).strip(),
            ocr_effort=str(ocr.get("effort", "medium") or "medium").strip(),
            ocr_parse_method=str(ocr.get("parse_method", "auto") or "auto").strip(),
            ocr_lang=str(ocr.get("lang", "ch") or "ch").strip(),
            ocr_timeout_seconds=int(ocr.get("timeout_seconds", 600) or 600),
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

# Ceiling for the automatic budget escalation below. High enough that no drug
# insert should ever reach it; low enough that a genuinely broken model cannot
# bill an unbounded number of tokens per attempt.
MAX_TOKEN_BUDGET = 65536


class TokenBudgetExceeded(RuntimeError):
    """The model ran out of output budget before it finished the JSON.

    Distinct from a broken endpoint on purpose: the server answered correctly, we
    simply did not give it room to reply. It must therefore not count against the
    profile's health (no cool-down) — the caller retries the *same* profile with a
    larger budget instead.
    """

    def __init__(
        self,
        message: str,
        *,
        budget: int,
        finish_reason: str = "",
        reasoning_tokens: int | None = None,
    ) -> None:
        super().__init__(message)
        self.budget = budget
        self.finish_reason = finish_reason
        self.reasoning_tokens = reasoning_tokens


class DrugAnalysisService:
    def __init__(self, config: DrugAnalysisConfig):
        self.config = config
        # The profile that actually served the last call — may not be the primary
        # one if it had failed over. Recorded on the analysis result.
        self.last_profile_used: LlmProfile | None = None

    def ocr_readiness(self) -> tuple[bool, str]:
        if not self.config.ocr_configured:
            return False, _NOT_CONFIGURED.format(what="OCR server", group="OCR Server")
        if self.config.ocr_provider != "mineru":
            return False, f"Unsupported OCR provider: {self.config.ocr_provider}"
        if not self.config.ocr_base_url:
            return False, _NOT_CONFIGURED.format(
                what="OCR base URL", group="OCR Server"
            )
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
        """Turn one insert PDF into Markdown via MinerU's synchronous endpoint.

        `/file_parse` parses the upload and answers with the Markdown inline, so
        there is no task to poll and no result archive to unpack. We ask for the
        Markdown only: the pipeline feeds it to the Analysis LM, which cannot use
        the images or the layout JSON anyway, and skipping them keeps the reply
        small and leaves no archive to extract.
        """
        if not pdf_bytes.startswith(b"%PDF-"):
            raise RuntimeError(
                f"{source_filename} is not a PDF (leading bytes: {pdf_bytes[:8]!r})"
            )

        files = {"files": (source_filename, pdf_bytes, "application/pdf")}
        data = {
            "backend": self.config.ocr_backend,
            "effort": self.config.ocr_effort,
            "parse_method": self.config.ocr_parse_method,
            "lang_list": self.config.ocr_lang,
            "table_enable": "true",
            "return_md": "true",
            "return_images": "false",
            "return_middle_json": "false",
            "return_content_list": "false",
            "response_format_zip": "false",
        }
        url = f"{self.config.ocr_base_url}/file_parse"
        async with httpx.AsyncClient(timeout=self.config.ocr_timeout_seconds) as client:
            try:
                response = await client.post(url, files=files, data=data)
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                body = (exc.response.text or "")[:300]
                raise RuntimeError(
                    f"HTTP {exc.response.status_code} from {url}: {body}"
                ) from exc
            payload = response.json()

        results = payload.get("results") or {}
        if not results:
            raise RuntimeError(
                f"OCR returned no results: {payload.get('error') or payload}"
            )
        # `results` is keyed by the uploaded file's stem rather than a fixed key,
        # and we upload exactly one file.
        markdown = str(next(iter(results.values())).get("md_content") or "")
        if not markdown.strip():
            raise RuntimeError("OCR markdown is empty")
        return markdown

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

        # NB: a TokenBudgetExceeded from here is deliberately NOT caught. This loop
        # exists to re-prompt a model that produced *malformed* output, which is the
        # wrong medicine for a truncated one — appending the cut-off reply and asking
        # again only lengthens the conversation and makes the next reply likelier to
        # be cut off too. Budget is handled where it can actually be fixed, by
        # `_call_profile_with_budget`.
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
                content = await self._call_profile_with_budget(profile, messages)
            except TokenBudgetExceeded as exc:
                # The endpoint is healthy — we just could not buy enough room, even
                # at the ceiling. Record it, but do NOT feed the circuit breaker:
                # cooling down a working endpoint over our own budget would take it
                # out of rotation for every other document too.
                failures.append(f"{profile.name}: {exc}")
                log_warning(
                    "analysis_profile_out_of_budget",
                    profile=profile.name,
                    model=profile.model,
                    budget=exc.budget,
                    finish_reason=exc.finish_reason,
                    reasoning_tokens=exc.reasoning_tokens,
                )
                continue
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

    async def _call_profile_with_budget(
        self, profile: LlmProfile, messages: list[dict[str, str]]
    ) -> str:
        """Call one profile, buying more output budget whenever it runs out.

        A reasoning model spends its budget on hidden reasoning first, so the room
        an insert needs depends on how hard the model finds it — not on anything we
        can read off the document up front. Rather than make the operator guess a
        number that works for every insert, start from the configured one and double
        it until the model gets to finish, up to `MAX_TOKEN_BUDGET`.

        Retrying the *same* profile with more room is the only retry that addresses
        this failure: re-prompting the model (what the caller does for malformed
        output) would only make the conversation longer and the truncation likelier.
        """
        budget = profile.max_tokens()
        while True:
            try:
                return await self._call_one_profile(profile, messages, budget)
            except TokenBudgetExceeded as exc:
                if budget >= MAX_TOKEN_BUDGET:
                    raise
                budget = min(budget * 2, MAX_TOKEN_BUDGET)
                log_warning(
                    "analysis_budget_escalated",
                    profile=profile.name,
                    model=profile.model,
                    previous_budget=exc.budget,
                    new_budget=budget,
                    finish_reason=exc.finish_reason,
                    reasoning_tokens=exc.reasoning_tokens,
                )

    async def _call_one_profile(
        self, profile: LlmProfile, messages: list[dict[str, str]], max_tokens: int
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
                if profile.provider == "openai" and is_reasoning_model(profile.model)
                else "max_tokens"
            )
            payload[token_param] = max_tokens
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

            choice = (data.get("choices") or [{}])[0]
            content = str(choice.get("message", {}).get("content") or "")
            finish_reason = str(choice.get("finish_reason") or "")
            reasoning_tokens = (
                (data.get("usage") or {})
                .get("completion_tokens_details", {})
                .get("reasoning_tokens")
            )
            # `length` means the model was cut off mid-answer. An empty message with
            # no other explanation means the same thing on a reasoning model: the
            # budget went entirely on hidden reasoning and nothing was left to say
            # the answer with. Both are budget problems, not content problems — say
            # so, instead of handing "" to the JSON parser and reporting the
            # resulting "No JSON object found" as if the model had misbehaved.
            if finish_reason == "length" or not content.strip():
                raise TokenBudgetExceeded(
                    f"{profile.model} ran out of output budget at {max_tokens} tokens"
                    + (
                        f" ({reasoning_tokens} of them spent on reasoning)"
                        if reasoning_tokens
                        else ""
                    )
                    + f"; finish_reason={finish_reason or 'none'}",
                    budget=max_tokens,
                    finish_reason=finish_reason,
                    reasoning_tokens=reasoning_tokens,
                )
            return content

        if profile.provider == "ollama":
            url = f"{profile.base_url.rstrip('/')}/api/chat"
            payload = {
                "model": profile.model,
                "messages": messages,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": profile.temperature(),
                    "num_predict": max_tokens,
                },
            }
            async with httpx.AsyncClient(timeout=300) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()

            content = str((data.get("message") or {}).get("content") or "")
            done_reason = str(data.get("done_reason") or "")
            if done_reason == "length" or not content.strip():
                raise TokenBudgetExceeded(
                    f"{profile.model} ran out of output budget at {max_tokens} tokens; "
                    f"done_reason={done_reason or 'none'}",
                    budget=max_tokens,
                    finish_reason=done_reason,
                )
            return content

        raise ValueError(f"Unsupported analysis provider: {profile.provider}")

    @staticmethod
    def _normalize_openai_base_url(base_url: str) -> str:
        base_url = base_url.rstrip("/")
        return base_url if base_url.endswith("/v1") else f"{base_url}/v1"

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

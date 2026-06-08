"""
HTML parsing helpers for the TFDA drug information site.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
import re
from typing import Any
from urllib.parse import quote, urljoin

BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

UI_IMAGE_KEYWORDS = ("/Content/", "/logo", "/AA.", "/VerificationCode", "favicon")
UPLOAD_DATE_RE = re.compile(r"(?<!\d)\d{2,4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)")
_ENUM_RE = re.compile(r"^\s*\([一二三四五六七八九十百千]+\)\s*", re.MULTILINE)


def make_soup(html: str) -> Any:
    from bs4 import BeautifulSoup

    try:
        return BeautifulSoup(html, "lxml")
    except Exception:
        return BeautifulSoup(html, "html.parser")


def encode_license_id(license_id: str) -> str:
    return quote(license_id, safe="")


def abs_url(base_url: str, href: str) -> str:
    if href.startswith("http"):
        return href
    return urljoin(base_url, href)


def safe_filename(name: str, max_len: int = 180) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", name).strip(". ")
    return name[:max_len] if name else "file"


def normalize_upload_date(date_text: str) -> str:
    match = UPLOAD_DATE_RE.search(date_text or "")
    if not match:
        return ""
    return re.sub(r"[-/.]", "-", match.group(0))


def extract_date_from_filename(filename: str) -> str:
    matches = re.findall(r"(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)", filename)
    if matches:
        year, month, day = matches[-1]
        return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"

    roc_matches = re.findall(
        r"(?<!\d)(\d{3})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)", filename
    )
    if roc_matches:
        year, month, day = roc_matches[-1]
        return f"{int(year) + 1911:04d}-{int(month):02d}-{int(day):02d}"
    return ""


def filename_with_upload_date(filename: str, upload_date: str) -> str:
    upload_date = normalize_upload_date(upload_date)
    if not upload_date:
        return filename
    path = Path(filename)
    stem = path.stem
    suffix = path.suffix
    normalized_stem = re.sub(r"[-/.]", "-", stem)
    if upload_date in normalized_stem:
        return filename
    return f"{stem}-{upload_date}{suffix}"


def extract_upload_date_from_row(row: Any) -> str:
    if row is None:
        return ""
    date_cell = row.select_one('[data-label*="上傳日期"], [data-label*="日期"]')
    if date_cell:
        date = normalize_upload_date(date_cell.get_text(" ", strip=True))
        if date:
            return date
    return normalize_upload_date(row.get_text(" ", strip=True))


def _clean_text(tag: Any) -> str:
    lines = [line.strip() for line in tag.get_text(separator="\n").splitlines()]
    return "\n".join(line for line in lines if line)


def _listify_if_enumerated(text: str) -> Any:
    if not _ENUM_RE.search(text):
        return text
    items = [item.strip() for item in _ENUM_RE.split(text) if item.strip()]
    return items if items else text


def collect_pdf_links(
    soup: Any, base_url: str, path_fragment: str
) -> list[dict[str, str]]:
    seen: set[str] = set()
    links: list[dict[str, str]] = []
    for anchor in soup.select(f'a[href*="{path_fragment}"]'):
        href = anchor.get("href", "").strip()
        if not href or href in seen:
            continue
        seen.add(href)
        label = anchor.get_text(strip=True) or href.rstrip("/").split("/")[-1]
        links.append(
            {
                "url": abs_url(base_url, href),
                "label": label,
                "date": extract_upload_date_from_row(anchor.find_parent("tr")),
            }
        )
    return links


def popup_pdf_links(soup: Any, base_url: str, popup_name: str) -> list[dict[str, str]]:
    popup = soup.select_one(f"div[data_popup='{popup_name}']")
    if not popup:
        return []
    links: list[dict[str, str]] = []
    for row in popup.select("tbody tr"):
        anchor = row.select_one("a[href]")
        if not anchor:
            continue
        tds = row.find_all("td")
        links.append(
            {
                "url": abs_url(base_url, anchor["href"]),
                "filename": anchor.get_text(strip=True),
                "date": tds[2].get_text(strip=True) if len(tds) > 2 else "",
            }
        )
    return links


def parse_basic_info(soup: Any) -> dict[str, str]:
    info: dict[str, str] = {}
    for block in soup.select("div.left-block, div.right-block"):
        for pname in block.select("div.page_name"):
            label = pname.select_one("label")
            span = pname.select_one("span")
            if label and span:
                key = label.get_text(strip=True)
                value = span.get_text(strip=True)
                if key:
                    info[key] = value
    return info


def parse_manufacturers(soup: Any) -> list[dict[str, str]]:
    manufacturers: list[dict[str, str]] = []
    for item in soup.select("ul.page_name_list > li"):
        for div in item.find_all("div", recursive=False):
            header = div.find("h1")
            if not header:
                continue
            manufacturer: dict[str, str] = {"類型": header.get_text(strip=True)}
            for pname in div.select("div.page_name"):
                label = pname.select_one("label")
                span = pname.select_one("span")
                if label and span:
                    manufacturer[label.get_text(strip=True)] = span.get_text(strip=True)
            manufacturers.append(manufacturer)
    return manufacturers


def parse_sections(soup: Any) -> dict[str, Any]:
    sections: dict[str, Any] = {}
    toggle_all = soup.select_one("div.toggle-all")
    if not toggle_all:
        return sections

    strip_code = re.compile(r"^\d+(\.\d+)*\s+")
    for toggle in toggle_all.select(":scope > div.toggle"):
        title_el = toggle.select_one("div.toggle-title span.title-name")
        if not title_el:
            continue
        title = strip_code.sub("", title_el.get_text(strip=True))

        inner = toggle.select_one("div.toggle-inner div.inner")
        if not inner:
            sections[title] = ""
            continue

        direct_sub_tables = [
            table
            for table in inner.find_all("table", class_="sub-table")
            if table.find_parent("table", class_="sub-table") is None
        ]

        if direct_sub_tables:
            sub_dict: dict[str, Any] = {}
            for table in direct_sub_tables:
                tbody = table.find("tbody")
                if not tbody:
                    continue
                rows = tbody.find_all("tr", recursive=False)
                if len(rows) < 2:
                    continue
                name_cells = rows[0].find_all("td", class_="title-name")
                if not name_cells:
                    continue
                sub_key = name_cells[-1].get_text(strip=True)
                if not sub_key:
                    continue
                content_tds = rows[1].find_all("td")
                if len(content_tds) >= 2:
                    content = _clean_text(content_tds[1])
                    if content:
                        sub_dict[sub_key] = _listify_if_enumerated(content)
            sections[title] = sub_dict if sub_dict else ""
        else:
            sections[title] = _listify_if_enumerated(_clean_text(inner))

    return sections


def _normalize_quantity(raw: str) -> str | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return str(int(value)) if value == int(value) else f"{value:g}"


def _fix_ingredient_quantity(item: dict[str, str]) -> dict[str, str]:
    if item.get("含量"):
        return item
    normalized = _normalize_quantity(item.get("含量描述", ""))
    if normalized is not None:
        item["含量"] = normalized
    return item


def parse_ingredients(soup: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"處方標示": "", "成分": []}
    popup = soup.select_one("div[data_popup='popup-element']")
    if not popup:
        return result
    first_thead_td = popup.select_one("table:first-of-type thead tr td")
    if first_thead_td:
        result["處方標示"] = first_thead_td.get_text(strip=True)
    tables = popup.select("table")
    if len(tables) >= 2:
        headers = [th.get_text(strip=True) for th in tables[1].select("thead th")]
        for row in tables[1].select("tbody tr"):
            cells = [td.get_text(strip=True) for td in row.find_all("td")]
            if cells and len(cells) == len(headers):
                result["成分"].append(
                    _fix_ingredient_quantity(dict(zip(headers, cells)))
                )
    return result


def parse_atc_codes(soup: Any) -> list[dict[str, str]]:
    popup = soup.select_one("div[data_popup='popup-1']")
    if not popup:
        return []
    headers = [th.get_text(strip=True) for th in popup.select("thead th")]
    results: list[dict[str, str]] = []
    for row in popup.select("tbody tr"):
        cells = [td.get_text(strip=True) for td in row.find_all("td")]
        if cells:
            results.append(
                dict(zip(headers, cells)) if headers else {"raw": str(cells)}
            )
    return results


def parse_authorizations(soup: Any) -> list[dict[str, str]]:
    popup = soup.select_one("div[data_popup='popup-authorization']")
    if not popup:
        return []
    headers = [th.get_text(strip=True) for th in popup.select("thead th")]
    results: list[dict[str, str]] = []
    for row in popup.select("tbody tr"):
        cells = [td.get_text(strip=True) for td in row.find_all("td")]
        if cells and not any("查無資料" in cell for cell in cells):
            results.append(
                dict(zip(headers, cells)) if headers else {"raw": str(cells)}
            )
    return results


def has_electronic_insert_content(data: dict[str, Any]) -> bool:
    ingredients = data.get("ingredients", {})
    ingredient_rows = []
    if isinstance(ingredients, dict):
        ingredient_rows = ingredients.get("成分", []) or ingredients.get("æˆåˆ†", [])

    return any(
        [
            bool(data.get("basic_info")),
            bool(data.get("manufacturers")),
            bool(data.get("sections")),
            bool(data.get("atc_codes")),
            bool(ingredient_rows),
            bool(data.get("label_pdfs")),
            bool(data.get("history_pdfs")),
            bool(data.get("public_pdfs")),
            bool(data.get("paper_pdfs")),
            bool(data.get("authorizations")),
        ]
    )


def parse_shape_detail(soup: Any, shape_id: str, detail_url: str) -> dict[str, Any]:
    data: dict[str, Any] = {"shape_id": shape_id, "detail_url": detail_url}

    number = soup.find(string=re.compile(r"外觀編號"))
    if number:
        text = (
            number.get_text(" ", strip=True)
            if hasattr(number, "get_text")
            else str(number)
        )
        data["外觀編號"] = text.replace("外觀編號：", "").strip()

    for pname in soup.select("div.page_name"):
        label = pname.select_one("label")
        span = pname.select_one("span")
        if label and span:
            key = label.get_text(strip=True)
            value = span.get_text(strip=True)
            if key:
                data[key] = value

    for table in soup.select("table"):
        if table.find_parent("noscript"):
            continue
        for row in table.find_all("tr"):
            cells = row.find_all(["th", "td"])
            if len(cells) == 2:
                key = cells[0].get_text(strip=True)
                value = cells[1].get_text(separator="\n", strip=True)
                if key and not key.isdigit() and len(key) < 80 and key not in data:
                    data[key] = value

    for row in soup.select(".gridedit .row"):
        cols = row.select(":scope > .col")
        for idx in range(0, len(cols) - 1, 2):
            label = re.sub(r"\s+", "", cols[idx].get_text(" ", strip=True))
            value = cols[idx + 1].get_text(" ", strip=True)
            if label and label not in data:
                data[label] = value

    appearance_files: list[dict[str, str]] = []
    for row in soup.select(".upload_list_table tbody tr"):
        link = row.select_one("a[href]")
        if not link:
            continue
        file_name = link.get_text(" ", strip=True)
        href = link.get("href", "")
        upload_date = ""
        date_cell = row.select_one('[data-label*="上傳日期"]')
        if date_cell:
            upload_date = date_cell.get_text(" ", strip=True)
        appearance_files.append(
            {
                "filename": file_name,
                "upload_date": upload_date,
                "source_url": href,
            }
        )
    data["appearance_files"] = appearance_files
    return data


def parse_shape_list(soup: Any, base_url: str) -> list[dict[str, str]]:
    detail_links: list[dict[str, str]] = []
    for anchor in soup.select("a[href*='/im_shape_detail/']"):
        href = anchor.get("href", "")
        match = re.search(r"/im_shape_detail/([^?/]+)", href)
        shape_id = match.group(1) if match else f"shape_{len(detail_links)+1}"
        detail_links.append(
            {
                "shape_id": shape_id,
                "detail_url": abs_url(base_url, href),
                "label": anchor.get_text(" ", strip=True),
                "upload_date": extract_upload_date_from_row(anchor.find_parent("tr")),
            }
        )
    return detail_links


def infer_content_type(
    filename: str, fallback: str = "application/octet-stream"
) -> str:
    suffix = Path(filename).suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
        ".webp": "image/webp",
        ".json": "application/json",
        ".md": "text/markdown",
    }.get(suffix, fallback)


def parse_date(value: str) -> datetime | None:
    if not value:
        return None
    match = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", value)
    if not match:
        return None
    year, month, day = (int(part) for part in match.groups())
    try:
        return datetime(year, month, day)
    except ValueError:
        return None

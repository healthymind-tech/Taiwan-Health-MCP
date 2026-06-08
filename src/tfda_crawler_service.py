"""
Async TFDA enrichment scraper for Phase 2.

This service scrapes:
- electronic insert page
- insert PDF listing
- label PDF listing
- appearance records and images
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
from typing import Any

import httpx

from tfda_parser_utils import (
    BASE_HEADERS,
    UI_IMAGE_KEYWORDS,
    abs_url,
    collect_pdf_links,
    encode_license_id,
    extract_date_from_filename,
    filename_with_upload_date,
    has_electronic_insert_content,
    infer_content_type,
    make_soup,
    normalize_upload_date,
    parse_atc_codes,
    parse_authorizations,
    parse_basic_info,
    parse_ingredients,
    parse_manufacturers,
    parse_sections,
    parse_shape_detail,
    parse_shape_list,
    popup_pdf_links,
    safe_filename,
)
from utils import log_info, log_warning


@dataclass
class ScrapedAsset:
    asset_type: str
    asset_group: str
    source_page: str
    source_url: str
    source_filename: str
    normalized_filename: str
    upload_date: str
    mime_type: str
    content: bytes
    download_status: str = "success"
    downloaded_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def size_bytes(self) -> int:
        return len(self.content)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.content).hexdigest()


@dataclass
class AppearanceRecordScrape:
    shape_id: str
    detail_url: str
    raw_json: dict[str, Any]
    images: list[ScrapedAsset] = field(default_factory=list)


@dataclass
class DrugEnrichmentPayload:
    license_id: str
    electronic_insert: dict[str, Any] | None = None
    insert_assets: list[ScrapedAsset] = field(default_factory=list)
    label_assets: list[ScrapedAsset] = field(default_factory=list)
    appearance_records: list[AppearanceRecordScrape] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class TFDACrawlerService:
    def __init__(self, base_url: str | None = None, timeout: int | None = None) -> None:
        # Explicit args (from DB settings) take precedence; fall back to env.
        self.base_url = (
            (
                base_url
                if base_url
                else os.getenv("DRUG_TFDA_BASE_URL", "https://mcp.fda.gov.tw")
            )
        ).rstrip("/")
        self.timeout = int(timeout if timeout else os.getenv("DRUG_HTTP_TIMEOUT", "30"))

    async def _fetch(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        expect_binary: bool = False,
    ) -> httpx.Response | None:
        for attempt in range(1, 4):
            try:
                response = await client.get(
                    url, timeout=self.timeout, follow_redirects=True
                )
                if response.status_code == 404:
                    return None
                response.raise_for_status()
                return response
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code in (403, 404):
                    return None
                if attempt == 3:
                    raise
            except httpx.HTTPError:
                if attempt == 3:
                    raise
            await asyncio.sleep(min(2**attempt, 6))
        return None

    async def _download_asset(
        self,
        client: httpx.AsyncClient,
        *,
        asset_type: str,
        asset_group: str,
        source_page: str,
        source_url: str,
        source_filename: str,
        normalized_filename: str,
        upload_date: str,
    ) -> ScrapedAsset | None:
        response = await self._fetch(client, source_url, expect_binary=True)
        if response is None:
            return None
        mime_type = response.headers.get("content-type", "").split(";")[0].strip()
        if not mime_type:
            mime_type = infer_content_type(normalized_filename)
        return ScrapedAsset(
            asset_type=asset_type,
            asset_group=asset_group,
            source_page=source_page,
            source_url=source_url,
            source_filename=source_filename,
            normalized_filename=normalized_filename,
            upload_date=normalize_upload_date(upload_date)
            or extract_date_from_filename(normalized_filename),
            mime_type=mime_type,
            content=response.content,
        )

    async def _scrape_electronic_insert(
        self, client: httpx.AsyncClient, license_id: str
    ) -> dict[str, Any] | None:
        url = f"{self.base_url}/im_detail_1/{encode_license_id(license_id)}"
        response = await self._fetch(client, url)
        if response is None:
            return None
        soup = make_soup(response.text)
        data: dict[str, Any] = {
            "source_url": url,
            "license_no": license_id,
            "basic_info": parse_basic_info(soup),
            "manufacturers": parse_manufacturers(soup),
            "sections": parse_sections(soup),
            "atc_codes": parse_atc_codes(soup),
            "ingredients": parse_ingredients(soup),
            "label_pdfs": popup_pdf_links(soup, self.base_url, "popup-label"),
            "history_pdfs": popup_pdf_links(soup, self.base_url, "popup-history"),
            "public_pdfs": popup_pdf_links(soup, self.base_url, "popup-new1"),
            "paper_pdfs": popup_pdf_links(soup, self.base_url, "popup-new2"),
            "authorizations": parse_authorizations(soup),
        }
        return data if has_electronic_insert_content(data) else None

    async def _scrape_insert_page_links(
        self, client: httpx.AsyncClient, license_id: str
    ) -> list[dict[str, str]]:
        url = f"{self.base_url}/im_detail_pdf/{encode_license_id(license_id)}"
        response = await self._fetch(client, url)
        if response is None:
            return []
        soup = make_soup(response.text)
        links = collect_pdf_links(soup, self.base_url, "/insert/pdfcasefile/")
        if links:
            return links
        for anchor in soup.select("a[href]"):
            href = anchor.get("href", "")
            if "/insert/" in href or href.lower().endswith(".pdf"):
                label = anchor.get_text(strip=True) or href.split("/")[-1]
                links.append(
                    {
                        "url": abs_url(self.base_url, href),
                        "label": label,
                        "date": "",
                    }
                )
        return links

    async def _scrape_label_page_links(
        self, client: httpx.AsyncClient, license_id: str
    ) -> list[dict[str, str]]:
        url = f"{self.base_url}/im_label/{encode_license_id(license_id)}"
        response = await self._fetch(client, url)
        if response is None:
            return []
        soup = make_soup(response.text)
        links = collect_pdf_links(soup, self.base_url, "/insert/lablefiles/")
        enriched: list[dict[str, str]] = []
        table = soup.select_one("table")
        if table:
            for row in table.select("tr"):
                cells = row.find_all("td")
                anchor = row.select_one("a[href*='/insert/lablefiles/']")
                if not anchor:
                    continue
                href = anchor.get("href", "")
                label = (
                    cells[1].get_text(strip=True)
                    if len(cells) > 1
                    else anchor.get_text(strip=True)
                )
                if not label:
                    label = href.split("/")[-1].split("?")[0]
                enriched.append(
                    {
                        "url": abs_url(self.base_url, href),
                        "label": label,
                        "date": "",
                    }
                )
        return enriched or links

    async def _scrape_shapes(
        self, client: httpx.AsyncClient, license_id: str
    ) -> list[AppearanceRecordScrape]:
        url = f"{self.base_url}/im_shape/{encode_license_id(license_id)}"
        response = await self._fetch(client, url)
        if response is None:
            return []
        soup = make_soup(response.text)
        detail_links = parse_shape_list(soup, self.base_url)
        results: list[AppearanceRecordScrape] = []
        for item in detail_links:
            detail_response = await self._fetch(client, item["detail_url"])
            if detail_response is None:
                continue
            detail_soup = make_soup(detail_response.text)
            raw_data = parse_shape_detail(
                detail_soup, item["shape_id"], item["detail_url"]
            )
            image_assets: list[ScrapedAsset] = []
            appearance_files = raw_data.get("appearance_files", [])
            image_links = [
                abs_url(self.base_url, file_item.get("source_url", ""))
                for file_item in appearance_files
                if file_item.get("source_url")
            ]
            if not image_links:
                image_links = [
                    abs_url(self.base_url, image.get("src", ""))
                    for image in detail_soup.select("img[src]")
                ]
            image_index = 0
            for src in image_links:
                if any(keyword in src for keyword in UI_IMAGE_KEYWORDS):
                    continue
                image_index += 1
                file_meta = (
                    appearance_files[image_index - 1]
                    if image_index - 1 < len(appearance_files)
                    else {}
                )
                source_filename = (
                    file_meta.get("filename", "") or Path(src.split("?")[0]).name
                )
                suffix = Path(source_filename).suffix.lower()
                if suffix not in {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}:
                    suffix = ".jpg"
                normalized_filename = safe_filename(
                    f"{item['shape_id']}_image_{image_index:02d}{suffix}"
                )
                asset = await self._download_asset(
                    client,
                    asset_type="shape_image",
                    asset_group="shape",
                    source_page="im_shape",
                    source_url=src,
                    source_filename=source_filename,
                    normalized_filename=normalized_filename,
                    upload_date=file_meta.get("upload_date", ""),
                )
                if asset is not None:
                    image_assets.append(asset)
            results.append(
                AppearanceRecordScrape(
                    shape_id=item["shape_id"],
                    detail_url=item["detail_url"],
                    raw_json=raw_data,
                    images=image_assets,
                )
            )
        return results

    async def _download_pdf_links(
        self,
        client: httpx.AsyncClient,
        *,
        links: list[dict[str, str]],
        asset_type: str,
        asset_group: str,
        source_page: str,
    ) -> list[ScrapedAsset]:
        saved: list[ScrapedAsset] = []
        seen: set[str] = set()
        for item in links:
            source_url = item.get("url", "")
            if not source_url or source_url in seen:
                continue
            seen.add(source_url)
            source_filename = (
                item.get("filename") or item.get("label") or Path(source_url).name
            )
            if not source_filename.lower().endswith(".pdf"):
                source_filename += ".pdf"
            normalized_filename = safe_filename(
                filename_with_upload_date(source_filename, item.get("date", ""))
            )
            asset = await self._download_asset(
                client,
                asset_type=asset_type,
                asset_group=asset_group,
                source_page=source_page,
                source_url=source_url,
                source_filename=source_filename,
                normalized_filename=normalized_filename,
                upload_date=item.get("date", ""),
            )
            if asset is not None:
                saved.append(asset)
        return saved

    async def scrape_license(self, license_id: str) -> DrugEnrichmentPayload:
        payload = DrugEnrichmentPayload(license_id=license_id)
        headers = dict(BASE_HEADERS)
        headers["Referer"] = f"{self.base_url}/im"
        async with httpx.AsyncClient(headers=headers) as client:
            try:
                payload.electronic_insert = await self._scrape_electronic_insert(
                    client, license_id
                )
            except Exception as exc:
                payload.errors.append(f"electronic_insert: {exc}")

            insert_links: list[dict[str, str]] = []
            label_links: list[dict[str, str]] = []
            if payload.electronic_insert is not None:
                insert_links.extend(payload.electronic_insert.get("history_pdfs", []))
                insert_links.extend(payload.electronic_insert.get("public_pdfs", []))
                insert_links.extend(payload.electronic_insert.get("paper_pdfs", []))
                label_links.extend(payload.electronic_insert.get("label_pdfs", []))

            try:
                insert_links.extend(
                    await self._scrape_insert_page_links(client, license_id)
                )
            except Exception as exc:
                payload.errors.append(f"insert_page: {exc}")

            try:
                if not label_links:
                    label_links.extend(
                        await self._scrape_label_page_links(client, license_id)
                    )
            except Exception as exc:
                payload.errors.append(f"label_page: {exc}")

            try:
                payload.insert_assets = await self._download_pdf_links(
                    client,
                    links=insert_links,
                    asset_type="insert_pdf",
                    asset_group="insert",
                    source_page="im_detail_pdf",
                )
            except Exception as exc:
                payload.errors.append(f"insert_download: {exc}")

            try:
                payload.label_assets = await self._download_pdf_links(
                    client,
                    links=label_links,
                    asset_type="label_pdf",
                    asset_group="label",
                    source_page="im_label",
                )
            except Exception as exc:
                payload.errors.append(f"label_download: {exc}")

            try:
                payload.appearance_records = await self._scrape_shapes(
                    client, license_id
                )
            except Exception as exc:
                payload.errors.append(f"shape_scrape: {exc}")

        log_info(
            "TFDA enrichment scraped",
            license_id=license_id,
            has_electronic_insert=payload.electronic_insert is not None,
            insert_assets=len(payload.insert_assets),
            label_assets=len(payload.label_assets),
            appearance_records=len(payload.appearance_records),
            errors=len(payload.errors),
        )
        return payload

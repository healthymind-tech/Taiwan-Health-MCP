"""Download the Indra OCR model files at image BUILD time and verify them.

The runtime image never talks to Hugging Face: every file is fetched here from an
immutable commit of https://huggingface.co/datalab-to/indra-ocr and checked
against a pinned SHA-256, so a moved tag or a tampered file fails the build
instead of silently changing OCR output.

Only the files indra-ocr 0.3.2 loads without ``math=True`` are fetched (the math
models are ~20 MB more and are not used by this service), plus the model licence.

Usage: python fetch_models.py <dest-dir>
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

HF_REPO = "datalab-to/indra-ocr"
# Commit behind the tag v3.1.1 — the model set indra-ocr 0.3.2 was built and
# tested against (indra_ocr.models.HF_REVISION).
HF_COMMIT = "ed345c7f158eddbc7dee0c6a7269afb75a94f7e8"

FILES: dict[str, str] = {
    "det.onnx": "46b0050ce4c4692f887a1a9c038480223af1c7a91b3fcced2657d9cf00290dc4",
    "rec.onnx": "e243be069b357e56a0e867a21d7482e498df42fb19678bfb67a25f48b1f06151",
    "rec_cjk.onnx": "4cec840b55e1bb7f375daf30a2975404a867a71ac1a5bc5b1629c4909ce16baa",
    "script.onnx": "5ba37030e817affede0097a7503b6829624104166c6e0b6aacecacf919fc7d11",
    "order.onnx": "23635dd2324b4ccc00c408af961273a2dedd2e4f0386bc54dba678c41bcf6b46",
    "orient.onnx": "8d7bfce5d08bcad55955f41ca494a7f9d9d3ed5d5b6da1f6f276d5c509590729",
    "meta.json": "ff6ec58f91c93a475ae9505ad21c73c3ecda0b378f1d889dd83408e10832d1bb",
    "config.json": "cd143c66015620865d9d8361b1bb6f9781363b8e010d78c49b10d69009807d1d",
    "LICENSE": "50c88a018a7ee322e89f6b09401b237beb0cd331685879405b3db48993950a5f",
}


def fetch(name: str, sha256: str, dest: Path) -> None:
    url = f"https://huggingface.co/{HF_REPO}/resolve/{HF_COMMIT}/{name}"
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 (fixed https URL)
        data = resp.read()
    got = hashlib.sha256(data).hexdigest()
    if got != sha256:
        raise SystemExit(f"{name}: sha256 mismatch (expected {sha256}, got {got})")
    (dest / name).write_bytes(data)
    print(f"{name}: {len(data)} bytes, sha256 ok", file=sys.stderr)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: fetch_models.py <dest-dir>")
    dest = Path(sys.argv[1])
    dest.mkdir(parents=True, exist_ok=True)
    for name, sha in FILES.items():
        fetch(name, sha, dest)
    (dest / "REVISION").write_text(f"{HF_REPO}@{HF_COMMIT} (tag v3.1.1)\n")


if __name__ == "__main__":
    main()

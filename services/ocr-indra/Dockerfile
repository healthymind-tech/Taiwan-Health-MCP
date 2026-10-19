# ocr-indra — CPU-only OCR service (Indra OCR on ONNX Runtime) for drug inserts.
# The only Python in this repository; the backend itself is Node (node-server/).
#
#   docker build -t taiwan-health-mcp-ocr-indra services/ocr-indra
#
# Model weights are downloaded and sha256-verified at BUILD time (stage `models`),
# so the running container needs no internet access. ONNX Runtime >= 1.2x ships
# Microsoft 1DS telemetry in its Linux wheels; ORT_DISABLE_TELEMETRY=1 turns it
# off, and compose additionally puts this service on an `internal` network.

FROM python:3.12.13-slim AS models
COPY fetch_models.py /tmp/fetch_models.py
RUN python /tmp/fetch_models.py /models

FROM python:3.12.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    INDRA_OCR_MODEL_DIR=/opt/indra-ocr/models \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    ORT_DISABLE_TELEMETRY=1 \
    INDRA_PORT=8000

WORKDIR /srv
COPY requirements.txt /srv/requirements.txt
RUN pip install --no-cache-dir -r /srv/requirements.txt \
 && useradd --system --uid 10001 --user-group --home-dir /srv --no-create-home indra

COPY --from=models /models /opt/indra-ocr/models
COPY app /srv/app
COPY tests /srv/tests
COPY README.md /srv/README.md

USER indra
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]
CMD ["python", "-m", "app"]

# Receiver service (FastAPI) - API + reverse-proxies + SPA serving.
# Context is the server/ directory, so COPY paths are relative to it.

FROM python:3.11-slim AS base
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN set -eux; \
    rm -rf /var/lib/apt/lists/*; \
    pip install --no-cache-dir --upgrade pip

FROM base AS deps
# Install Python dependencies first (cached unless requirements.txt changes).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

FROM deps AS runtime
# No .env is baked in: secrets are injected at runtime via docker-compose
# (env_file pointing at server/.env). app.py's _load_env() reads /app/.env
# only if present, and os.environ (from compose) wins via setdefault.
COPY app.py ./
RUN mkdir -p /app/data
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]

# One image recipe for both Python extractors. Build from the repo root:
#   docker build -f services/Dockerfile --build-arg SERVICE=extractor-llm .
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ARG SERVICE
WORKDIR /app
COPY services/${SERVICE}/pyproject.toml services/${SERVICE}/uv.lock ./
RUN uv sync --frozen --no-dev
COPY services/${SERVICE}/*.py ./
# Answer key for LLM_PROVIDER=mock; unused by the other service.
COPY eval/fixtures/expected /fixtures/expected
RUN useradd -m worker
USER worker
ENTRYPOINT ["/app/.venv/bin/python", "main.py"]

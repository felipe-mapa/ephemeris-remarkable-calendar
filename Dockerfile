
FROM python:3.13-slim AS ephemeris

RUN apt-get update && apt-get install -y --no-install-recommends \
      libfreetype6 libjpeg62-turbo libpng16-16 poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY fonts /app/fonts
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY assets/cover.pdf /app/assets/cover.pdf
COPY ephemeris /app/ephemeris
COPY ephemeris.py .

CMD ["python", "ephemeris.py"]

# Build rmapi from source with the docSchema header fix (ddvk/rmapi PRs #63 + #65).
# The fix is needed because reMarkable's API started requiring file extensions
# on rm-filename headers (~2026-05-18), which broke all released rmapi versions.
FROM golang:1.23-alpine AS rmapi-builder
RUN apk add --no-cache git
RUN git clone https://github.com/ddvk/rmapi.git /rmapi
WORKDIR /rmapi
# Apply PR #65: ensureExtension() in blobstorage.go adds .docSchema to bare filenames,
# fixing the HTTP 400 reMarkable started returning for rm-filename headers without extension.
RUN git fetch origin refs/pull/65/head:pr65 && git checkout pr65
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /rmapi-bin .

# Ephemeris with patched rmapi
FROM ephemeris AS ephemeris-rmapi
COPY --from=rmapi-builder /rmapi-bin /usr/local/bin/rmapi


FROM python:3.13-slim AS remarkable-calendar

RUN apt-get update && apt-get install -y --no-install-recommends \
      libfreetype6 libjpeg62-turbo libpng16-16 poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY fonts /app/fonts
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY assets/cover.pdf /app/assets/cover.pdf
COPY remarkable_calendar /app/remarkable_calendar
COPY remarkable_calendar.py .

CMD ["python", "remarkable_calendar.py"]

# Build rmapi from source at current master.
#
# Historically this build checked out ddvk/rmapi PR #65 (a since-abandoned, never-rebased
# branch that added an ensureExtension() fix for the rm-filename header reMarkable started
# requiring around 2026-05-18). By 2026-09 that branch was 26 commits behind master and
# missing master's own schema-v4 upload support (PR #36, merged 2025-11-22) entirely, which
# made downloads work (master's `root.docSchema` handling covers PR #65's fix a different
# way) but broke uploads outright (HTTP 400 on every `rmapi put`) because schema v4 hashing
# was simply absent from the pr65 checkout. Building plain master gets both fixes together;
# if `rmapi put`/`get` regress again, re-check whether master's default branch changed name
# or whether a new upstream fix needs pinning here (see ddvk/rmapi issues for "400").
FROM golang:1.23-alpine AS rmapi-builder
RUN apk add --no-cache git
RUN git clone https://github.com/ddvk/rmapi.git /rmapi
WORKDIR /rmapi
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /rmapi-bin .

# reMarkableCalendar with patched rmapi
FROM remarkable-calendar AS remarkable-calendar-rmapi
COPY --from=rmapi-builder /rmapi-bin /usr/local/bin/rmapi

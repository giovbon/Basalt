# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Build (usa binário pré-compilado se existir, ou compila nativamente)
# -----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS builder

WORKDIR /src

ENV GOTOOLCHAIN=auto

ARG TARGETOS
ARG TARGETARCH

RUN apk add --no-cache ca-certificates tzdata

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN if [ -f "bin/notediscovery-${TARGETARCH}" ]; then \
        echo "Usando binario pre-compilado para ${TARGETARCH}"; \
        cp "bin/notediscovery-${TARGETARCH}" /notediscovery; \
    else \
        echo "Compilando para ${TARGETOS}/${TARGETARCH}"; \
        CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build \
            -trimpath \
            -ldflags="-s -w" \
            -o /notediscovery \
            ./cmd/notediscovery; \
    fi

# -----------------------------------------------------------------------------
# Stage 2: Runtime Minimal
# -----------------------------------------------------------------------------
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /notediscovery /app/notediscovery
COPY --from=builder /src/config.yaml /app/config.yaml
COPY --from=builder /src/VERSION /app/VERSION

RUN mkdir -p /app/data && chown -R appuser:appgroup /app

USER appuser

EXPOSE 8000

ENV PORT=8000 \
    NOTES_DIR=/app/data

VOLUME ["/app/data"]

ENTRYPOINT ["/app/notediscovery"]

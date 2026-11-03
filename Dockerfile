# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Build (usa binário pré-compilado se existir, ou compila nativamente)
# -----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder

WORKDIR /src

ENV GOTOOLCHAIN=auto

# Definido linux como padrão para TARGETOS
ARG TARGETOS=linux
ARG TARGETARCH

RUN apk add --no-cache ca-certificates tzdata

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# 1. Ajustado para detectar a arquitetura nativa se TARGETARCH estiver vazio
RUN set -e; \
    ARCH="${TARGETARCH:-$(go env GOARCH)}"; \
    if [ -f "bin/basalt-${ARCH}" ]; then \
        echo "Usando binario pre-compilado para ${ARCH}"; \
        cp "bin/basalt-${ARCH}" /basalt; \
    else \
        echo "Compilando nativamente para ${TARGETOS}/${ARCH}"; \
        CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${ARCH} go build \
            -trimpath \
            -ldflags="-s -w" \
            -o /basalt \
            ./cmd/basalt; \
    fi; \
    if ! head -c 4 /basalt | grep -q "ELF"; then \
        echo "ERRO: /basalt nao e um executavel ELF."; \
        echo "O pacote main nao foi compilado - verifique o caminho ./cmd/basalt no Dockerfile."; \
        exit 1; \
    fi; \
    echo "OK: binario ELF gerado para ${TARGETOS:-linux}/${ARCH}"

# -----------------------------------------------------------------------------
# Stage 2: Runtime Minimal
# -----------------------------------------------------------------------------
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /basalt /app/basalt
COPY --from=builder /src/config.yaml /app/config.yaml
COPY --from=builder /src/VERSION /app/VERSION

# 2. Adicionado 'chmod +x' e garantida a permissão completa do appuser
RUN chmod +x /app/basalt && \
    mkdir -p /app/data && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 8000

ENV PORT=8000 \
    NOTES_DIR=/app/data

VOLUME ["/app/data"]

ENTRYPOINT ["/app/basalt"]
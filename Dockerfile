# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Build
# -----------------------------------------------------------------------------
FROM golang:1.22-alpine AS builder

WORKDIR /src

ENV GOTOOLCHAIN=auto

# Instala certificados para dependências caso necessário
RUN apk add --no-cache ca-certificates tzdata

# Cache de dependências do Go
COPY go.mod go.sum ./
RUN go mod download

# Copia todo o código-fonte (incluindo web/ embutido via go:embed)
COPY . .

# Compila binário estático e enxuto
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /notediscovery \
    ./cmd/notediscovery

# -----------------------------------------------------------------------------
# Stage 2: Runtime Minimal
# -----------------------------------------------------------------------------
FROM alpine:3.20

# Certificados SSL e timezone
RUN apk add --no-cache ca-certificates tzdata

# Cria usuário não-root para segurança
RUN addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S appuser -G appgroup

WORKDIR /app

# Copia o binário e arquivos de configuração padrão
COPY --from=builder /notediscovery /app/notediscovery
COPY --from=builder /src/config.yaml /app/config.yaml
COPY --from=builder /src/VERSION /app/VERSION

# Diretório padrão para os dados do cofre
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

USER appuser

EXPOSE 8000

ENV PORT=8000 \
    NOTES_DIR=/app/data

VOLUME ["/app/data"]

ENTRYPOINT ["/app/notediscovery"]

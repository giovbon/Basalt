#!/usr/bin/env bash
set -e

# Muda para o diretório onde o script reside
cd "$(dirname "$0")"

echo "=========================================="
echo "         Iniciando NoteDiscovery (Go)     "
echo "=========================================="

# Garante que Go está instalado
if ! command -v go >/dev/null 2>&1; then
    echo "Erro: Go não foi encontrado no PATH. Instale o Go 1.22 ou superior."
    exit 1
fi

# Cria o diretório de dados padrão se não existir
mkdir -p data

echo "Compilando NoteDiscovery..."
go build -o notediscovery ./cmd/notediscovery

# Determina a porta (PORT env var > 8000)
PORT="${PORT:-8000}"
export PORT

echo "Servidor pronto!"
echo "Acesse no navegador: http://localhost:${PORT}"
echo "Pressione Ctrl+C para encerrar."
echo "=========================================="
echo ""

exec ./notediscovery

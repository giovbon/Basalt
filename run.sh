#!/usr/bin/env bash
set -e

# Muda para o diretório onde o script reside
cd "$(dirname "$0")"

echo "=========================================="
echo "         Iniciando Basalt (Go)            "
echo "=========================================="

# Garante que Go está instalado
if ! command -v go >/dev/null 2>&1; then
    echo "Erro: Go não foi encontrado no PATH. Instale o Go 1.22 ou superior."
    exit 1
fi

# Determina a porta (PORT env var > 8000)
PORT="${PORT:-8000}"
export PORT

# Libera a porta se já estiver em uso por outra instância
free_port() {
    local port="$1"
    local pids=""

    if command -v fuser >/dev/null 2>&1; then
        if fuser "${port}/tcp" >/dev/null 2>&1; then
            echo "Porta ${port} em uso. Encerrando processo anterior..."
            fuser -k -TERM "${port}/tcp" >/dev/null 2>&1 || true
            sleep 0.5
            if fuser "${port}/tcp" >/dev/null 2>&1; then
                fuser -k -9 "${port}/tcp" >/dev/null 2>&1 || true
                sleep 0.5
            fi
        fi
    elif command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -ti :"$port" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "Porta ${port} em uso (PIDs: $pids). Encerrando..."
            kill -15 $pids 2>/dev/null || true
            sleep 0.5
            pids=$(lsof -ti :"$port" 2>/dev/null || true)
            if [ -n "$pids" ]; then
                kill -9 $pids 2>/dev/null || true
                sleep 0.5
            fi
        fi
    fi
}

free_port "$PORT"

# Cria o diretório de dados padrão se não existir
mkdir -p data

echo "Compilando Basalt..."
build_basalt() {
    go build -o basalt ./cmd/basalt
}

# go.mod exige Go 1.23+. Se o Go instalado for mais antigo, o próprio Go tenta
# baixar o toolchain exigido; quando esse download não está disponível, usa um
# toolchain que já esteja no cache de módulos em vez de abortar.
if ! build_basalt; then
    # GOTOOLCHAIN=local: entra em go.mod com o Go instalado, sem tentar trocar de
    # toolchain (é justamente essa troca que falhou acima).
    module_cache=$(GOTOOLCHAIN=local go env GOMODCACHE 2>/dev/null)
    cached_toolchain=$(ls -d "${module_cache:-$HOME/go/pkg/mod}"/golang.org/toolchain@v0.0.1-go* 2>/dev/null \
        | sed -e 's|.*toolchain@v0\.0\.1-||' -e 's|\.[a-z0-9]*-[a-z0-9]*$||' \
        | sort -uV | tail -1)
    if [ -n "$cached_toolchain" ]; then
        echo "Go local não atende ao go.mod; usando toolchain em cache: ${cached_toolchain}"
        GOTOOLCHAIN="$cached_toolchain" build_basalt
    else
        echo "" >&2
        echo "Erro: o go.mod exige Go 1.23 ou superior e o download do toolchain falhou." >&2
        echo "Instale o Go 1.23+ (ou libere o download de toolchains) e rode de novo." >&2
        exit 1
    fi
fi

echo "Servidor pronto!"
echo "Acesse no navegador: http://localhost:${PORT}"
echo "Pressione Ctrl+C para encerrar."
echo "=========================================="
echo ""

exec ./basalt
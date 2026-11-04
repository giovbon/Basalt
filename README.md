# Basalt (Go) 🌋

Uma aplicação rápida, leve e autocontida para gerenciamento de notas em Markdown, suporte a tags, links bidirecionais (wikilinks), grafo visual, mídias (áudio, vídeo, PDFs, imagens) e busca instantânea de texto completo.

Esta versão possui o **backend totalmente reescrito em Go**, mantendo paridade com o frontend e oferecendo inicialização instantânea, baixo consumo de memória (~20MB) e distribuição em binário único sem dependências externas. Baseado em [notediscovery](https://github.com/gamosoft/NoteDiscovery).

## Como Rodar Localmente

### Pré-requisitos
- [Go](https://go.dev/) 1.23 ou superior instalado.

### Executando com o script facilitador

Basta rodar na raiz do projeto:

```bash
./run.sh
```

O script:
1. Compila o binário automaticamente.
2. Libera a porta caso haja alguma instância anterior presa.
3. Cria a pasta `./data` para suas notas (se ainda não existir).
4. Inicia o servidor e disponibiliza o app em **http://localhost:8000**.

Para rodar em outra porta:
```bash
PORT=8080 ./run.sh
```

### Desenvolvimento: alterando a interface

O JavaScript é modular: as fontes ficam em `web/frontend/src/` (ES modules) e
são empacotadas em `web/frontend/app.js` pelo esbuild. **Não edite `app.js`** —
ele é gerado. Depois de mexer em `src/`:

```bash
./build-js.sh        # requer Node.js/npm; regenera app.js + app.js.map
node --test          # a partir de web/frontend/: testes dos módulos puros
```

O CSS do Tailwind é pré-compilado em `web/frontend/tailwind.css` (substitui o
antigo Play CDN de 408 KB que compilava estilos em runtime no navegador). Se
você adicionar ou renomear classes Tailwind em `index.html`/`src/`, regenere
o CSS e commite junto com a mudança:

```bash
./build-tailwind.sh   # requer Node.js/npm
```

## Como Rodar com Docker & Docker Compose

### Usando o `docker-compose.yml`

Para subir o Basalt com persistência das suas notas na pasta `./data`:

```bash
docker compose up -d
```

Acesse no navegador: **http://localhost:8000**

Para parar a aplicação:
```bash
docker compose down
```

### Exemplo de `docker-compose.yml`

```yaml
services:
  basalt:
    image: giovbon/basalt:latest
    # Ou para construir a partir do código fonte:
    # build: .
    container_name: basalt
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - PORT=8000
      - NOTES_DIR=/app/data
      - APP_NAME=Basalt
      - DEFAULT_THEME=light
      # Autenticação (opcional):
      # - AUTHENTICATION_ENABLED=true
      # - AUTHENTICATION_PASSWORD=sua_senha_segura
      # - AUTHENTICATION_SECRET_KEY=sua_chave_secreta_longa
    volumes:
      - ./data:/app/data
```

### Rodando diretamente via `docker run`

```bash
docker run -d \
  --name basalt \
  -p 8000:8000 \
  -v $(pwd)/data:/app/data \
  -e APP_NAME="Basalt" \
  giovbon/basalt:latest
```

## Variáveis de Ambiente Suportadas

Todas as variáveis podem ser definidas no ambiente ou via `docker-compose.yml`:

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `PORT` | `8000` | Porta HTTP em que o servidor escutará. |
| `NOTES_DIR` | `./data` | Diretório onde as notas e anexos são armazenados. |
| `INDEX_FILE` | `.basalt-index.gob` ao lado do `config.yaml` | Caminho do cache do índice (gob, descartável). Em Docker, aponte para um volume montado (ex.: `/app/data/.basalt-index.gob`) para manter o índice quente entre restarts. |
| `APP_NAME` | `Basalt` | Nome exibido na interface e no título da aba. |
| `DEFAULT_THEME` | `light` | Tema inicial (`light`, `dark`, `dracula`, `nord`, etc.). |
| `AUTOSAVE_DELAY_MS` | `1000` | Debounce de salvamento automático (250ms a 60000ms). |
| `AUTHENTICATION_ENABLED` | `false` | Ativa a tela de login para proteger o cofre. |
| `AUTHENTICATION_PASSWORD` | `admin` | Senha de login (hasheada com bcrypt na inicialização). |
| `AUTHENTICATION_SECRET_KEY` | *(default inseguro)* | Chave secreta para assinar cookies HMAC de sessão. |
| `AUTHENTICATION_API_KEY` | *(vazio)* | Token para integrações via `Authorization: Bearer` ou `X-API-Key`. |
| `UPLOAD_MAX_IMAGE_MB` | `10` | Tamanho máximo de imagem permitido em upload. |
| `UPLOAD_MAX_AUDIO_MB` | `50` | Tamanho máximo de áudio permitido em upload. |
| `UPLOAD_MAX_VIDEO_MB` | `100` | Tamanho máximo de vídeo permitido em upload. |
| `UPLOAD_MAX_PDF_MB` | `20` | Tamanho máximo de PDF permitido em upload. |
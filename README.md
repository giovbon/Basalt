# NoteDiscovery (Go) 🚀

Uma aplicação rápida, leve e autocontida para gerenciamento de notas em Markdown, suporte a tags, links bidirecionais (wikilinks), grafo visual, mídias (áudio, vídeo, PDFs, imagens), desenhos interativos e busca instantânea de texto completo.

Esta versão possui o **backend totalmente reescrito em Go**, mantendo paridade com o frontend e oferecendo inicialização instantânea, baixo consumo de memória (~20MB) e distribuição em binário único sem dependências externas.

---

## ⚡ Como Rodar Localmente

### Pré-requisitos
- [Go](https://go.dev/) 1.22 ou superior instalado.

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

---

## 🐳 Como Rodar com Docker & Docker Compose

### Usando o `docker-compose.yml`

Para subir o NoteDiscovery com persistência das suas notas na pasta `./data`:

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
  notediscovery:
    image: SEU_USUARIO_DOCKERHUB/notediscovery:latest
    # Ou para construir a partir do código fonte:
    # build: .
    container_name: notediscovery
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - PORT=8000
      - NOTES_DIR=/app/data
      - APP_NAME=NoteDiscovery
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
  --name notediscovery \
  -p 8000:8000 \
  -v $(pwd)/data:/app/data \
  -e APP_NAME="NoteDiscovery" \
  SEU_USUARIO_DOCKERHUB/notediscovery:latest
```

---

## ⚙️ Variáveis de Ambiente Suportadas

Todas as variáveis podem ser definidas no ambiente ou via `docker-compose.yml`:

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `PORT` | `8000` | Porta HTTP em que o servidor escutará. |
| `NOTES_DIR` | `./data` | Diretório onde as notas e anexos são armazenados. |
| `APP_NAME` | `NoteDiscovery` | Nome exibido na interface e no título da aba. |
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

---

## 🤖 GitHub Actions: Build & Push para o Docker Hub

O projeto inclui um workflow automático em `.github/workflows/docker-publish.yml` que:
1. Faz o build de imagens **multi-arquitetura** (`linux/amd64` e `linux/arm64`).
2. Publica as tags no Docker Hub a cada push na branch `main` ou `master` e em novas releases (`v*.*.*`).
3. Utiliza cache nativo do GitHub Actions para builds rápidos.

### Configurando no seu Repositório do GitHub:
No seu repositório no GitHub, vá em **Settings** > **Secrets and variables** > **Actions** e crie os dois segredos:
- `DOCKERHUB_USERNAME`: Seu nome de usuário no Docker Hub.
- `DOCKERHUB_TOKEN`: Um Personal Access Token (PAT) gerado nas configurações da sua conta no Docker Hub (com permissão de *Read & Write*).

Feito isso, a cada push para a branch principal, a imagem será automaticamente construída e enviada para o Docker Hub.

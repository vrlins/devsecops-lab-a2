# Lab A4 — Parte 0: Evoluir o Pipeline

## Adicionar Semgrep (SAST) + Publicar Imagem no GHCR

**Autor:** Victor Raffael Lins Carlota

---

## RESUMO

Nesta prática, vamos evoluir o workflow do GitHub Actions criado na A2 com dois novos stages:

1. **Semgrep (SAST)** — análise estática de segurança com regras OWASP Top 10
2. **Publicação no GHCR** — push da imagem Docker para o GitHub Container Registry

Ao final, o pipeline ficará:

```
lint → semgrep → test → build → push GHCR → scan (SCA + secrets + image) → gate
```

E a imagem estará disponível em `ghcr.io/SEU-USER/devsecops-lab-a2:latest`.

---

## 1. Pré-Requisitos

- Repositório `devsecops-lab-a2` com pipeline CI da A2 funcional
- Conta no GitHub com GitHub Actions habilitado
- Repositório **público** (GHCR gratuito para repos públicos)

```bash
cd devsecops-lab-a2
```

---

## 2. Configurar Permissões do GHCR

O GitHub Container Registry precisa de permissão para receber push. Vamos configurar no workflow.

### 2.1 Manter o padrão do repositório em leitura

Em **Settings → Actions → General → Workflow permissions**, mantenha **Read repository contents and packages permissions** (padrão).

> **Por quê?** A escrita no GHCR será concedida explicitamente no workflow (`packages: write`, seção 4.2). Assim o privilégio fica documentado no código, revisável em PR, e qualquer job que não declare permissões continua só com leitura. Ampliar o padrão do repositório para "Read and write" dá escrita a **todos** os workflows — inclusive os que você ainda não escreveu.

---

## 3. Adicionar Semgrep ao Workflow

### 3.1 O que é Semgrep

Semgrep é uma ferramenta de SAST (Static Application Security Testing) que analisa o código-fonte buscando padrões de vulnerabilidade. Diferente do ESLint (que foca em estilo e erros de sintaxe), o Semgrep foca em **segurança**: SQL injection, command injection, XSS, SSRF, e outros padrões do OWASP Top 10.

### 3.2 Adicionar o job ao workflow

Edite o arquivo `.github/workflows/devsecops.yml`.

Adicione o job `semgrep` **após** o job `lint` e **antes** do job `test`:

```yaml
  # ============================================
  # Stage 2: Semgrep (SAST - Security Analysis)
  # ============================================
  semgrep:
    name: "🔎 Semgrep - SAST"
    runs-on: ubuntu-latest
    needs: lint                       # Roda após o lint
    container:
      image: semgrep/semgrep          # Imagem oficial do Semgrep
    steps:
      - name: Checkout do código
        uses: actions/checkout@v4

      - name: Semgrep Scan
        run: semgrep scan --config p/owasp-top-ten --error
```

> A antiga `returntocorp/semgrep-action` está **depreciada**; o caminho recomendado é rodar o CLI dentro do container oficial, como acima.

> **O que cada parte faz:**
> - `container: image: semgrep/semgrep` — roda dentro do container oficial (não precisa instalar)
> - `--config p/owasp-top-ten` — usa o conjunto de regras OWASP Top 10 do registry
> - `--error` — retorna exit code 1 se encontrar findings (bloqueia o pipeline)

### 3.3 Atualizar o `needs` do job `test`

O job `test` agora deve depender do `semgrep` em vez de (ou além de) `lint`:

```yaml
  test:
    name: "🧪 Jest - Testes Unitários"
    runs-on: ubuntu-latest
    needs: semgrep                    # Roda após o Semgrep (que roda após lint)
```

> Isso garante a sequência: lint → semgrep → test → build → ...

---

## 4. Adicionar Push ao GHCR

### 4.1 O que é o GHCR

O GitHub Container Registry (ghcr.io) é o registry de imagens Docker integrado ao GitHub. Vantagens:

- Autenticação automática com `GITHUB_TOKEN` (sem configurar credenciais extras)
- Gratuito para repositórios públicos
- Imagens ficam vinculadas ao repositório (rastreabilidade; provenance **assinada** exige attestation — veremos na A6)

### 4.2 Adicionar permissões no topo do workflow

No início do arquivo `.github/workflows/devsecops.yml`, adicione `permissions` no nível do workflow (logo após `env:`):

```yaml
name: DevSecOps Pipeline

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

permissions:
  contents: read                      # Leitura do código
  packages: write                     # Escrita no GHCR
```

### 4.3 Adicionar steps de push no job `build`

No job `build`, adicione os steps de login e push **após** o step de `docker build`:

```yaml
  build:
    name: "🐳 Docker Build + Push"
    runs-on: ubuntu-latest
    needs: test
    steps:
      - name: Checkout do código
        uses: actions/checkout@v4

      - name: Build da imagem Docker
        run: docker build -t devsecops-lab-a2:${{ github.sha }} .

      - name: Verificar tamanho da imagem
        run: |
          docker images devsecops-lab-a2:${{ github.sha }} --format "Tamanho: {{.Size}}"

      - name: Login no GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Nome da imagem em minúsculas
        # O registry exige minúsculas; github.repository pode ter maiúsculas (ex.: SEU-User)
        run: echo "IMAGE=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"

      - name: Tag da imagem para GHCR
        run: |
          docker tag devsecops-lab-a2:${{ github.sha }} "$IMAGE:${{ github.sha }}"
          docker tag devsecops-lab-a2:${{ github.sha }} "$IMAGE:latest"

      - name: Push para GHCR
        run: |
          docker push "$IMAGE:${{ github.sha }}"
          docker push "$IMAGE:latest"

      - name: Salvar imagem como artefato
        run: docker save devsecops-lab-a2:${{ github.sha }} -o image.tar

      - name: Upload do artefato
        uses: actions/upload-artifact@v4
        with:
          name: docker-image
          path: image.tar
          retention-days: 1
```

> **O que mudou:**
> - `docker/login-action@v3` autentica no GHCR usando o `GITHUB_TOKEN` (automático, sem secrets manuais)
> - Criamos duas tags: uma com o SHA do commit (rastreável — só o **digest** `@sha256:` é realmente imutável) e uma `latest` (conveniente)
> - O push acontece ANTES do scan — assim a imagem fica no registry mesmo que o scan encontre problemas (útil para debug)
> - O artefato continua sendo salvo para os jobs seguintes (scan + gate)

---

## 5. Workflow Completo

Para referência, o workflow final deve ter esta estrutura de jobs:

```
jobs:
  lint:        (ESLint)
  semgrep:     (SAST - OWASP Top 10)     ← NOVO
  test:        (Jest + coverage)
  build:       (Docker build + push GHCR)  ← ATUALIZADO
  security-scan: (Trivy SCA + secrets + image)
  security-gate: (exit-code 1 se CRITICAL)
```

Com a cadeia de `needs`:

```
lint → semgrep → test → build → security-scan → security-gate
```

---

## 6. Push e Verificar

### 6.1 Commit e push

```bash
git add .github/workflows/devsecops.yml
git commit -m "feat: add Semgrep SAST + GHCR publish to pipeline"
git push
```

### 6.2 Acompanhar execução

```bash
# Via GitHub CLI
gh run watch

# Ou acesse:
# https://github.com/SEU-USER/devsecops-lab-a2/actions
```

### 6.3 Verificar os 6 stages

Você deve ver:

```
🔍 ESLint - Análise Estática       ✅
🔎 Semgrep - SAST                  ✅ (ou ❌ se encontrar findings)
🧪 Jest - Testes Unitários         ✅
🐳 Docker Build + Push             ✅
🛡️ Trivy - Security Scan          ✅
🚨 Security Gate                   ✅ ou ❌
```

### 6.4 Verificar imagem no GHCR

Acesse no GitHub:

```
Seu repositório → Packages (na sidebar direita)
```

Ou via URL direta:

```
https://github.com/SEU-USER/devsecops-lab-a2/pkgs/container/devsecops-lab-a2
```

Você verá a imagem com as tags:
- `latest`
- SHA do commit (ex: `a1b2c3d4e5f6...`)

### 6.5 Pull da imagem (de qualquer máquina)

```bash
docker pull ghcr.io/SEU-USER/devsecops-lab-a2:latest
docker run -p 3000:3000 ghcr.io/SEU-USER/devsecops-lab-a2:latest
curl http://localhost:3000/health
```

---

## 7. Testar o Semgrep

### 7.1 Provocar uma falha de SAST

Adicione código inseguro no `src/app.js` para ver o Semgrep bloquear:

```javascript
// INSEGURO — SQL injection via concatenação de string
app.get('/api/search', (req, res) => {
  const query = "SELECT * FROM messages WHERE text = '" + req.query.q + "'";
  pool.query(query).then(r => res.json(r.rows));
});
```

```bash
git add . && git commit -m "test: add SQL injection for Semgrep" && git push
```

O Semgrep deve detectar a concatenação de string em query SQL e **bloquear** o pipeline.

### 7.2 Corrigir

Substitua por parameterized query:

```javascript
// SEGURO — parameterized query
app.get('/api/search', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM messages WHERE text = $1',
    [req.query.q]
  );
  res.json(result.rows);
});
```

```bash
git add . && git commit -m "fix: use parameterized query" && git push
```

Pipeline deve passar.

---

## 8. Troubleshooting

**Problema:** Push para GHCR falha com "permission denied"
**Solução:** Verifique se `permissions: packages: write` está no workflow (ou no job `build`) e se o nome da imagem está em minúsculas. Na primeira publicação, confira em Package settings se o repositório tem acesso de escrita ao pacote.

**Problema:** Semgrep bloqueia com `express-check-csurf-middleware-usage` mesmo sem código novo
**Solução:** é uma regra de **auditoria** (pede proteção CSRF em apps Express). Nossa API é stateless e não usa cookie de sessão, então CSRF não se aplica. Registre a decisão no código, com justificativa, em vez de desligar o scan:
```javascript
const app = express(); // nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage -- API stateless, sem cookies
```

**Problema:** Semgrep encontra falsos positivos
**Solução:** Crie um arquivo `.semgrepignore` na raiz com os paths a ignorar, ou use `// nosemgrep` como comentário inline no código para suprimir findings específicos.

**Problema:** Imagem não aparece em Packages
**Solução:** Após o primeiro push, o package pode estar com visibilidade "private". Acesse Package Settings e altere para "public" se o repo for público.

---

## Estrutura do Pipeline Final

```
┌─────────┐    ┌──────────┐     ┌──────────┐    ┌────────────────┐
│  lint   │───►│ semgrep  │────►│  test    │───►│ build + push   │
│ (ESLint)│    │ (SAST)   │     │ (Jest)   │    │ (GHCR)         │
└─────────┘    └──────────┘     └──────────┘    └───────┬────────┘
                                                        │
                                                        ▼
                                               ┌────────────────┐
                                               │ security-scan  │
                                               │ SCA + secrets  │
                                               │ + image scan   │
                                               └────────┬───────┘
                                                        │
                                                        ▼
                                               ┌────────────────┐
                                               │ security-gate  │
                                               │ exit-code 1    │
                                               └────────────────┘
```

---

## Conexão com a Disciplina

| Conceito | Onde aplicamos |
|----------|---------------|
| SAST (A3) | Semgrep com regras OWASP Top 10 no pipeline |
| Container Registry (A4) | Publicação da imagem no GHCR |
| Supply Chain | Imagem versionada por SHA do commit (provenance) |
| CI evolui para CD | Imagem publicada = pronta para deploy (A5) |
| Defense in Depth | Lint + SAST + Test + SCA + Secrets + Image Scan |

---

## Referências

1. **Semgrep Registry** — https://semgrep.dev/explore
2. **Semgrep Docs (CI)** — https://semgrep.dev/docs/ (a `semgrep-action` está depreciada)
3. **GHCR Documentation** — https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
4. **docker/login-action** — https://github.com/docker/login-action

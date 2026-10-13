# Lab A5 — Parte 1: Hardening + Deploy K8s no Pipeline

## Kind no GitHub Actions — CD com Kubernetes Real

**Autor:** Victor Raffael Lins Carlota
**Disciplina:** DevSecOps — Aula 5: DAST e API Security com ZAP
**Pré-requisito:** Lab A4 concluído (manifests K8s em k8s/, imagem no GHCR)

---

## RESUMO

Nesta prática, vamos:

1. **Hardening do backend** — adicionar headers de segurança, rate limiting e CORS
2. **Deploy K8s automatizado** — Kind no GitHub Actions usando os mesmos manifests da A4

Ao final, o pipeline terá um novo job que cria um cluster Kind efêmero, puxa a imagem do GHCR, e aplica os manifests K8s com `kubectl apply -f k8s/`.

---

## 1. Pré-Requisitos

- Repositório `devsecops-lab-a2` com pipeline da A4 funcional
- Imagem publicada no GHCR
- Manifests K8s no diretório `k8s/` (da A4 Parte 2)

```bash
cd devsecops-lab-a2
ls k8s/
# Esperado: configmap.yaml  secret.yaml  postgres-deployment.yaml
#           postgres-service.yaml  init-db-job.yaml
#           app-deployment.yaml  app-service.yaml  network-policy.yaml
```

---

## 2. Hardening do Backend

### 2.1 Instalar dependências de segurança

```bash
npm install helmet express-rate-limit cors
```

> - **helmet**: configura ~15 headers HTTP de segurança com uma linha
> - **express-rate-limit**: limita requests por IP (previne DoS e brute force)
> - **cors**: controla quais origens podem acessar a API

### 2.2 Adicionar middlewares ao app.js

Edite `src/app.js`. Adicione os imports **após** `const express = require('express');`:

```javascript
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
```

Adicione os middlewares **antes** de `app.use(express.json());`:

```javascript
// Security headers — configuração completa
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      frameAncestors: ["'none'"],      // Previne clickjacking (iframe)
      formAction: ["'self'"],           // Restringe destino de formulários
    }
  }
}));

// Permissions-Policy: o helmet NÃO emite este header — middleware próprio
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Atrás de proxy (Render, Ingress), req.ip precisa vir do X-Forwarded-For;
// sem isso, o rate limit trata todos os usuários como um único IP.
// Mas SÓ confie no header quando houver proxy: exposto direto, qualquer cliente
// forja X-Forwarded-For e escapa do rate limit. Por isso é configurável:
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));   // Render: 1

// Remove "X-Powered-By: Express" (information disclosure)
app.disable('x-powered-by');

// Rate limiting: 100 requests por 15 minutos por IP
// /health fica FORA do limite: os probes do kubelet (a cada 5–15s) estourariam
// 100 req/15min e o pod seria marcado unready / reiniciado com 429.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  skip: (req) => req.path === '/health',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' }
}));

// CORS restrito (NÃO usar origin: '*' — é finding MEDIUM no ZAP)
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://devsecops-lab-a2.onrender.com',
  methods: ['GET', 'POST'],
}));
```

Adicione um **handler de 404** no final do `app.js` (**após** todas as rotas), para que respostas de erro também tenham os headers de segurança:

```javascript
// 404 handler — APÓS todas as rotas
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});
```

> **Por que cada ajuste importa:**
> - `frameAncestors: ["'none'"]` → resolve finding "CSP: missing frame-ancestors" (Medium)
> - `formAction: ["'self'"]` → resolve finding "CSP: missing form-action" (Medium)
> - middleware `Permissions-Policy` → resolve finding "Permissions Policy Header Not Set" (Low)
> - `skip` do `/health` no rate limit → probes do Kubernetes e health checks do Render não recebem 429
> - `TRUST_PROXY_HOPS` → `1` atrás de exatamente um proxy (Render); `0` (padrão) quando exposto direto. Com o valor errado, ou todos os clientes compartilham o limite, ou qualquer um o burla forjando `X-Forwarded-For`
> - `origin: 'https://...'` → resolve finding "Cross-Domain Misconfiguration" — CORS `*` (Medium)
> - 404 handler JSON → respostas de erro passam pelos middlewares de segurança (headers corretos)

### 2.3 Testar localmente

```bash
npm start &

# Verificar headers de segurança
curl -I http://localhost:3000/health
# Esperado:
#   X-Content-Type-Options: nosniff
#   X-Frame-Options: SAMEORIGIN
#   Strict-Transport-Security: ...
#   Permissions-Policy: camera=(), microphone=(), geolocation=()
#   NÃO deve ter: X-Powered-By

# Testar rate limiting (em /api/info — /health está fora do limite)
for i in $(seq 1 101); do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:3000/api/info
done
echo ""
# Após 100 requests: deve retornar 429 (Too Many Requests)

kill %1
```

### 2.4 Commit

```bash
git add .
git commit -m "security: add helmet, rate-limit, cors"
```

> Não faça push ainda — vamos adicionar o job de deploy antes.

---

## 3. Atualizar Manifests K8s para GHCR

Os manifests da A4 usavam `image: devsecops-app:local` com `imagePullPolicy: Never`. Para o CI/CD, precisamos apontar para o GHCR.

### 3.1 Atualizar app-deployment.yaml

Edite `k8s/app-deployment.yaml`. Altere a seção do container:

```yaml
      containers:
        - name: app
          image: devsecops-app:local       # Será substituído no CI
          imagePullPolicy: IfNotPresent     # Kind usa imagem carregada localmente
```

> **Por que manter `devsecops-app:local`?** No CI, vamos fazer `docker pull` do GHCR, re-tag como `devsecops-app:local`, e carregar no Kind com `kind load`. Assim o mesmo YAML funciona localmente e no CI.

### 3.2 Commit

```bash
git add k8s/
git commit -m "chore: update K8s manifests for CI/CD"
```

---

## 4. Adicionar Job de Deploy K8s ao Workflow

### 4.1 Editar o workflow

Edite `.github/workflows/devsecops.yml`. Adicione o job `deploy-k8s` **após** o job `security-gate`:

```yaml
  # ============================================
  # Stage 7: Deploy K8s (Kind)
  # ============================================
  deploy-k8s:
    name: "🚀 Deploy K8s (Kind)"
    runs-on: ubuntu-latest
    needs: security-gate
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - name: Checkout do código
        uses: actions/checkout@v4

      - name: Criar cluster Kind
        uses: helm/kind-action@v1
        with:
          cluster_name: devsecops

      - name: Pull image do GHCR
        run: |
          IMAGE="ghcr.io/${GITHUB_REPOSITORY,,}:${{ github.sha }}"   # mesmo artefato que passou no gate
          docker pull "$IMAGE"
          docker tag "$IMAGE" devsecops-app:local
          echo "Image pulled from GHCR: $IMAGE"

      - name: Carregar no Kind
        run: |
          kind load docker-image devsecops-app:local --name devsecops
          echo "Image loaded into Kind"

      - name: Deploy manifests K8s
        run: |
          kubectl apply -f k8s/configmap.yaml
          kubectl apply -f k8s/secret.yaml
          kubectl apply -f k8s/postgres-deployment.yaml
          kubectl apply -f k8s/postgres-service.yaml
          kubectl apply -f k8s/app-deployment.yaml
          kubectl apply -f k8s/app-service.yaml
          echo "All manifests applied"

      - name: Aguardar rollout
        run: |
          kubectl rollout status deployment/postgres --timeout=120s
          kubectl rollout status deployment/devsecops-app --timeout=120s
          echo "All deployments ready"

      - name: Inicializar banco
        run: |
          kubectl apply -f k8s/init-db-job.yaml
          kubectl wait --for=condition=complete job/init-db --timeout=60s
          echo "Database initialized"

      # Nota: na Parte 2 o server.js passará a fazer auto-init (CREATE TABLE IF NOT EXISTS).
      # A partir daí o Job fica redundante, mas segue demonstrando o conceito.
      # Em produção: use migrations versionadas (Flyway, Knex, Prisma Migrate).

      - name: Health check
        run: |
          kubectl port-forward svc/devsecops-svc 8080:80 &
          sleep 5
          HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health)
          if [ "$HTTP_STATUS" = "200" ]; then
            echo "✅ Health check passed: $HTTP_STATUS"
          else
            echo "❌ Health check failed: $HTTP_STATUS"
            kubectl get pods
            kubectl logs -l app=devsecops --tail=20
            exit 1
          fi

      - name: Teste de endpoint
        run: |
          # Testar criação de mensagem
          curl -s -X POST http://localhost:8080/api/messages \
            -H "Content-Type: application/json" \
            -d '{"text": "Hello from CI/CD Kind!"}' | jq .
          # Listar mensagens
          curl -s http://localhost:8080/api/messages | jq .
          echo "✅ Endpoint tests passed"
```

> **O que cada step faz:**
> - `helm/kind-action@v1` — cria cluster Kind no runner (30s)
> - `docker pull` + `docker tag` + `kind load` — puxa do GHCR e carrega no Kind
> - `kubectl apply -f k8s/` — aplica os mesmos manifests da A4 (IaC!)
> - `kubectl rollout status` — espera os pods ficarem Ready
> - `kubectl port-forward` + `curl` — health check pós-deploy

### 4.2 Commit e push

```bash
git add .github/workflows/devsecops.yml
git commit -m "feat: add K8s CD deploy with Kind in GitHub Actions"
git push
```

### 4.3 Acompanhar execução

```bash
gh run watch
```

Você deve ver o novo job **🚀 Deploy K8s (Kind)** após o security-gate. O cluster Kind é criado, os manifests aplicados, e o health check executado — tudo no runner do GitHub Actions.

### ✅ Validação

Se o job `deploy-k8s` passou com "Health check passed: 200", o deploy K8s automatizado está funcionando.

---

## 5. O que Acabamos de Fazer (IaC)

Os manifests K8s criados na A4 são **Infrastructure as Code**:

| Arquivo | O que define | Equivalente manual |
|---------|-------------|-------------------|
| `configmap.yaml` | Configuração (DB_HOST, DB_PORT) | Dashboard / CLI |
| `secret.yaml` | Credenciais (DB_USER, DB_PASSWORD) | Colar senha na UI |
| `deployment.yaml` | App: imagem, réplicas, security | Configurar container manualmente |
| `service.yaml` | Networking (porta, DNS) | Criar regras de rede |

Estes arquivos estão no Git, versionados, revisáveis em PR, e aplicados automaticamente pelo pipeline. Isso é IaC.

Na A6, usaremos `trivy config k8s/` para escanear esses manifests por misconfigurations de segurança.

---

## Estrutura do Pipeline (atualizada)

```
lint → semgrep → test → build+push GHCR → scan → gate → deploy-k8s (Kind)
                                                              │
                                                         create cluster
                                                         pull GHCR image
                                                         kubectl apply
                                                         health check ✅
```

---

## Próximo Passo

Na **Parte 2**, vamos deployar a mesma app no Render.com (URL pública) e rodar o ZAP baseline scan contra ela.

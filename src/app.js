const express = require('express');
const app = express();

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');


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
  origin: process.env.CORS_ORIGIN || 'https://devsecops-lab-ukxi.onrender.com',
  methods: ['GET', 'POST'],
}));

app.use(express.json());

const pool = require('./db');

// Health check — usado pelo Kubernetes, load balancers, etc.
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Endpoint principal
app.get('/api/info', (req, res) => {
  res.json({
    app: 'devsecops-lab-a2',
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Endpoint com lógica de negócio simples
app.post('/api/validate', (req, res) => {
  const { email } = req.body;

  // typeof evita TypeError (500 + stack trace) quando o body traz número/objeto
  if (typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Email inválido' });  // não ecoa o input
  }

  return res.json({
    valid: true,
    email: email.toLowerCase().trim()
  });
});

// Listar mensagens
app.get('/api/messages', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM messages ORDER BY created_at DESC LIMIT 20'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);                                  // detalhe só no log do servidor
    res.status(500).json({ error: 'Database error' });   // nada de err.message para o cliente
  }
});

// Criar mensagem
app.post('/api/messages', async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'Text is required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING *',
      [text.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

module.exports = app;
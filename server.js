'use strict';
// ─────────────────────────────────────────────────────────────
//  Buda.com Cross-Border Payments · Server v1.0
//  Simulador FX multi-divisa LATAM
// ─────────────────────────────────────────────────────────────
if (!process.env.PGPASSWORD) process.env.PGPASSWORD = '';

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET        || 'buda-crossborder-secret-2025';
const FX_API_KEY     = process.env.FX_API_KEY        || ''; // ExchangeRate-API key
const FX_API_BASE    = process.env.FX_API_BASE       || 'https://v6.exchangerate-api.com/v6';
const SLACK_WEBHOOK  = process.env.SLACK_WEBHOOK     || '';

// ── DB ────────────────────────────────────────────────────────
const pool = new Pool({
  host    : process.env.PGHOST     || 'postgres.railway.internal',
  port    : parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'railway',
  user    : process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD,
  ssl     : process.env.PGHOST && process.env.PGHOST.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      empresa VARCHAR(100),
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      pais VARCHAR(10) DEFAULT 'CO',
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS simulaciones (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      usuario_nombre VARCHAR(100),
      empresa VARCHAR(100),
      par VARCHAR(20) NOT NULL,
      moneda_origen VARCHAR(10),
      moneda_destino VARCHAR(10),
      tasa_referencia DECIMAL(18,6),
      tasa_cliente DECIMAL(18,6),
      margen_pct DECIMAL(8,4),
      ticket_promedio DECIMAL(18,2),
      num_operaciones INTEGER,
      volumen_total DECIMAL(18,2),
      ganancia_proyectada DECIMAL(18,2),
      notas TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tasas_manuales (
      par VARCHAR(20) PRIMARY KEY,
      tasa DECIMAL(18,6) NOT NULL,
      fuente VARCHAR(50) DEFAULT 'manual',
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS config (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[db] Tables ready');
}

// ── FX Rates ─────────────────────────────────────────────────
// Fallback rates (USD base) — updated when API key is available
const FALLBACK_RATES = {
  COP: 4180.00,
  CLP: 970.00,
  PEN: 3.72,
  BOB: 6.91,
  VES: 46.50,
  USD: 1.00,
};

let fxState = {
  rates: { ...FALLBACK_RATES },
  source: 'manual',
  updatedAt: new Date().toISOString(),
  error: null,
};

async function refreshFX() {
  // Try API first if key is available
  if (FX_API_KEY) {
    try {
      const r = await axios.get(`${FX_API_BASE}/${FX_API_KEY}/latest/USD`, { timeout: 10000 });
      if (r.data && r.data.conversion_rates) {
        const rates = r.data.conversion_rates;
        fxState = {
          rates: {
            COP: parseFloat(rates.COP) || FALLBACK_RATES.COP,
            CLP: parseFloat(rates.CLP) || FALLBACK_RATES.CLP,
            PEN: parseFloat(rates.PEN) || FALLBACK_RATES.PEN,
            BOB: parseFloat(rates.BOB) || FALLBACK_RATES.BOB,
            VES: parseFloat(rates.VES) || FALLBACK_RATES.VES,
            USD: 1.00,
          },
          source: 'api',
          updatedAt: new Date().toISOString(),
          error: null,
        };
        console.log('[fx] Rates updated from API');
        return;
      }
    } catch(e) {
      console.log('[fx] API error:', e.message, '— using manual rates');
    }
  }

  // Load manual overrides from DB
  try {
    const r = await pool.query('SELECT par, tasa FROM tasas_manuales');
    if (r.rows.length) {
      r.rows.forEach(row => {
        if (FALLBACK_RATES[row.par] !== undefined) {
          fxState.rates[row.par] = parseFloat(row.tasa);
        }
      });
      fxState.source = 'manual';
      fxState.updatedAt = new Date().toISOString();
    }
  } catch(e) {}
}

// ── Helpers ───────────────────────────────────────────────────
const fmt = (n, dec=2) => n ? parseFloat(n).toLocaleString('es-CO', { minimumFractionDigits: dec }) : '—';

async function slackAlert(text) {
  if (!SLACK_WEBHOOK) return;
  await axios.post(SLACK_WEBHOOK, { text }).catch(()=>{});
}

// ── Auth ──────────────────────────────────────────────────────
function authMw(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Sin token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Token inválido' }); }
}

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Faltan campos' });
  try {
    const r = await pool.query('SELECT * FROM usuarios WHERE email=$1 AND activo=true', [email.trim()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });
    const u = r.rows[0];
    const token = jwt.sign({ id: u.id, email: u.email, nombre: u.nombre, empresa: u.empresa }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: u.id, nombre: u.nombre, empresa: u.empresa, email: u.email, pais: u.pais }, expiresIn: 43200 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/refresh', authMw, (req, res) => {
  const token = jwt.sign({ id: req.user.id, email: req.user.email, nombre: req.user.nombre, empresa: req.user.empresa }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, expiresIn: 43200 });
});

// ── FX API ────────────────────────────────────────────────────
app.get('/api/rates', (req, res) => {
  res.json({ ...fxState, currencies: Object.keys(fxState.rates).filter(c => c !== 'USD') });
});

app.post('/api/cotizar', authMw, async (req, res) => {
  const { moneda_origen, moneda_destino, monto, margen_pct } = req.body;
  if (!moneda_origen || !moneda_destino || !monto) return res.status(400).json({ error: 'Faltan campos' });
  const rOrig = fxState.rates[moneda_origen] || 1;
  const rDest = fxState.rates[moneda_destino] || 1;
  const tasaRef = rDest / rOrig;
  const margen  = parseFloat(margen_pct) || 0;
  const tasaCliente = tasaRef * (1 + margen / 100);
  const montoOrigen = parseFloat(monto);
  const montoDest   = montoOrigen * tasaCliente;
  res.json({
    par: moneda_origen + '/' + moneda_destino,
    moneda_origen, moneda_destino,
    tasa_referencia: parseFloat(tasaRef.toFixed(6)),
    margen_pct: margen,
    tasa_cliente: parseFloat(tasaCliente.toFixed(6)),
    monto_origen: montoOrigen,
    monto_destino: parseFloat(montoDest.toFixed(2)),
    source: fxState.source,
    updatedAt: fxState.updatedAt,
  });
});

app.post('/api/simular', authMw, async (req, res) => {
  const { moneda_origen, moneda_destino, margen_pct, ticket_promedio, num_operaciones, notas } = req.body;
  if (!moneda_origen || !moneda_destino || !ticket_promedio || !num_operaciones)
    return res.status(400).json({ error: 'Faltan campos' });
  const rOrig = fxState.rates[moneda_origen] || 1;
  const rDest = fxState.rates[moneda_destino] || 1;
  const tasaRef = rDest / rOrig;
  const margen  = parseFloat(margen_pct) || 0;
  const tasaCliente = tasaRef * (1 + margen / 100);
  const ticket  = parseFloat(ticket_promedio);
  const numOps  = parseInt(num_operaciones);
  const volumen = ticket * numOps;
  const ganancia = volumen * (margen / 100);
  try {
    await pool.query(`INSERT INTO simulaciones 
      (usuario_id, usuario_nombre, empresa, par, moneda_origen, moneda_destino, tasa_referencia, tasa_cliente, margen_pct, ticket_promedio, num_operaciones, volumen_total, ganancia_proyectada, notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [req.user.id, req.user.nombre, req.user.empresa,
       moneda_origen+'/'+moneda_destino, moneda_origen, moneda_destino,
       tasaRef.toFixed(6), tasaCliente.toFixed(6), margen, ticket, numOps,
       volumen.toFixed(2), ganancia.toFixed(2), notas||'']);
  } catch(e) { console.error('[sim] Save error:', e.message); }
  await slackAlert('Nueva simulación — ' + req.user.nombre + ' (' + (req.user.empresa||'—') + ') | ' + moneda_origen + '→' + moneda_destino + ' | Vol: ' + fmt(volumen) + ' | Margen: ' + margen + '%');
  res.json({
    par: moneda_origen + '/' + moneda_destino,
    tasa_referencia: parseFloat(tasaRef.toFixed(6)),
    tasa_cliente: parseFloat(tasaCliente.toFixed(6)),
    margen_pct: margen,
    ticket_promedio: ticket,
    num_operaciones: numOps,
    volumen_total: parseFloat(volumen.toFixed(2)),
    ganancia_proyectada: parseFloat(ganancia.toFixed(2)),
    source: fxState.source,
  });
});

app.get('/api/mis-simulaciones', authMw, async (req, res) => {
  const r = await pool.query('SELECT * FROM simulaciones WHERE usuario_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ simulaciones: r.rows });
});

// ── Admin: tasas manuales ─────────────────────────────────────
app.post('/api/tasa-manual', authMw, async (req, res) => {
  const { par, tasa } = req.body;
  if (!par || !tasa) return res.status(400).json({ error: 'Faltan par y tasa' });
  await pool.query(`INSERT INTO tasas_manuales (par,tasa) VALUES ($1,$2) ON CONFLICT (par) DO UPDATE SET tasa=$2, updated_at=NOW()`, [par, tasa]);
  await refreshFX();
  res.json({ ok: true, par, tasa });
});

// ── Temporal ──────────────────────────────────────────────────
app.get('/reset-admin', async (req, res) => {
  try {
    const hash = await bcrypt.hash('buda2025', 10);
    // Delete simulations first to avoid FK constraint
    const u = await pool.query('SELECT id FROM usuarios WHERE email=$1', ['alejandro@buda.com']);
    if (u.rows.length) {
      await pool.query('DELETE FROM simulaciones WHERE usuario_id=$1', [u.rows[0].id]);
      await pool.query('DELETE FROM usuarios WHERE id=$1', [u.rows[0].id]);
    }
    await pool.query('INSERT INTO usuarios (nombre,empresa,email,password_hash) VALUES ($1,$2,$3,$4)',
      ['Alejandro Beltrán', 'Buda.com', 'alejandro@buda.com', hash]);
    res.json({ ok: true, msg: 'Admin creado · alejandro@buda.com / buda2025' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', fx: fxState.source, updatedAt: fxState.updatedAt }));

// ── Chat endpoint (Anthropic API) ─────────────────────────────
app.post('/api/chat', authMw, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'Sin mensajes' });

  const rates = fxState.rates;
  const systemPrompt = `Eres el asistente de Buda.com Cross-Border Payments, un servicio B2B de pagos internacionales entre Latinoamérica y Asia.

Tu rol es ayudar a empresas a entender el servicio, calcular tasas de cambio, simular volúmenes de negocio y proyectar ingresos.

TASAS DE CAMBIO ACTUALES (base USD, fuente: ${fxState.source}, actualizado: ${fxState.updatedAt}):
- COP (Peso Colombiano): ${rates.COP} por USD
- CLP (Peso Chileno): ${rates.CLP} por USD
- PEN (Sol Peruano): ${rates.PEN} por USD
- BOB (Boliviano): ${rates.BOB} por USD
- VES (Bolívar Venezolano): ${rates.VES} por USD
- CNY (Yuan Chino): ${rates.CNY} por USD

CÓMO CALCULAR TASAS CRUZADAS:
Para convertir entre dos monedas no-USD: tasa = tasa_destino / tasa_origen
Ejemplo COP→CLP: ${rates.CLP} / ${rates.COP} = ${(rates.CLP/rates.COP).toFixed(6)} CLP por COP

CÓMO SIMULAR NEGOCIOS:
- Volumen mensual = ticket_promedio × ops_por_día × días_al_mes
- Margen mensual = volumen × (margen_pct / 100)
- Proyección anual = margen_mensual × 12

CORREDORES ACTIVOS: Colombia↔Chile, Colombia↔Perú, Colombia↔Bolivia, Colombia↔Venezuela, Colombia↔China, y más.

REGLAS:
- Nunca menciones criptomonedas, USDT, USDC, blockchain o términos crypto
- Habla siempre en términos de "rieles de pago", "liquidación instantánea", "infraestructura de pagos"
- Responde en español
- Sé conciso y directo — máximo 3-4 párrafos
- Cuando hagas cálculos, muéstralos paso a paso con los números
- Si el usuario pide una simulación de negocio, incluye: tasa de referencia, tasa con margen, volumen mensual, margen mensual y proyección anual
- Al final de simulaciones, sugiere guardarla en el simulador

El usuario actual es: ${req.user.nombre} de ${req.user.empresa || 'su empresa'}.`;

  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages,
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    });
    const text = r.data.content && r.data.content[0] && r.data.content[0].text || '';
    res.json({ response: text });
  } catch(e) {
    const msg = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    console.error('[chat] Error:', msg);
    res.status(500).json({ error: 'Error al conectar con el asistente: ' + msg });
  }
});

// ── Portal Web ────────────────────────────────────────────────
app.get('/', (req, res) => { res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(portal()); });

// ── Start ─────────────────────────────────────────────────────
async function start() {
  try { await initDB(); } catch(e) { console.error('[db]', e.message); }
  await refreshFX();
  setInterval(refreshFX, 3600000); // Refresh every hour
  app.listen(PORT, () => console.log('[server] Puerto', PORT));
}
start();

// ═══════════════════════════════════════════════════════════════
//  PORTAL WEB
// ═══════════════════════════════════════════════════════════════
function portal() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buda.com · Cross-Border Payments</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#F9FAFB;--bg2:#FFFFFF;--bg3:#F3F4F6;
  --blue:#1A56DB;--blue-d:#1447BB;--blue-l:#EBF5FF;--blue-border:#BFDBFE;
  --text:#111928;--gray:#6B7280;--border:#E5E7EB;
  --green:#057A55;--green-l:#F3FAF7;
  --red:#E02424;--red-l:#FDF2F2;
  --chat-user:#1A56DB;--chat-bot:#FFFFFF;
}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;font-size:14px;min-height:100vh}

/* Nav */
.nav{background:#fff;border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;padding:0 24px;gap:16px;position:sticky;top:0;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.logo{font-size:18px;font-weight:800;color:var(--text);letter-spacing:-.5px;cursor:pointer}
.logo span{color:var(--blue)}
.logo-sub{font-size:10px;color:var(--gray);text-transform:uppercase;letter-spacing:.1em;margin-left:8px;font-weight:500}
.nav-r{margin-left:auto;display:flex;align-items:center;gap:10px}
.rates-pill{background:var(--blue-l);border:1px solid var(--blue-border);border-radius:20px;padding:3px 10px;font-size:11px;color:var(--blue);display:flex;align-items:center;gap:5px}
.rates-dot{width:6px;height:6px;border-radius:50%;background:var(--blue);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.user-chip{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--gray)}
.av{width:28px;height:28px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}
.btn-nav{padding:5px 12px;border-radius:6px;border:1px solid var(--border);background:#fff;color:var(--gray);cursor:pointer;font-size:11px;font-family:'Inter',sans-serif}
.btn-nav:hover{border-color:var(--blue);color:var(--blue)}
.nav-tabs{display:flex;gap:0;margin-left:16px}
.ntab{padding:0 14px;height:56px;display:flex;align-items:center;font-size:13px;color:var(--gray);cursor:pointer;border-bottom:2px solid transparent;transition:.15s;white-space:nowrap}
.ntab:hover{color:var(--blue)}
.ntab.active{color:var(--blue);border-bottom-color:var(--blue);font-weight:500}

/* Login */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg3)}
.login-card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:40px;width:360px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
.login-logo{text-align:center;margin-bottom:28px}
.login-logo-text{font-size:28px;font-weight:900;color:var(--text);letter-spacing:-1px}
.login-logo-text span{color:var(--blue)}
.login-sub{font-size:12px;color:var(--gray);margin-top:4px}
.fg{margin-bottom:12px}
.fg label{display:block;font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;font-weight:500}
.fi{width:100%;padding:10px 12px;border-radius:8px;border:1.5px solid var(--border);font-size:13px;color:var(--text);font-family:'Inter',sans-serif;transition:.15s;background:#fff}
.fi:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-l)}
.btn-primary{width:100%;padding:11px;border-radius:9px;border:none;background:var(--blue);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:.15s}
.btn-primary:hover{background:var(--blue-d)}

/* Main layout */
.main{display:flex;height:calc(100vh - 56px)}

/* Left panel - info */
.left-panel{width:380px;flex-shrink:0;background:#fff;border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column}
.left-panel.hidden{display:none}

/* Info section */
.info-section{padding:24px}
.info-hero{background:linear-gradient(135deg,var(--blue) 0%,var(--blue-d) 100%);border-radius:14px;padding:24px;color:#fff;margin-bottom:16px}
.info-hero-tag{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;opacity:.7;margin-bottom:8px}
.info-hero-title{font-size:22px;font-weight:800;line-height:1.25;margin-bottom:8px;letter-spacing:-.3px}
.info-hero-sub{font-size:12px;opacity:.8;line-height:1.6}
.metric-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.metric{background:var(--bg3);border-radius:10px;padding:12px;text-align:center}
.metric-val{font-size:18px;font-weight:800;color:var(--blue);font-family:monospace}
.metric-lbl{font-size:10px;color:var(--gray);margin-top:2px}
.corridor-list{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.corridor{background:var(--bg3);border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between}
.corridor-name{font-size:12px;font-weight:500}
.corridor-rate{font-size:12px;font-family:monospace;color:var(--blue);font-weight:600}
.corridor-badge{font-size:9px;font-weight:600;padding:2px 7px;border-radius:20px;background:var(--green-l);color:var(--green)}
.section-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--gray);margin-bottom:10px}

/* Chat panel */
.chat-panel{flex:1;display:flex;flex-direction:column;background:var(--bg)}
.chat-header{padding:14px 20px;background:#fff;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
.chat-avatar{width:36px;height:36px;background:linear-gradient(135deg,var(--blue),var(--blue-d));border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex-shrink:0}
.chat-header-info{flex:1}
.chat-header-name{font-size:14px;font-weight:600}
.chat-header-sub{font-size:11px;color:var(--gray)}
.chat-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px}
.msg{display:flex;gap:10px;max-width:75%}
.msg.user{align-self:flex-end;flex-direction:row-reverse}
.msg.bot{align-self:flex-start}
.msg-avatar{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:2px}
.msg.bot .msg-avatar{background:linear-gradient(135deg,var(--blue),var(--blue-d));color:#fff}
.msg.user .msg-avatar{background:var(--bg3);color:var(--gray)}
.msg-bubble{padding:12px 16px;border-radius:14px;font-size:13px;line-height:1.6;max-width:100%}
.msg.bot .msg-bubble{background:#fff;border:1px solid var(--border);border-top-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.msg.user .msg-bubble{background:var(--blue);color:#fff;border-top-right-radius:4px}
.msg-bubble p{margin-bottom:8px}
.msg-bubble p:last-child{margin:0}
.msg-bubble strong{font-weight:600}
.msg-bubble code{background:rgba(0,0,0,.06);padding:1px 5px;border-radius:4px;font-family:monospace;font-size:12px}
.msg.user .msg-bubble code{background:rgba(255,255,255,.2)}
.typing{display:flex;gap:4px;align-items:center;padding:12px 16px;background:#fff;border:1px solid var(--border);border-radius:14px;border-top-left-radius:4px;width:60px}
.typing span{width:6px;height:6px;border-radius:50%;background:var(--gray);animation:bounce .8s infinite}
.typing span:nth-child(2){animation-delay:.15s}
.typing span:nth-child(3){animation-delay:.3s}
@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}

/* Suggestions */
.suggestions{padding:0 20px 12px;display:flex;gap:8px;flex-wrap:wrap}
.sug{padding:7px 12px;background:#fff;border:1px solid var(--border);border-radius:20px;font-size:12px;color:var(--gray);cursor:pointer;transition:.15s;white-space:nowrap}
.sug:hover{border-color:var(--blue);color:var(--blue);background:var(--blue-l)}

/* Chat input */
.chat-input-wrap{padding:12px 16px;background:#fff;border-top:1px solid var(--border)}
.chat-input-row{display:flex;gap:8px;align-items:flex-end;background:var(--bg3);border:1.5px solid var(--border);border-radius:12px;padding:8px 8px 8px 14px;transition:.15s}
.chat-input-row:focus-within{border-color:var(--blue);background:#fff;box-shadow:0 0 0 3px var(--blue-l)}
.chat-textarea{flex:1;border:none;background:transparent;font-size:13px;font-family:'Inter',sans-serif;color:var(--text);resize:none;outline:none;min-height:20px;max-height:120px;line-height:1.5}
.chat-textarea::placeholder{color:var(--gray)}
.send-btn{width:34px;height:34px;border-radius:8px;border:none;background:var(--blue);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:.15s;font-size:16px}
.send-btn:hover{background:var(--blue-d)}
.send-btn:disabled{background:var(--border);cursor:not-allowed}

/* Simulator tab */
.sim-panel{flex:1;overflow-y:auto;padding:24px;background:var(--bg)}
.sim-card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px}
.sim-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--gray);margin-bottom:14px}
.sim-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.curr-btns{display:flex;gap:6px;flex-wrap:wrap}
.curr-btn{padding:5px 11px;border-radius:20px;border:1.5px solid var(--border);background:#fff;font-size:11px;cursor:pointer;transition:.15s;color:var(--gray)}
.curr-btn.active{border-color:var(--blue);background:var(--blue-l);color:var(--blue);font-weight:600}
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.kpi{background:var(--bg3);border-radius:10px;padding:14px;text-align:center}
.kpi.blue{background:var(--blue-l);border:1px solid var(--blue-border)}
.kpi-val{font-size:22px;font-weight:800;font-family:monospace}
.kpi.blue .kpi-val{color:var(--blue)}
.kpi-lbl{font-size:10px;color:var(--gray);margin-top:2px;text-transform:uppercase;letter-spacing:.06em}
.annual-banner{background:var(--text);border-radius:12px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px}
.btn-save{width:100%;padding:10px;border-radius:9px;border:none;background:var(--blue);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif}
.btn-save:hover{background:var(--blue-d)}

/* Float alert */
.float-alert{position:fixed;top:16px;right:16px;z-index:9999;max-width:300px;border-radius:10px;padding:12px 14px;box-shadow:0 4px 24px rgba(0,0,0,.1);animation:slideIn .25s ease;display:flex;gap:8px;align-items:flex-start}
@keyframes slideIn{from{transform:translateX(110%)}to{transform:translateX(0)}}

@media(max-width:768px){
  .left-panel{display:none}
  .logo-sub{display:none}
}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="loginWrap" style="display:none">
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">
        <div class="login-logo-text">buda<span>.</span>com</div>
        <div class="login-sub">Cross-Border Payments</div>
      </div>
      <div class="fg"><label>Email</label><input class="fi" type="email" id="lEmail" placeholder="tu@empresa.com" autocomplete="off"></div>
      <div class="fg"><label>Contraseña</label><input class="fi" type="password" id="lPass" placeholder="••••••••" onkeydown="if(event.key==='Enter')login()"></div>
      <button class="btn-primary" onclick="login()">Ingresar</button>
      <div id="lErr" style="font-size:11px;color:var(--red);text-align:center;margin-top:10px"></div>
      <div style="text-align:center;margin-top:16px;font-size:11px;color:var(--gray)">¿No tienes acceso? <a href="mailto:otc@buda.com" style="color:var(--blue)">Contáctanos</a></div>
    </div>
  </div>
</div>

<!-- APP -->
<div id="appWrap" style="display:none">
  <nav class="nav">
    <div class="logo" onclick="switchView('chat')">buda<span>.</span>com <span class="logo-sub">Cross-Border</span></div>
    <div class="nav-tabs">
      <div class="ntab active" id="ntab-chat" onclick="switchView('chat')">Asistente</div>
      <div class="ntab" id="ntab-sim" onclick="switchView('sim')">Simulador</div>
      <div class="ntab" id="ntab-hist" onclick="switchView('hist');loadHist()">Mis simulaciones</div>
    </div>
    <div class="nav-r">
      <div class="rates-pill"><div class="rates-dot"></div><span id="ratesSource">Cargando...</span></div>
      <div class="user-chip"><div class="av" id="userAv">B</div><span id="userName"></span></div>
      <button class="btn-nav" onclick="logout()">Salir</button>
    </div>
  </nav>

  <!-- CHAT VIEW -->
  <div class="main" id="view-chat">
    <!-- Left panel: info + rates -->
    <div class="left-panel" id="leftPanel">
      <div class="info-section">
        <div class="info-hero">
          <div class="info-hero-tag">B2B · API-first · LATAM & Asia</div>
          <div class="info-hero-title">Pagos internacionales en minutos</div>
          <div class="info-hero-sub">Una sola integración para operar en 6 países. Sin bancos corresponsales, sin días de espera.</div>
        </div>
        <div class="metric-row">
          <div class="metric"><div class="metric-val">&lt;5min</div><div class="metric-lbl">Liquidación</div></div>
          <div class="metric"><div class="metric-val">1 API</div><div class="metric-lbl">Integración</div></div>
          <div class="metric"><div class="metric-val">6 países</div><div class="metric-lbl">Activos</div></div>
        </div>
        <div class="section-title">Tasas en tiempo real</div>
        <div class="corridor-list" id="corridorRates"></div>
        <div style="font-size:10px;color:var(--gray);text-align:center;margin-top:6px" id="ratesTime"></div>
      </div>
    </div>

    <!-- Chat -->
    <div class="chat-panel">
      <div class="chat-header">
        <div class="chat-avatar">B</div>
        <div class="chat-header-info">
          <div class="chat-header-name">Asistente Buda Cross-Border</div>
          <div class="chat-header-sub">Tasas en tiempo real · Simulaciones · Consultas sobre el servicio</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-nav" onclick="clearChat()">Nueva conversación</button>
        </div>
      </div>
      <div class="chat-messages" id="chatMessages"></div>
      <div class="suggestions" id="suggestions"></div>
      <div class="chat-input-wrap">
        <div class="chat-input-row">
          <textarea class="chat-textarea" id="chatInput" placeholder="Pregunta sobre tasas, simula tu negocio, consulta corredores..." rows="1"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg()}"
            oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea>
          <button class="send-btn" id="sendBtn" onclick="sendMsg()">↑</button>
        </div>
        <div style="font-size:10px;color:var(--gray);text-align:center;margin-top:6px">Shift+Enter para nueva línea · Enter para enviar</div>
      </div>
    </div>
  </div>

  <!-- SIMULATOR VIEW -->
  <div style="display:none;height:calc(100vh - 56px);overflow-y:auto" id="view-sim">
    <div class="sim-panel">
      <div style="font-size:20px;font-weight:700;margin-bottom:4px">Simulador de negocio</div>
      <div style="font-size:13px;color:var(--gray);margin-bottom:20px">Proyecta tu volumen mensual y anual en cualquier corredor</div>
      <div class="sim-card">
        <div class="sim-title">Corredor</div>
        <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin-bottom:12px">
          <div><div style="font-size:11px;color:var(--gray);margin-bottom:6px">Moneda origen</div><div class="curr-btns" id="origSelect"></div></div>
          <div style="font-size:20px;color:var(--gray);margin-top:16px">→</div>
          <div><div style="font-size:11px;color:var(--gray);margin-bottom:6px">Moneda destino</div><div class="curr-btns" id="destSelect"></div></div>
        </div>
        <div id="tasaBanner" style="display:none;background:var(--blue-l);border:1px solid var(--blue-border);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--blue);font-family:monospace"></div>
      </div>
      <div class="sim-card">
        <div class="sim-title">Parámetros del negocio</div>
        <div class="sim-grid">
          <div class="fg"><label>Ticket promedio (origen)</label><input class="fi" type="number" id="simTicket" placeholder="5.000.000" oninput="calcSim()"></div>
          <div class="fg"><label>Operaciones por día</label><input class="fi" type="number" id="simOpsDay" placeholder="10" oninput="calcSim()"></div>
          <div class="fg"><label>Días operativos al mes</label><input class="fi" type="number" id="simDaysMonth" placeholder="22" oninput="calcSim()"></div>
          <div class="fg"><label>Tu margen (%)</label><input class="fi" type="number" id="simMargen" placeholder="1.5" step="0.1" oninput="calcSim()"></div>
        </div>
        <input type="hidden" id="simMonto" value="0">
        <input type="hidden" id="simNumOps" value="0">
        <div class="fg"><label>Notas</label><input class="fi" type="text" id="simNotas" placeholder="Ej: remesas sector salud Colombia-Chile"></div>
      </div>
      <div id="simResult">
        <div style="background:#fff;border:1px solid var(--border);border-radius:14px;padding:40px;text-align:center;color:var(--gray)">
          <div style="font-size:32px;margin-bottom:8px">📊</div>
          <div>Completa los parámetros para ver la proyección</div>
        </div>
      </div>
    </div>
  </div>

  <!-- HISTORY VIEW -->
  <div style="display:none;height:calc(100vh - 56px);overflow-y:auto;padding:24px" id="view-hist">
    <div style="font-size:20px;font-weight:700;margin-bottom:16px">Mis simulaciones</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:12px;overflow:hidden">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:10px 14px;color:var(--gray);font-size:10px;text-transform:uppercase;font-weight:500">Par</th>
            <th style="text-align:left;padding:10px 14px;color:var(--gray);font-size:10px;text-transform:uppercase;font-weight:500">Tasa ref.</th>
            <th style="text-align:left;padding:10px 14px;color:var(--gray);font-size:10px;text-transform:uppercase;font-weight:500">Margen</th>
            <th style="text-align:left;padding:10px 14px;color:var(--gray);font-size:10px;text-transform:uppercase;font-weight:500">Volumen/mes</th>
            <th style="text-align:left;padding:10px 14px;color:var(--gray);font-size:10px;text-transform:uppercase;font-weight:500">Ganancia proy.</th>
            <th style="text-align:left;padding:10px 14px;color:var(--gray);font-size:10px;text-transform:uppercase;font-weight:500">Fecha</th>
          </tr></thead>
          <tbody id="histBody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
var BASE = window.location.origin;
var TOKEN = localStorage.getItem('budaToken');
var USER  = JSON.parse(localStorage.getItem('budaUser')||'null');
var fxData = {};
var simOrig = 'COP', simDest = 'CLP';
var chatHistory = [];
var isTyping = false;

var CURRENCIES = {
  COP:{flag:'🇨🇴',name:'Peso Colombiano',symbol:'$'},
  CLP:{flag:'🇨🇱',name:'Peso Chileno',symbol:'$'},
  PEN:{flag:'🇵🇪',name:'Sol Peruano',symbol:'S/'},
  BOB:{flag:'🇧🇴',name:'Boliviano',symbol:'Bs.'},
  VES:{flag:'🇻🇪',name:'Bolívar',symbol:'Bs.'},
  CNY:{flag:'🇨🇳',name:'Yuan Chino',symbol:'¥'},
  USD:{flag:'🇺🇸',name:'Dólar USD',symbol:'$'},
};
var ACTIVE = ['COP','CLP','PEN','BOB','VES','CNY'];

var SUGGESTIONS = [
  '¿Cuánto es 50 millones de COP en CLP hoy?',
  'Simula 20 ops/día de 10.000 USD con margen 1.5%',
  '¿Cuáles son los corredores activos?',
  'Explica cómo funciona la integración API',
  '¿Cuánto ganaría al año con 100 ops diarias?',
];

var fmt = function(n, dec) {
  if (!n && n !== 0) return '—';
  dec = dec !== undefined ? dec : 2;
  return parseFloat(n).toLocaleString('es-CO', {minimumFractionDigits:dec, maximumFractionDigits:dec});
};

async function api(m, u, b) {
  var h = {'Content-Type':'application/json'};
  if (TOKEN) h['Authorization'] = 'Bearer '+TOKEN;
  var r = await fetch(BASE+u, {method:m, headers:h, body:b?JSON.stringify(b):undefined});
  if (r.status===401 && u!=='/auth/login') { logout(); return {}; }
  return r.json();
}

async function login() {
  var email = document.getElementById('lEmail').value.trim();
  var pass  = document.getElementById('lPass').value;
  var d = await api('POST','/auth/login',{email,password:pass});
  if (d.error) { document.getElementById('lErr').textContent = d.error; return; }
  TOKEN = d.token; USER = d.user;
  localStorage.setItem('budaToken', TOKEN);
  localStorage.setItem('budaUser', JSON.stringify(USER));
  showApp();
}

function logout() {
  TOKEN=null; USER=null;
  localStorage.removeItem('budaToken'); localStorage.removeItem('budaUser');
  document.getElementById('appWrap').style.display='none';
  document.getElementById('loginWrap').style.display='block';
}

function showApp() {
  document.getElementById('loginWrap').style.display='none';
  document.getElementById('appWrap').style.display='block';
  if (USER) {
    document.getElementById('userName').textContent = USER.nombre;
    var av = USER.nombre.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    document.getElementById('userAv').textContent = av;
  }
  buildCurrencySelectors();
  loadRates();
  setInterval(loadRates, 3600000);
  showWelcome();
  renderSuggestions();
}

function switchView(v) {
  ['chat','sim','hist'].forEach(function(x){
    document.getElementById('view-'+x).style.display = x===v ? (x==='chat'?'flex':'block') : 'none';
    var tab = document.getElementById('ntab-'+x);
    if (tab) tab.classList.toggle('active', x===v);
  });
  if (v==='sim') { buildCurrencySelectors(); calcSim(); }
}

// ── Rates ──────────────────────────────────────────────────────
async function loadRates() {
  var d = await api('GET','/api/rates');
  if (!d.rates) return;
  fxData = d;
  document.getElementById('ratesSource').textContent = d.source==='api' ? 'Tiempo real' : 'Tasas ref.';
  var t = new Date(d.updatedAt);
  var el = document.getElementById('ratesTime');
  if (el) el.textContent = 'Act. ' + t.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'});
  renderCorridorRates(d.rates);
  calcSim();
}

function renderCorridorRates(rates) {
  var corridors = [['COP','CLP'],['COP','PEN'],['COP','BOB'],['COP','VES'],['COP','CNY'],['USD','COP']];
  var el = document.getElementById('corridorRates');
  if (!el) return;
  el.innerHTML = corridors.map(function(p) {
    var r = (rates[p[1]]||1) / (rates[p[0]]||1);
    var dec = r < 10 ? 4 : 2;
    return '<div class="corridor">' +
      '<span class="corridor-name">' + (CURRENCIES[p[0]]?CURRENCIES[p[0]].flag:'') + ' ' + p[0] + ' → ' + (CURRENCIES[p[1]]?CURRENCIES[p[1]].flag:'') + ' ' + p[1] + '</span>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<span class="corridor-rate">' + fmt(r,dec) + '</span>' +
        '<span class="corridor-badge">Activo</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Currency selectors ─────────────────────────────────────────
function buildCurrencySelectors() {
  var keys = ACTIVE.concat(['USD']);
  var origEl = document.getElementById('origSelect');
  var destEl = document.getElementById('destSelect');
  if (origEl) origEl.innerHTML = keys.map(function(c){
    return '<button class="curr-btn'+(c===simOrig?' active':'')+'" onclick="setOrig(&quot;'+c+'&quot;)">'+CURRENCIES[c].flag+' '+c+'</button>';
  }).join('');
  if (destEl) destEl.innerHTML = keys.map(function(c){
    return '<button class="curr-btn'+(c===simDest?' active':'')+'" onclick="setDest(&quot;'+c+'&quot;)">'+CURRENCIES[c].flag+' '+c+'</button>';
  }).join('');
}
function setOrig(c){simOrig=c;buildCurrencySelectors();calcSim();}
function setDest(c){simDest=c;buildCurrencySelectors();calcSim();}

// ── Chat ───────────────────────────────────────────────────────
function showWelcome() {
  var name = USER ? USER.nombre.split(' ')[0] : 'bienvenido';
  var msg = 'Hola, **' + name + '** 👋\n\n' +
    'Soy el asistente de **Buda Cross-Border Payments**. Puedo ayudarte a:\n\n' +
    '- **Consultar tasas** de cambio en tiempo real entre nuestros corredores\n' +
    '- **Simular tu modelo de negocio** y proyectar tus ingresos\n' +
    '- **Responder preguntas** sobre el servicio, la API y los corredores activos\n\n' +
    '¿En qué puedo ayudarte hoy?';
  addBotMsg(msg);
}

function renderSuggestions() {
  var el = document.getElementById('suggestions');
  if (!el) return;
  el.innerHTML = SUGGESTIONS.map(function(s){
    return '<button class="sug" onclick="useSuggestion(&quot;'+s.replace(/"/g,'&quot;')+'&quot;)">'+s+'</button>';
  }).join('');
}

function useSuggestion(s) {
  document.getElementById('chatInput').value = s;
  sendMsg();
}

function clearChat() {
  chatHistory = [];
  document.getElementById('chatMessages').innerHTML = '';
  showWelcome();
  renderSuggestions();
}

function addBotMsg(text) {
  var el = document.getElementById('chatMessages');
  var div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = '<div class="msg-avatar">B</div><div class="msg-bubble">'+mdToHtml(text)+'</div>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  // Hide suggestions after first response
  if (chatHistory.length > 0) {
    var sug = document.getElementById('suggestions');
    if (sug) sug.style.display = 'none';
  }
}

function addUserMsg(text) {
  var el = document.getElementById('chatMessages');
  var div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = '<div class="msg-avatar">'+((USER&&USER.nombre)?USER.nombre[0].toUpperCase():'U')+'</div><div class="msg-bubble">'+escHtml(text)+'</div>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function showTyping() {
  var el = document.getElementById('chatMessages');
  var div = document.createElement('div');
  div.className = 'msg bot'; div.id = 'typingIndicator';
  div.innerHTML = '<div class="msg-avatar">B</div><div class="typing"><span></span><span></span><span></span></div>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function hideTyping() {
  var el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

async function sendMsg() {
  if (isTyping) return;
  var input = document.getElementById('chatInput');
  var text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  addUserMsg(text);

  chatHistory.push({role:'user', content: text});
  isTyping = true;
  document.getElementById('sendBtn').disabled = true;

  // Hide suggestions
  var sug = document.getElementById('suggestions');
  if (sug) sug.style.display = 'none';

  showTyping();

  try {
    var d = await api('POST','/api/chat', {messages: chatHistory});
    hideTyping();
    if (d.error) {
      addBotMsg('Lo siento, ocurrió un error: ' + d.error);
    } else {
      chatHistory.push({role:'assistant', content: d.response});
      addBotMsg(d.response);
    }
  } catch(e) {
    hideTyping();
    addBotMsg('Error de conexión. Por favor intenta de nuevo.');
  }

  isTyping = false;
  document.getElementById('sendBtn').disabled = false;
  input.focus();
}

// Simple markdown to HTML
function mdToHtml(text) {
  var t = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  t = t.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g,'<em>$1</em>');
  var nl = String.fromCharCode(10);
  var parts = t.split(nl+nl);
  t = parts.map(function(p){ return '<p>'+p.split(nl).join('<br>')+'</p>'; }).join('');
  t = t.replace(/[•-] ([^<]+)/g,'<li>$1</li>');
  return t;
}

function escHtml(text) {
  var nl = String.fromCharCode(10);
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').split(nl).join('<br>');
}

// ── Simulator ──────────────────────────────────────────────────
function calcSim() {
  if (!fxData.rates) return;
  var ticket    = parseFloat(document.getElementById('simTicket') && document.getElementById('simTicket').value)    || 0;
  var opsDay    = parseFloat(document.getElementById('simOpsDay') && document.getElementById('simOpsDay').value)    || 0;
  var daysMonth = parseFloat(document.getElementById('simDaysMonth') && document.getElementById('simDaysMonth').value) || 22;
  var margen    = parseFloat(document.getElementById('simMargen') && document.getElementById('simMargen').value)    || 0;

  var rOrig   = fxData.rates[simOrig] || 1;
  var rDest   = fxData.rates[simDest] || 1;
  var tasaRef = rDest / rOrig;
  var tasaCli = tasaRef * (1 + margen / 100);
  var dec     = tasaRef < 10 ? 4 : 2;
  var currO   = CURRENCIES[simOrig] ? CURRENCIES[simOrig].symbol : '$';
  var currD   = CURRENCIES[simDest] ? CURRENCIES[simDest].symbol : '$';

  var banner = document.getElementById('tasaBanner');
  if (banner) {
    banner.style.display = 'block';
    banner.textContent = '1 '+simOrig+' = '+currD+' '+fmt(tasaRef,dec)+' (ref.) | Tu tasa: '+currD+' '+fmt(tasaCli,dec)+' (+'+margen+'%)';
  }

  if (!ticket || !opsDay || !margen) {
    document.getElementById('simResult').innerHTML =
      '<div style="background:#fff;border:1px solid var(--border);border-radius:14px;padding:40px;text-align:center;color:var(--gray)"><div style="font-size:32px;margin-bottom:8px">📊</div><div>Completa los parámetros para ver la proyección</div></div>';
    return;
  }

  var opsMonth  = Math.round(opsDay * daysMonth);
  var volMonth  = ticket * opsMonth;
  var volMonthD = volMonth * tasaCli;
  var margMonth = volMonth * (margen / 100);
  var margMonthD= margMonth * tasaCli;
  var margYear  = margMonth * 12;
  var margYearD = margMonthD * 12;
  var flagO = CURRENCIES[simOrig] ? CURRENCIES[simOrig].flag : '';
  var flagD = CURRENCIES[simDest] ? CURRENCIES[simDest].flag : '';

  document.getElementById('simResult').innerHTML =
    '<div class="kpi-grid">' +
      '<div class="kpi"><div class="kpi-val">'+opsMonth.toLocaleString('es-CO')+'</div><div class="kpi-lbl">Ops / mes</div></div>' +
      '<div class="kpi"><div class="kpi-val">'+currO+' '+fmt(volMonth)+'</div><div class="kpi-lbl">Volumen / mes</div></div>' +
      '<div class="kpi blue"><div class="kpi-val">'+currO+' '+fmt(margMonth)+'</div><div class="kpi-lbl">Tu margen / mes</div></div>' +
    '</div>' +
    '<div class="annual-banner">' +
      '<div><div style="font-size:11px;color:rgba(255,255,255,.5);margin-bottom:4px">Proyección anual</div>' +
        '<div style="font-size:26px;font-weight:800;color:#fff;font-family:monospace">'+currO+' '+fmt(margYear)+'</div>' +
        '<div style="font-size:11px;color:rgba(255,255,255,.4)">'+currD+' '+fmt(margYearD)+' a '+margen+'% de margen</div></div>' +
      '<div style="text-align:right"><div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px">Corredor</div>' +
        '<div style="font-size:16px;font-weight:700;color:#fff;font-family:monospace">'+flagO+' '+simOrig+' → '+flagD+' '+simDest+'</div></div>' +
    '</div>' +
    '<div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:11px;color:var(--gray);font-family:monospace;line-height:2;margin-bottom:12px">' +
      'Tasa ref: '+fmt(tasaRef,dec)+' | Tu tasa: '+fmt(tasaCli,dec)+' | Ticket: '+currO+' '+fmt(ticket)+' | '+opsDay+' ops/dia x '+daysMonth+' dias = '+opsMonth+' ops/mes' +
    '</div>' +
    '<button class="btn-save" onclick="guardarSim()">💾 Guardar simulación</button>';
}

async function guardarSim() {
  var ticket    = parseFloat(document.getElementById('simTicket').value)    || 0;
  var opsDay    = parseFloat(document.getElementById('simOpsDay').value)    || 0;
  var daysMonth = parseFloat(document.getElementById('simDaysMonth').value) || 22;
  var margen    = parseFloat(document.getElementById('simMargen').value)    || 0;
  var notas     = document.getElementById('simNotas').value;
  if (!ticket || !opsDay || !margen) { floatAlert('Completa todos los campos','','red'); return; }
  var numOps = Math.round(opsDay * daysMonth);
  var d = await api('POST','/api/simular',{moneda_origen:simOrig,moneda_destino:simDest,margen_pct:margen,ticket_promedio:ticket,num_operaciones:numOps,notas:'ops/dia:'+opsDay+' dias:'+daysMonth+' '+notas});
  if (d.error) { floatAlert('Error', d.error, 'red'); return; }
  var currO = CURRENCIES[simOrig] ? CURRENCIES[simOrig].symbol : '$';
  floatAlert('Simulación guardada', 'Margen mensual: '+currO+' '+fmt(d.ganancia_proyectada), 'blue');
}

// ── History ────────────────────────────────────────────────────
async function loadHist() {
  var d = await api('GET','/api/mis-simulaciones');
  var rows = d.simulaciones || [];
  document.getElementById('histBody').innerHTML = rows.length ? rows.map(function(r){
    return '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:10px 14px"><span style="background:var(--blue-l);color:var(--blue);padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;font-family:monospace">'+r.par+'</span></td>' +
      '<td style="padding:10px 14px;font-family:monospace;font-size:12px">'+fmt(r.tasa_referencia,4)+'</td>' +
      '<td style="padding:10px 14px;font-size:12px">'+fmt(r.margen_pct,2)+'%</td>' +
      '<td style="padding:10px 14px;font-family:monospace;font-size:12px">'+fmt(r.volumen_total)+'</td>' +
      '<td style="padding:10px 14px;font-family:monospace;font-size:12px;color:var(--green);font-weight:600">'+fmt(r.ganancia_proyectada)+'</td>' +
      '<td style="padding:10px 14px;font-size:11px;color:var(--gray)">'+new Date(r.created_at).toLocaleString('es-CO',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})+'</td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--gray)">No tienes simulaciones guardadas aún</td></tr>';
}

// ── Float alert ────────────────────────────────────────────────
function floatAlert(title, body, type) {
  var colors = {blue:['var(--blue-l)','var(--blue)','✅'], red:['var(--red-l)','var(--red)','❌']};
  var c = colors[type]||colors.blue;
  var el = document.createElement('div');
  el.className = 'float-alert';
  el.style.background = c[0]; el.style.border = '1px solid '+c[1]+'40';
  el.innerHTML = '<span style="font-size:18px">'+c[2]+'</span><div style="flex:1"><div style="font-size:12px;font-weight:500;color:'+c[1]+'">'+title+'</div>'+(body?'<div style="font-size:10px;color:#888;margin-top:2px">'+body+'</div>':'')+'</div><button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:#aaa;font-size:16px">×</button>';
  document.body.appendChild(el);
  setTimeout(function(){if(el.parentNode){el.style.opacity='0';el.style.transition='.3s';setTimeout(function(){el.remove();},300);}},5000);
}

// ── Init ───────────────────────────────────────────────────────
if (TOKEN) {
  USER = JSON.parse(localStorage.getItem('budaUser')||'null');
  showApp();
} else {
  document.getElementById('loginWrap').style.display = 'block';
}
</script>
</body>
</html>`;
}

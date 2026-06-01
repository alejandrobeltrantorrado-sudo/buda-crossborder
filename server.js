'use strict';
// ─────────────────────────────────────────────────────────────
//  Buda.com Cross-Border Payments · Server v1.0
//  Simulador FX multi-divisa LATAM
// ─────────────────────────────────────────────────────────────
// DB password handled via DATABASE_URL or PGPASSWORD env var

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
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host    : process.env.PGHOST     || 'postgres.railway.internal',
      port    : parseInt(process.env.PGPORT || '5432'),
      database: process.env.PGDATABASE || 'railway',
      user    : process.env.PGUSER     || 'postgres',
      password: process.env.PGPASSWORD,
      ssl     : { rejectUnauthorized: false },
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
  CNY: 7.24,
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
            CNY: parseFloat(rates.CNY) || FALLBACK_RATES.CNY,
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
    await pool.query('DELETE FROM usuarios WHERE email=$1', ['alejandro@buda.com']);
    await pool.query('INSERT INTO usuarios (nombre,empresa,email,password_hash) VALUES ($1,$2,$3,$4)',
      ['Alejandro Beltrán', 'Buda.com', 'alejandro@buda.com', hash]);
    res.json({ ok: true, msg: 'Admin creado · alejandro@buda.com / buda2025' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', fx: fxState.source, updatedAt: fxState.updatedAt }));

// ── Portal Web ────────────────────────────────────────────────
app.get('/', (req, res) => { res.setHeader('Content-Type','text/html'); res.send(portal()); });

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
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#FFFFFF;--bg2:#FFFFFF;--bg3:#F7F8FA;
  --blue:#1A56DB;--blue-d:#1447BB;--blue-l:#EBF2FF;
  --blue-border:#BDD3F9;
  --orange:#F59E0B;--orange-l:#FFFBEB;
  --text:#111928;--gray:#6B7280;--border:#E5E7EB;
  --green:#057A55;--green-l:#F3FAF7;
  --red:#E02424;--red-l:#FDF2F2;
  --white:#FFFFFF;
}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:13px;min-height:100vh}
code,pre,.mono,.sim-val,.ticker-rate,.crTasaRef,.crTasaCli,.crMontoDest{font-family:'JetBrains Mono',monospace!important}

/* Nav */
.nav{background:#FFFFFF;border-bottom:1px solid var(--border);box-shadow:0 1px 3px rgba(0,0,0,.06);padding:0 32px;height:60px;display:flex;align-items:center;gap:0;position:sticky;top:0;z-index:100}
.nav-logo{display:flex;align-items:center;gap:10px;margin-right:40px;text-decoration:none}
.nav-logo-icon{width:36px;height:36px;background:var(--blue);border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px;color:#fff;font-family:'JetBrains Mono',monospace;letter-spacing:-1px}
.nav-logo-text{font-size:16px;font-weight:700;color:var(--text);font-family:'JetBrains Mono',monospace}
.nav-logo-sub{font-size:9px;color:var(--gray);font-weight:400;letter-spacing:.08em;text-transform:uppercase}
.nav-tabs{display:flex;flex:1;gap:0}
.nav-tab{padding:0 18px;height:60px;display:flex;align-items:center;font-size:12px;color:var(--gray);cursor:pointer;border-bottom:2px solid transparent;transition:.15s;white-space:nowrap;letter-spacing:.02em}
.nav-tab:hover{color:var(--blue)}
.nav-tab.active{color:var(--blue);border-bottom-color:var(--blue);font-weight:600}
.nav-r{margin-left:auto;display:flex;align-items:center;gap:10px}
.rates-badge{background:var(--blue-l);border:1px solid var(--blue-border);border-radius:20px;padding:4px 12px;font-size:11px;color:var(--blue);display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace}
.rates-dot{width:6px;height:6px;border-radius:50%;background:var(--blue)}
.user-chip{font-size:12px;color:var(--gray);display:flex;align-items:center;gap:6px}
.av{width:28px;height:28px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}
.btn-sm-nav{padding:5px 14px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--gray);cursor:pointer;font-size:11px}
.btn-sm-nav:hover{border-color:var(--blue);color:var(--blue)}

/* Login */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg3)}
.login-card{background:var(--bg2);border:1px solid var(--border);border-radius:20px;padding:40px;width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.login-brand{text-align:center;margin-bottom:28px}
.login-icon{width:56px;height:56px;background:var(--blue);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:24px;color:#fff;margin-bottom:12px;font-family:'JetBrains Mono',monospace}
.login-title{font-size:22px;font-weight:700;color:var(--white);margin-bottom:4px;font-family:'JetBrains Mono',monospace}
.login-sub{font-size:12px;color:var(--gray)}
.fg{margin-bottom:14px}
.fg label{display:block;font-size:10px;color:var(--gray);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px;font-weight:500;font-family:'JetBrains Mono',monospace}
.fi{width:100%;padding:10px 14px;border-radius:9px;border:1.5px solid var(--border);font-size:13px;color:var(--text);background:#fff;transition:.15s;font-family:'JetBrains Mono',monospace}
.fi:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-l)}
.btn-p{width:100%;padding:12px;border-radius:10px;border:none;background:var(--blue);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:.15s;margin-top:4px;font-family:'Inter',sans-serif}
.btn-p:hover{background:var(--blue-d)}
.btn-sec{width:100%;padding:10px;border-radius:10px;border:1.5px solid var(--border);background:none;color:var(--gray);font-size:13px;cursor:pointer}

/* Main layout */
.main{max-width:1100px;margin:0 auto;padding:24px 16px}
.page{display:none}.page.active{display:block}

/* Hero */
.hero{background:linear-gradient(135deg,var(--blue) 0%,var(--blue-d) 100%);border:none;border-radius:20px;padding:40px 48px;color:#fff;margin-bottom:24px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;right:-80px;top:-80px;width:400px;height:400px;background:radial-gradient(circle,rgba(255,255,255,.1) 0%,transparent 70%)}
.hero-tag{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);border-radius:20px;padding:4px 12px;font-size:11px;display:inline-block;margin-bottom:12px;color:#fff;font-family:'JetBrains Mono',monospace}
.hero-title{font-size:32px;font-weight:700;margin-bottom:8px;line-height:1.2;font-family:'JetBrains Mono',monospace}
.hero-sub{font-size:14px;color:rgba(255,255,255,.8);max-width:500px;line-height:1.6}
.hero-flags{margin-top:20px;display:flex;gap:8px;flex-wrap:wrap}
.flag-chip{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);border-radius:20px;padding:5px 12px;font-size:12px;display:flex;align-items:center;gap:5px;color:#fff}

/* Rates ticker */
.ticker{display:flex;gap:10px;margin-bottom:20px;overflow-x:auto;padding-bottom:4px}
.ticker-item{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:12px 16px;min-width:150px;flex-shrink:0;transition:.15s;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.ticker-item:hover{border-color:var(--blue-border)}
.ticker-par{font-size:10px;color:var(--gray);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;font-family:'JetBrains Mono',monospace}
.ticker-rate{font-size:16px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--text)}
.ticker-src{font-size:9px;color:var(--gray);margin-top:2px}

/* Cards grid */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:16px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:20px}
.card-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--gray);margin-bottom:14px;font-family:'JetBrains Mono',monospace}

/* Simulator */
.sim-result{background:var(--bg3);border:1.5px solid var(--blue-border);border-radius:14px;padding:20px;margin-top:14px}
.sim-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)}
.sim-row:last-child{border:none;font-size:15px;font-weight:700;padding-top:12px;margin-top:4px}
.sim-key{font-size:12px;color:var(--gray);font-family:'JetBrains Mono',monospace}
.sim-val{font-size:13px;font-weight:600;font-family:'JetBrains Mono',monospace;color:var(--text)}
.highlight-val{color:var(--blue);font-size:16px;font-family:'JetBrains Mono',monospace}
.btn-save{width:100%;padding:11px;border-radius:10px;border:none;background:var(--blue);color:#fff;font-size:13px;font-weight:600;cursor:pointer;margin-top:12px;font-family:'Inter',sans-serif}
.btn-save:hover{background:var(--blue-d)}

/* History table */
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{text-align:left;padding:7px 10px;color:var(--gray);font-size:10px;text-transform:uppercase;border-bottom:1px solid var(--border);font-weight:500;font-family:'JetBrains Mono',monospace;letter-spacing:.06em}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--border);font-family:'JetBrains Mono',monospace}
.tbl tr:last-child td{border:none}
.tbl tr:hover td{background:var(--bg3)}
.badge{display:inline-flex;padding:2px 8px;border-radius:100px;font-size:10px;font-weight:600;font-family:'JetBrains Mono',monospace}
.b-teal{background:var(--blue-l);color:var(--blue);border:1px solid var(--blue-border)}
.b-orange{background:var(--orange-l);color:var(--orange)}

/* Currency selector */
.curr-select{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.curr-btn{padding:6px 14px;border-radius:20px;border:1.5px solid var(--border);background:none;font-size:12px;cursor:pointer;transition:.15s;display:flex;align-items:center;gap:5px;color:var(--gray);font-family:'JetBrains Mono',monospace}
.curr-btn.active{border-color:var(--blue);background:var(--blue-l);color:var(--blue);font-weight:600}
.curr-btn:hover{border-color:var(--blue-border);color:var(--text)}

/* Info page */
.info-hero{background:linear-gradient(135deg,var(--blue) 0%,var(--blue-d) 100%);border:none;border-radius:20px;padding:48px;color:#fff;margin-bottom:24px;text-align:center}
.info-title{font-size:28px;font-weight:700;margin-bottom:12px;font-family:'JetBrains Mono',monospace}
.info-sub{font-size:15px;color:rgba(255,255,255,.8);max-width:560px;margin:0 auto;line-height:1.7}
.info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
.info-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:24px;text-align:center}
.info-card:hover{border-color:var(--blue-border)}
.info-icon{font-size:32px;margin-bottom:12px}
.info-card-title{font-size:14px;font-weight:600;margin-bottom:8px;color:var(--text)}
.info-card-text{font-size:12px;color:var(--gray);line-height:1.6}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.step{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px}
.step:hover{border-color:var(--blue-border)}
.step-num{width:28px;height:28px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;margin-bottom:10px;font-family:'JetBrains Mono',monospace}
.step-title{font-size:13px;font-weight:600;margin-bottom:6px}
.step-text{font-size:11px;color:var(--gray);line-height:1.5}
.corr{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.corr-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px}
.corr-card:hover{border-color:var(--blue-border)}
.corr-flag{font-size:28px;margin-bottom:8px}
.corr-name{font-size:13px;font-weight:600;margin-bottom:4px;font-family:'JetBrains Mono',monospace}
.corr-text{font-size:11px;color:var(--gray);line-height:1.5}

/* Float alert */
.float-alert{position:fixed;top:16px;right:16px;z-index:9999;max-width:300px;border-radius:10px;padding:12px 14px;box-shadow:0 4px 24px rgba(0,0,0,.12);animation:slideIn .25s ease;display:flex;gap:8px;align-items:flex-start}
@keyframes slideIn{from{transform:translateX(110%)}to{transform:translateX(0)}}

/* Responsive */
@media(max-width:700px){
  .two-col,.three-col,.info-grid,.steps,.corr{grid-template-columns:1fr}
  .hero{padding:24px}
  .hero-title{font-size:22px}
}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="loginWrap" style="display:none">
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-brand">
        <div style="font-size:32px;font-weight:900;color:#111928;letter-spacing:-1px;font-family:'Inter',sans-serif;margin-bottom:8px">buda<span style="color:var(--blue)">.</span>com</div>
        <div class="login-sub">Cross-Border Payments · Simulador FX</div>
      </div>
      <div class="fg"><label>Email</label><input class="fi" type="email" id="lEmail" autocomplete="off" placeholder="tu@empresa.com"></div>
      <div class="fg"><label>Contraseña</label><input class="fi" type="password" id="lPass" autocomplete="new-password" placeholder="••••••••" onkeydown="if(event.key==='Enter')login()"></div>
      <button class="btn-p" onclick="login()">Ingresar</button>
      <div id="lErr" style="font-size:11px;color:var(--red);text-align:center;margin-top:10px"></div>
      <div style="text-align:center;margin-top:16px;font-size:11px;color:var(--gray)">¿No tienes acceso? <a href="mailto:otc@buda.com" style="color:var(--blue)">Contáctanos</a></div>
    </div>
  </div>
</div>

<!-- APP -->
<div id="appWrap" style="display:none">
  <!-- Nav -->
  <nav class="nav">
    <div class="nav-logo">
      <div class="nav-logo-icon">B.</div>
      <div>
        <div class="nav-logo-text">Buda.com</div>
        <div class="nav-logo-sub">Cross-Border Payments</div>
      </div>
    </div>
    <div class="nav-tabs">
      <div class="nav-tab active" onclick="showPage('sim')">Simulador</div>
      <div class="nav-tab" onclick="showPage('rates')">Tasas</div>
      <div class="nav-tab" onclick="showPage('hist')">Mis simulaciones</div>
      <div class="nav-tab" onclick="showPage('info')">¿Qué es Cross-Border?</div>
    </div>
    <div class="nav-r">
      <div class="rates-badge"><div class="rates-dot" id="ratesDot"></div><span id="ratesSource">Cargando...</span></div>
      <div class="user-chip"><div class="av" id="userAv">B</div><span id="userName"></span></div>
      <button class="btn-sm-nav" onclick="logout()">Salir</button>
    </div>
  </nav>

  <!-- Content -->
  <div class="main">

    <!-- SIMULADOR -->
    <div class="page active" id="page-sim">
      <div class="hero">
        <div class="hero-tag">⚡ Simulador en tiempo real</div>
        <div class="hero-title">Cotiza tu operación<br>cross-border</div>
        <div class="hero-sub">Calcula el tipo de cambio, tu margen y el volumen proyectado para operaciones entre países de Latinoamérica.</div>
        <div class="hero-flags">
          <div class="flag-chip">🇨🇴 Peso Colombiano</div>
          <div class="flag-chip">🇨🇱 Peso Chileno</div>
          <div class="flag-chip">🇵🇪 Sol Peruano</div>
          <div class="flag-chip">🇧🇴 Boliviano</div>
          <div class="flag-chip">🇻🇪 Bolívar Venezolano</div>
          <div class="flag-chip">🇨🇳 Yuan Chino</div>
        </div>
      </div>

      <!-- Ticker -->
      <div class="ticker" id="ticker"></div>

      <div class="two-col">
        <!-- Simulator form -->
        <div class="card">
          <div class="card-title">Parámetros de la operación</div>

          <div class="fg">
            <label>Moneda origen</label>
            <div class="curr-select" id="origSelect"></div>
          </div>
          <div class="fg">
            <label>Moneda destino</label>
            <div class="curr-select" id="destSelect"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="fg">
              <label>Monto a convertir</label>
              <input class="fi" type="number" id="simMonto" placeholder="10.000" oninput="calcSim()">
            </div>
            <div class="fg">
              <label>Tu margen (%)</label>
              <input class="fi" type="number" id="simMargen" placeholder="1.5" step="0.1" oninput="calcSim()">
            </div>
          </div>

          <!-- Resultado cotización -->
          <div id="cotResult" style="display:none;background:var(--blue-l);border:1px solid var(--blue-border);border-radius:10px;padding:14px;margin-bottom:14px">
            <div style="font-size:10px;color:var(--blue);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;font-weight:600;font-family:'JetBrains Mono',monospace">Resultado de conversión</div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:12px;color:var(--gray)">Tasa referencia</span>
              <span style="font-size:13px;font-weight:600;font-family:monospace" id="crTasaRef">—</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:12px;color:var(--gray)">Tu tasa (c/margen)</span>
              <span style="font-size:14px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--blue)" id="crTasaCli">—</span>
            </div>
            <div style="display:flex;justify-content:space-between;border-top:1px solid rgba(0,131,122,.15);padding-top:8px;margin-top:4px">
              <span style="font-size:12px;color:var(--gray)" id="crLabel">Monto destino</span>
              <span style="font-size:16px;font-weight:700;color:var(--blue);font-family:'JetBrains Mono',monospace" id="crMontoDest">—</span>
            </div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
            <div class="card-title">Simulador de volumen</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div class="fg">
                <label>Ticket promedio</label>
                <input class="fi" type="number" id="simTicket" placeholder="50.000" oninput="calcSim()">
              </div>
              <div class="fg">
                <label>Nº de operaciones</label>
                <input class="fi" type="number" id="simNumOps" placeholder="20" oninput="calcSim()">
              </div>
            </div>
            <div class="fg">
              <label>Notas (opcional)</label>
              <input class="fi" type="text" id="simNotas" placeholder="Ej: operaciones mensuales sector salud">
            </div>
          </div>
        </div>

        <!-- Results -->
        <div>
          <div class="card" style="margin-bottom:14px">
            <div class="card-title">Resumen de la simulación</div>
            <div id="simResult" style="color:var(--gray);font-size:12px;text-align:center;padding:20px 0">
              Completa los campos para ver la proyección
            </div>
          </div>
          <div class="card" style="background:linear-gradient(135deg,#1A1D2E,#2D3050);border:none">
            <div class="card-title" style="color:rgba(255,255,255,.5)">¿Por qué Buda.com?</div>
            <div style="display:flex;flex-direction:column;gap:10px">
              <div style="display:flex;gap:10px;align-items:flex-start">
                <span style="font-size:18px">⚡</span>
                <div><div style="font-size:12px;font-weight:600;color:#fff">Liquidez inmediata</div><div style="font-size:11px;color:rgba(255,255,255,.5);margin-top:2px">Operaciones en minutos, no días</div></div>
              </div>
              <div style="display:flex;gap:10px;align-items:flex-start">
                <span style="font-size:18px">🔒</span>
                <div><div style="font-size:12px;font-weight:600;color:#fff">Regulado y seguro</div><div style="font-size:11px;color:rgba(255,255,255,.5);margin-top:2px">Cumplimiento AML/KYC en todos los países</div></div>
              </div>
              <div style="display:flex;gap:10px;align-items:flex-start">
                <span style="font-size:18px">📊</span>
                <div><div style="font-size:12px;font-weight:600;color:#fff">Tasas competitivas</div><div style="font-size:11px;color:rgba(255,255,255,.5);margin-top:2px">Referencia de mercado + tu margen</div></div>
              </div>
              <div style="display:flex;gap:10px;align-items:flex-start">
                <span style="font-size:18px">🌎</span>
                <div><div style="font-size:12px;font-weight:600;color:#fff">5 países LATAM</div><div style="font-size:11px;color:rgba(255,255,255,.5);margin-top:2px">CO · CL · PE · BO · VE</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TASAS -->
    <div class="page" id="page-rates">
      <div style="margin-bottom:20px">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px">Tasas de referencia</div>
        <div style="font-size:12px;color:var(--gray)" id="ratesUpdated"></div>
      </div>
      <div class="three-col" id="ratesGrid"></div>
      <div class="card" style="max-width:480px">
        <div class="card-title">Actualizar tasa manual</div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end">
          <div class="fg" style="margin:0">
            <label>Moneda</label>
            <select class="fi" id="manPar"><option value="COP">COP</option><option value="CLP">CLP</option><option value="PEN">PEN</option><option value="BOB">BOB</option><option value="VES">VES</option><option value="CNY">CNY</option></select>
          </div>
          <div class="fg" style="margin:0">
            <label>Tasa vs USD</label>
            <input class="fi" id="manTasa" type="number" placeholder="4180">
          </div>
          <button class="btn-p" style="padding:10px 16px;width:auto;margin:0" onclick="saveTasa()">Guardar</button>
        </div>
        <div id="tasaMsg" style="font-size:11px;margin-top:8px;display:none"></div>
      </div>
    </div>

    <!-- HISTORIAL -->
    <div class="page" id="page-hist">
      <div style="font-size:20px;font-weight:700;margin-bottom:16px">Mis simulaciones</div>
      <div class="card" style="padding:0;overflow:hidden">
        <div style="overflow-x:auto">
          <table class="tbl">
            <thead><tr><th>Par</th><th>Tasa ref.</th><th>Tu tasa</th><th>Margen</th><th>Volumen</th><th>Ganancia proy.</th><th>Fecha</th></tr></thead>
            <tbody id="histBody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- INFO -->
    <div class="page" id="page-info">

      <!-- Hero statement -->
      <div style="text-align:center;padding:64px 24px 48px;max-width:720px;margin:0 auto">
        <div style="font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--blue);margin-bottom:16px;font-family:'JetBrains Mono',monospace">Infraestructura · B2B · API-first</div>
        <div style="font-size:42px;font-weight:800;line-height:1.15;color:var(--text);margin-bottom:20px;letter-spacing:-1px">Pagos internacionales<br>en minutos, no en días</div>
        <div style="font-size:17px;color:var(--gray);line-height:1.7;max-width:560px;margin:0 auto 32px">Conecta tu empresa a una red de liquidación instantánea entre Latinoamérica y Asia. Una sola API. Múltiples corredores. Sin fricción bancaria.</div>
        <a href="mailto:otc@buda.com" style="display:inline-block;padding:14px 32px;background:var(--blue);color:#fff;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;margin-right:10px">Hablar con el equipo →</a>
        <a onclick="showPage('sim');event.preventDefault()" href="#" style="display:inline-block;padding:14px 32px;border:1.5px solid var(--border);color:var(--text);border-radius:10px;font-weight:500;font-size:14px;text-decoration:none">Ver simulador</a>
      </div>

      <!-- Differentiators -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-bottom:48px">
        <div style="background:#fff;padding:32px">
          <div style="font-size:28px;font-weight:800;color:var(--blue);font-family:'JetBrains Mono',monospace;margin-bottom:6px">&lt; 5 min</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:6px">Liquidación en minutos</div>
          <div style="font-size:13px;color:var(--gray);line-height:1.6">vs 2–5 días hábiles por canales bancarios tradicionales. Disponible 24/7, los 365 días del año.</div>
        </div>
        <div style="background:#fff;padding:32px">
          <div style="font-size:28px;font-weight:800;color:var(--blue);font-family:'JetBrains Mono',monospace;margin-bottom:6px">1 API</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:6px">Integración única</div>
          <div style="font-size:13px;color:var(--gray);line-height:1.6">Un solo punto de conexión para operar en todos los corredores activos. Documentación lista, soporte dedicado.</div>
        </div>
        <div style="background:#fff;padding:32px">
          <div style="font-size:28px;font-weight:800;color:var(--blue);font-family:'JetBrains Mono',monospace;margin-bottom:6px">6 países</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:6px">Red en expansión</div>
          <div style="font-size:13px;color:var(--gray);line-height:1.6">Colombia, Chile, Perú, Bolivia, Venezuela y China activos hoy. Nuevos corredores en camino.</div>
        </div>
      </div>

      <!-- Use cases -->
      <div style="margin-bottom:48px">
        <div style="font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--gray);margin-bottom:24px;text-align:center;font-family:'JetBrains Mono',monospace">Casos de uso</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px">
          <div style="background:var(--bg3);border-radius:14px;padding:28px;display:flex;gap:20px;align-items:flex-start">
            <div style="width:44px;height:44px;background:var(--blue-l);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">💸</div>
            <div>
              <div style="font-size:14px;font-weight:600;margin-bottom:6px">Plataformas de remesas</div>
              <div style="font-size:13px;color:var(--gray);line-height:1.6">Ofrece a tus usuarios giros internacionales al instante. Cobra tu margen sobre la tasa de referencia y escala sin límites operativos.</div>
            </div>
          </div>
          <div style="background:var(--bg3);border-radius:14px;padding:28px;display:flex;gap:20px;align-items:flex-start">
            <div style="width:44px;height:44px;background:var(--blue-l);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🏢</div>
            <div>
              <div style="font-size:14px;font-weight:600;margin-bottom:6px">Pagos B2B internacionales</div>
              <div style="font-size:13px;color:var(--gray);line-height:1.6">Paga proveedores, nómina o servicios en otro país sin cuentas bancarias locales, corresponsales ni días de espera.</div>
            </div>
          </div>
          <div style="background:var(--bg3);border-radius:14px;padding:28px;display:flex;gap:20px;align-items:flex-start">
            <div style="width:44px;height:44px;background:var(--blue-l);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🛒</div>
            <div>
              <div style="font-size:14px;font-weight:600;margin-bottom:6px">Comercio electrónico cross-border</div>
              <div style="font-size:13px;color:var(--gray);line-height:1.6">Acepta pagos en la moneda local de tus compradores y recibe en la tuya. Sin rechazos de tarjeta, sin fricciones.</div>
            </div>
          </div>
          <div style="background:var(--bg3);border-radius:14px;padding:28px;display:flex;gap:20px;align-items:flex-start">
            <div style="width:44px;height:44px;background:var(--blue-l);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🏦</div>
            <div>
              <div style="font-size:14px;font-weight:600;margin-bottom:6px">Fintech y neobancos</div>
              <div style="font-size:13px;color:var(--gray);line-height:1.6">Agrega transferencias internacionales a tu producto sin construir la infraestructura. Conéctate en días, no meses.</div>
            </div>
          </div>
        </div>
      </div>

      <!-- How it works -->
      <div style="margin-bottom:48px">
        <div style="font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--gray);margin-bottom:24px;text-align:center;font-family:'JetBrains Mono',monospace">Cómo funciona</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;position:relative">
          <div style="position:absolute;top:22px;left:calc(12.5% + 0px);width:75%;height:1px;background:var(--border);z-index:0"></div>
          <div style="padding:0 16px;text-align:center;position:relative;z-index:1"><div style="width:44px;height:44px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;margin:0 auto 16px">1</div><div style="font-size:13px;font-weight:600;margin-bottom:6px">Tu sistema llama la API</div><div style="font-size:12px;color:var(--gray);line-height:1.5">Cotizaci\u00f3n en tiempo real al tipo de cambio de mercado.</div></div>
          <div style="padding:0 16px;text-align:center;position:relative;z-index:1"><div style="width:44px;height:44px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;margin:0 auto 16px">2</div><div style="font-size:13px;font-weight:600;margin-bottom:6px">Fondos en cuenta local</div><div style="font-size:12px;color:var(--gray);line-height:1.5">Tu cliente deposita en moneda local en el pa\u00eds de origen.</div></div>
          <div style="padding:0 16px;text-align:center;position:relative;z-index:1"><div style="width:44px;height:44px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;margin:0 auto 16px">3</div><div style="font-size:13px;font-weight:600;margin-bottom:6px">Liquidaci\u00f3n instant\u00e1nea</div><div style="font-size:12px;color:var(--gray);line-height:1.5">Buda.com procesa y acredita en el pa\u00eds destino en minutos.</div></div>
          <div style="padding:0 16px;text-align:center;position:relative;z-index:1"><div style="width:44px;height:44px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;margin:0 auto 16px">4</div><div style="font-size:13px;font-weight:600;margin-bottom:6px">Confirmaci\u00f3n autom\u00e1tica</div><div style="font-size:12px;color:var(--gray);line-height:1.5">Tu sistema recibe webhook con el comprobante de pago.</div></div>
      </div>

      <!-- Active corridors -->
      <div style="margin-bottom:48px">
        <div style="font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--gray);margin-bottom:24px;text-align:center;font-family:'JetBrains Mono',monospace">Corredores activos</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
          <div style="border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px">
            <div style="font-size:28px">🇨🇴🇨🇱</div>
            <div><div style="font-size:13px;font-weight:600">Colombia → Chile</div><div style="font-size:11px;color:var(--gray);margin-top:2px">COP / CLP</div></div>
            <div style="margin-left:auto"><span style="background:var(--green-l);color:var(--green);font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;font-family:'JetBrains Mono',monospace">Activo</span></div>
          </div>
          <div style="border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px">
            <div style="font-size:28px">🇨🇴🇵🇪</div>
            <div><div style="font-size:13px;font-weight:600">Colombia → Perú</div><div style="font-size:11px;color:var(--gray);margin-top:2px">COP / PEN</div></div>
            <div style="margin-left:auto"><span style="background:var(--green-l);color:var(--green);font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;font-family:'JetBrains Mono',monospace">Activo</span></div>
          </div>
          <div style="border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px">
            <div style="font-size:28px">🇨🇴🇧🇴</div>
            <div><div style="font-size:13px;font-weight:600">Colombia → Bolivia</div><div style="font-size:11px;color:var(--gray);margin-top:2px">COP / BOB</div></div>
            <div style="margin-left:auto"><span style="background:var(--green-l);color:var(--green);font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;font-family:'JetBrains Mono',monospace">Activo</span></div>
          </div>
          <div style="border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px">
            <div style="font-size:28px">🇨🇴🇻🇪</div>
            <div><div style="font-size:13px;font-weight:600">Colombia → Venezuela</div><div style="font-size:11px;color:var(--gray);margin-top:2px">COP / VES</div></div>
            <div style="margin-left:auto"><span style="background:var(--green-l);color:var(--green);font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;font-family:'JetBrains Mono',monospace">Activo</span></div>
          </div>
          <div style="border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px">
            <div style="font-size:28px">🇨🇴🇨🇳</div>
            <div><div style="font-size:13px;font-weight:600">Colombia → China</div><div style="font-size:11px;color:var(--gray);margin-top:2px">COP / CNY</div></div>
            <div style="margin-left:auto"><span style="background:var(--green-l);color:var(--green);font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;font-family:'JetBrains Mono',monospace">Activo</span></div>
          </div>
          <div style="border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px;opacity:.5">
            <div style="font-size:28px">🌎</div>
            <div><div style="font-size:13px;font-weight:600">Más corredores</div><div style="font-size:11px;color:var(--gray);margin-top:2px">En desarrollo</div></div>
            <div style="margin-left:auto"><span style="background:var(--bg3);color:var(--gray);font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;font-family:'JetBrains Mono',monospace">Próximo</span></div>
          </div>
        </div>
      </div>

      <!-- CTA final -->
      <div style="background:var(--text);border-radius:20px;padding:56px;text-align:center;margin-bottom:24px">
        <div style="font-size:32px;font-weight:800;color:#fff;margin-bottom:12px;letter-spacing:-.5px">¿Tu empresa mueve dinero<br>entre países?</div>
        <div style="font-size:15px;color:rgba(255,255,255,.6);margin-bottom:32px;max-width:480px;margin-left:auto;margin-right:auto;line-height:1.6">Hablemos. En 30 minutos te mostramos cómo funciona la integración y simulamos tu modelo de negocio.</div>
        <a href="mailto:otc@buda.com" style="display:inline-block;padding:14px 36px;background:var(--blue);color:#fff;border-radius:10px;font-weight:600;font-size:15px;text-decoration:none">Agendar llamada →</a>
      </div>

    </div>

  </div>
</div>

<script>
const BASE = window.location.origin;
let TOKEN = localStorage.getItem('budaToken');
let USER  = JSON.parse(localStorage.getItem('budaUser')||'null');
let fxData = {};
let simOrig = 'USD', simDest = 'COP';

const CURRENCIES = {
  COP: { flag:'🇨🇴', name:'Peso Colombiano',  symbol:'$'   },
  CLP: { flag:'🇨🇱', name:'Peso Chileno',     symbol:'$'   },
  PEN: { flag:'🇵🇪', name:'Sol Peruano',      symbol:'S/'  },
  BOB: { flag:'🇧🇴', name:'Boliviano',        symbol:'Bs.' },
  VES: { flag:'🇻🇪', name:'Bolívar',          symbol:'Bs.' },
  CNY: { flag:'🇨🇳', name:'Yuan Chino',       symbol:'¥'   },
  USD: { flag:'🇺🇸', name:'Dólar USD',        symbol:'$'   },
};

const fmt = function(n, dec) {
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
  var d = await api('POST','/auth/login',{email:email, password:pass});
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
  document.getElementById('userName').textContent = USER && USER.nombre ? USER.nombre : '';
  var av = USER && USER.nombre ? USER.nombre.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase() : 'B';
  document.getElementById('userAv').textContent = av;
  buildCurrencySelectors();
  loadRates();
  setInterval(loadRates, 3600000);
}

async function loadRates() {
  var d = await api('GET','/api/rates');
  if (!d.rates) return;
  fxData = d;
  var dot = document.getElementById('ratesDot');
  var src = document.getElementById('ratesSource');
  dot.style.background = d.source==='api' ? 'var(--blue)' : '#F59E0B';
  src.textContent = d.source==='api' ? 'API en tiempo real' : 'Tasas manuales';
  document.getElementById('ratesUpdated').textContent = 'Actualizado: ' + new Date(d.updatedAt).toLocaleString('es-CO');
  renderTicker(d.rates);
  renderRatesGrid(d.rates);
  calcSim();
}

function renderTicker(rates) {
  var pairs = [['COP','CLP'],['COP','PEN'],['COP','BOB'],['COP','VES'],['COP','CNY'],['USD','COP'],['CLP','PEN']];
  document.getElementById('ticker').innerHTML = pairs.map(function(p) {
    var r = (rates[p[1]]||1) / (rates[p[0]]||1);
    return '<div class="ticker-item">' +
      '<div class="ticker-par">'+CURRENCIES[p[0]].flag+' '+p[0]+' / '+CURRENCIES[p[1]].flag+' '+p[1]+'</div>' +
      '<div class="ticker-rate">'+fmt(r, r < 10 ? 4 : 2)+'</div>' +
      '<div class="ticker-src">'+CURRENCIES[p[1]].name+'</div>' +
      '</div>';
  }).join('');
}

function renderRatesGrid(rates) {
  var currs = ['COP','CLP','PEN','BOB','VES','CNY'];
  document.getElementById('ratesGrid').innerHTML = currs.map(function(c) {
    var r = rates[c] || 0;
    var info = CURRENCIES[c];
    return '<div class="card">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
        '<span style="font-size:24px">'+info.flag+'</span>' +
        '<div><div style="font-size:13px;font-weight:600">'+info.name+'</div><div style="font-size:10px;color:var(--gray)">'+c+'</div></div>' +
      '</div>' +
      '<div style="font-size:24px;font-weight:700;font-family:monospace;color:var(--blue)">'+info.symbol+' '+fmt(r, r < 10 ? 4 : 2)+'</div>' +
      '<div style="font-size:11px;color:var(--gray);margin-top:4px">por 1 USD</div>' +
      '</div>';
  }).join('');
}

function buildCurrencySelectors() {
  var keys = Object.keys(CURRENCIES);
  document.getElementById('origSelect').innerHTML = keys.map(function(c) {
    return '<button class="curr-btn'+(c===simOrig?' active':'')+'" onclick="setOrig(&quot;'+c+'&quot;)">'+CURRENCIES[c].flag+' '+c+'</button>';
  }).join('');
  document.getElementById('destSelect').innerHTML = keys.map(function(c) {
    return '<button class="curr-btn'+(c===simDest?' active':'')+'" onclick="setDest(&quot;'+c+'&quot;)">'+CURRENCIES[c].flag+' '+c+'</button>';
  }).join('');
}

function setOrig(c) { simOrig=c; buildCurrencySelectors(); calcSim(); }
function setDest(c) { simDest=c; buildCurrencySelectors(); calcSim(); }

function calcSim() {
  if (!fxData.rates) return;
  var monto   = parseFloat(document.getElementById('simMonto').value) || 0;
  var margen  = parseFloat(document.getElementById('simMargen').value) || 0;
  var ticket  = parseFloat(document.getElementById('simTicket').value) || 0;
  var numOps  = parseInt(document.getElementById('simNumOps').value)   || 0;

  var rOrig = fxData.rates[simOrig] || 1;
  var rDest = fxData.rates[simDest] || 1;
  var tasaRef = rDest / rOrig;
  var tasaCli = tasaRef * (1 + margen / 100);

  // Cotización
  if (monto > 0) {
    var montoDest = monto * tasaCli;
    document.getElementById('cotResult').style.display = 'block';
    document.getElementById('crTasaRef').textContent = fmt(tasaRef, tasaRef < 10 ? 4 : 2);
    document.getElementById('crTasaCli').textContent = fmt(tasaCli, tasaCli < 10 ? 4 : 2) + (margen ? ' (+'+margen+'%)' : '');
    document.getElementById('crLabel').textContent   = 'Monto en '+simDest;
    document.getElementById('crMontoDest').textContent = CURRENCIES[simDest].symbol + ' ' + fmt(montoDest);
  }

  // Simulación de volumen
  if (ticket > 0 && numOps > 0) {
    var volumen  = ticket * numOps;
    var ganancia = volumen * (margen / 100);
    var gananciaDestino = ganancia * tasaCli;

    document.getElementById('simResult').innerHTML =
      '<div class="sim-result">' +
        '<div class="sim-row"><span class="sim-key">Par</span><span class="sim-val">'+simOrig+' → '+simDest+'</span></div>' +
        '<div class="sim-row"><span class="sim-key">Tasa de referencia</span><span class="sim-val">'+fmt(tasaRef, tasaRef<10?4:2)+'</span></div>' +
        '<div class="sim-row"><span class="sim-key">Tu tasa (margen '+margen+'%)</span><span class="sim-val" style="color:var(--blue)">'+fmt(tasaCli, tasaCli<10?4:2)+'</span></div>' +
        '<div class="sim-row"><span class="sim-key">Ticket promedio</span><span class="sim-val">'+CURRENCIES[simOrig].symbol+' '+fmt(ticket)+'</span></div>' +
        '<div class="sim-row"><span class="sim-key">Nº de operaciones</span><span class="sim-val">'+numOps.toLocaleString('es-CO')+'</span></div>' +
        '<div class="sim-row"><span class="sim-key">Volumen total</span><span class="sim-val">'+CURRENCIES[simOrig].symbol+' '+fmt(volumen)+'</span></div>' +
        '<div class="sim-row"><span class="sim-key" style="font-size:13px;font-weight:600;color:var(--text)">Ganancia proyectada</span>' +
          '<span class="sim-val highlight-val">'+CURRENCIES[simOrig].symbol+' '+fmt(ganancia)+' <span style="font-size:11px;color:var(--gray)">('+CURRENCIES[simDest].symbol+' '+fmt(gananciaDestino)+')</span></span>' +
        '</div>' +
      '</div>' +
      '<button class="btn-save" onclick="guardarSim()">💾 Guardar simulación</button>';
  }
}

async function guardarSim() {
  var margen  = parseFloat(document.getElementById('simMargen').value) || 0;
  var ticket  = parseFloat(document.getElementById('simTicket').value) || 0;
  var numOps  = parseInt(document.getElementById('simNumOps').value)   || 0;
  var notas   = document.getElementById('simNotas').value;
  if (!ticket || !numOps) { floatAlert('Completa ticket y número de operaciones','','red'); return; }
  var d = await api('POST','/api/simular', {
    moneda_origen: simOrig, moneda_destino: simDest,
    margen_pct: margen, ticket_promedio: ticket,
    num_operaciones: numOps, notas: notas
  });
  if (d.error) { floatAlert('Error', d.error, 'red'); return; }
  floatAlert('Simulación guardada', 'Ganancia proyectada: ' + CURRENCIES[simOrig].symbol + ' ' + fmt(d.ganancia_proyectada), 'teal');
}

async function loadHist() {
  var d = await api('GET','/api/mis-simulaciones');
  var rows = d.simulaciones || [];
  document.getElementById('histBody').innerHTML = rows.length ? rows.map(function(r) {
    return '<tr>' +
      '<td><span class="badge b-teal">'+r.par+'</span></td>' +
      '<td style="font-family:monospace">'+fmt(r.tasa_referencia,4)+'</td>' +
      '<td style="font-family:monospace;color:var(--blue)">'+fmt(r.tasa_cliente,4)+'</td>' +
      '<td>'+fmt(r.margen_pct,2)+'%</td>' +
      '<td style="font-family:monospace">'+fmt(r.volumen_total)+'</td>' +
      '<td style="font-family:monospace;color:var(--green);font-weight:600">'+fmt(r.ganancia_proyectada)+'</td>' +
      '<td style="font-size:10px;color:var(--gray)">'+new Date(r.created_at).toLocaleString('es-CO',{day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit'})+'</td>' +
      '</tr>';
  }).join('') : '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--gray)">No tienes simulaciones guardadas aún</td></tr>';
}

async function saveTasa() {
  var par  = document.getElementById('manPar').value;
  var tasa = document.getElementById('manTasa').value;
  var msg  = document.getElementById('tasaMsg');
  if (!tasa) return;
  var d = await api('POST','/api/tasa-manual',{par:par, tasa:tasa});
  msg.style.display = 'block';
  if (d.ok) {
    msg.textContent = 'Tasa guardada: '+par+' = '+tasa;
    msg.style.color = 'var(--blue)';
    loadRates();
  } else {
    msg.textContent = d.error || 'Error';
    msg.style.color = 'var(--red)';
  }
}

function showPage(p) {
  document.querySelectorAll('.page').forEach(function(el){el.classList.remove('active');});
  document.querySelectorAll('.nav-tab').forEach(function(el){el.classList.remove('active');});
  document.getElementById('page-'+p).classList.add('active');
  event && event.target && event.target.classList.add('active');
  if (p==='hist') loadHist();
  if (p==='rates') loadRates();
}

function calcMonthly() {
  var ticket  = parseFloat(document.getElementById('mTicket').value) || 0;
  var opsDay  = parseFloat(document.getElementById('mOpsDay').value) || 0;
  var days    = parseFloat(document.getElementById('mDays').value)   || 22;
  var margen  = parseFloat(document.getElementById('mMargen').value) || 0;
  if (!ticket || !opsDay || !margen) { document.getElementById('monthlyResult').style.display='none'; return; }
  var opsMonth   = opsDay * days;
  var volMonth   = ticket * opsMonth;
  var margenMonth = volMonth * (margen / 100);
  var margenYear  = margenMonth * 12;
  var curr = CURRENCIES[simOrig] ? CURRENCIES[simOrig].symbol : '$';
  document.getElementById('mResOps').textContent     = opsMonth.toLocaleString('es-CO');
  document.getElementById('mResVol').textContent     = curr + ' ' + fmt(volMonth);
  document.getElementById('mResMargen').textContent  = curr + ' ' + fmt(margenMonth);
  document.getElementById('mResAnual').textContent   = curr + ' ' + fmt(margenYear);
  document.getElementById('mResFormula').textContent = opsDay + ' ops/día × ' + days + ' días × ' + curr + ' ' + fmt(ticket) + ' ticket × ' + margen + '% margen = ' + curr + ' ' + fmt(margenMonth) + '/mes';
  document.getElementById('monthlyResult').style.display = 'block';
}

function floatAlert(title, body, type) {
  var colors = {teal:['var(--blue-l)','var(--blue)','✅'], red:['var(--red-l)','var(--red)','❌'], orange:['var(--orange-l)','var(--orange)','⚠️']};
  var c = colors[type]||colors.teal;
  var el = document.createElement('div');
  el.className = 'float-alert';
  el.style.background = c[0]; el.style.border = '1px solid '+c[1]+'40';
  el.innerHTML = '<span style="font-size:18px">'+c[2]+'</span><div style="flex:1"><div style="font-size:12px;font-weight:500;color:'+c[1]+'">'+title+'</div>'+(body?'<div style="font-size:10px;color:#888;margin-top:2px">'+body+'</div>':'')+'</div><button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:#aaa;font-size:16px">×</button>';
  document.body.appendChild(el);
  setTimeout(function(){if(el.parentNode){el.style.opacity='0';el.style.transition='.3s';setTimeout(function(){el.remove();},300);}},5000);
}

// Init
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

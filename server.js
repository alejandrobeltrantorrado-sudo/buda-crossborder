'use strict';
const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'buda-crossborder-2025';
const FX_API_KEY = process.env.FX_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.PGHOST || 'postgres.railway.internal',
      port: parseInt(process.env.PGPORT || '5432'),
      database: process.env.PGDATABASE || 'railway',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD,
      ssl: { rejectUnauthorized: false },
    });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      empresa VARCHAR(100),
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS simulaciones (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      usuario_nombre VARCHAR(100),
      empresa VARCHAR(100),
      par VARCHAR(20),
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
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[db] Tables ready');
}

const FALLBACK = { COP:4180, CLP:970, PEN:3.72, BOB:6.91, VES:46.50, CNY:7.24, USD:1 };
let fxState = { rates: {...FALLBACK}, source: 'manual', updatedAt: new Date().toISOString() };

async function refreshFX() {
  if (FX_API_KEY) {
    try {
      const r = await axios.get(`https://v6.exchangerate-api.com/v6/${FX_API_KEY}/latest/USD`, { timeout: 10000 });
      if (r.data && r.data.conversion_rates) {
        const rt = r.data.conversion_rates;
        fxState = { rates: { COP: rt.COP||FALLBACK.COP, CLP: rt.CLP||FALLBACK.CLP, PEN: rt.PEN||FALLBACK.PEN, BOB: rt.BOB||FALLBACK.BOB, VES: rt.VES||FALLBACK.VES, CNY: rt.CNY||FALLBACK.CNY, USD: 1 }, source: 'api', updatedAt: new Date().toISOString() };
        return;
      }
    } catch(e) { console.log('[fx] API error:', e.message); }
  }
  try {
    const r = await pool.query('SELECT par, tasa FROM tasas_manuales');
    r.rows.forEach(row => { if (FALLBACK[row.par] !== undefined) fxState.rates[row.par] = parseFloat(row.tasa); });
    fxState.updatedAt = new Date().toISOString();
  } catch(e) {}
}

function authMw(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Sin token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Token invalido' }); }
}

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Faltan campos' });
  try {
    const r = await pool.query('SELECT * FROM usuarios WHERE email=$1 AND activo=true', [email.trim()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Credenciales invalidas' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales invalidas' });
    const u = r.rows[0];
    const token = jwt.sign({ id: u.id, email: u.email, nombre: u.nombre, empresa: u.empresa }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: u.id, nombre: u.nombre, empresa: u.empresa, email: u.email } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rates', (req, res) => res.json(fxState));

app.post('/api/cotizar', authMw, (req, res) => {
  const { moneda_origen, moneda_destino, monto, margen_pct } = req.body;
  const rO = fxState.rates[moneda_origen] || 1;
  const rD = fxState.rates[moneda_destino] || 1;
  const tasaRef = rD / rO;
  const margen = parseFloat(margen_pct) || 0;
  const tasaCli = tasaRef * (1 + margen / 100);
  res.json({ tasaRef: parseFloat(tasaRef.toFixed(6)), tasaCli: parseFloat(tasaCli.toFixed(6)), monto_destino: parseFloat(monto) * tasaCli, source: fxState.source });
});

app.post('/api/simular', authMw, async (req, res) => {
  const { moneda_origen, moneda_destino, margen_pct, ticket_promedio, num_operaciones, notas } = req.body;
  const rO = fxState.rates[moneda_origen] || 1;
  const rD = fxState.rates[moneda_destino] || 1;
  const tasaRef = rD / rO;
  const margen = parseFloat(margen_pct) || 0;
  const tasaCli = tasaRef * (1 + margen / 100);
  const ticket = parseFloat(ticket_promedio);
  const numOps = parseInt(num_operaciones);
  const volumen = ticket * numOps;
  const ganancia = volumen * (margen / 100);
  try {
    await pool.query('INSERT INTO simulaciones (usuario_id,usuario_nombre,empresa,par,moneda_origen,moneda_destino,tasa_referencia,tasa_cliente,margen_pct,ticket_promedio,num_operaciones,volumen_total,ganancia_proyectada,notas) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [req.user.id, req.user.nombre, req.user.empresa, moneda_origen+'/'+moneda_destino, moneda_origen, moneda_destino, tasaRef.toFixed(6), tasaCli.toFixed(6), margen, ticket, numOps, volumen.toFixed(2), ganancia.toFixed(2), notas||'']);
  } catch(e) { console.error('[sim]', e.message); }
  res.json({ par: moneda_origen+'/'+moneda_destino, tasaRef: parseFloat(tasaRef.toFixed(6)), tasaCli: parseFloat(tasaCli.toFixed(6)), margen_pct: margen, volumen_total: parseFloat(volumen.toFixed(2)), ganancia_proyectada: parseFloat(ganancia.toFixed(2)) });
});

app.get('/api/mis-simulaciones', authMw, async (req, res) => {
  const r = await pool.query('SELECT * FROM simulaciones WHERE usuario_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ simulaciones: r.rows });
});

app.post('/api/tasa-manual', authMw, async (req, res) => {
  const { par, tasa } = req.body;
  await pool.query('INSERT INTO tasas_manuales (par,tasa) VALUES ($1,$2) ON CONFLICT (par) DO UPDATE SET tasa=$2, updated_at=NOW()', [par, tasa]);
  await refreshFX();
  res.json({ ok: true });
});

app.post('/api/chat', authMw, async (req, res) => {
  const { messages } = req.body;
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Chat no configurado' });
  const rates = fxState.rates;
  const system = `Eres el asistente de Buda.com Cross-Border Payments, servicio B2B de pagos internacionales LATAM y Asia. Ayuda con tasas, simulaciones de negocio y preguntas sobre el servicio. NO menciones criptomonedas. Usa terminos como "rieles de pago", "liquidacion instantanea". Responde en espanol, conciso.

TASAS ACTUALES (USD base): COP=${rates.COP}, CLP=${rates.CLP}, PEN=${rates.PEN}, BOB=${rates.BOB}, VES=${rates.VES}, CNY=${rates.CNY}
Tasa cruzada = tasa_destino / tasa_origen
Margen mensual = ticket x ops_dia x dias_mes x (margen_pct/100)
Corredores activos: Colombia-Chile, Colombia-Peru, Colombia-Bolivia, Colombia-Venezuela, Colombia-China`;

  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 1024, system, messages },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
    );
    res.json({ response: r.data.content[0].text });
  } catch(e) {
    res.status(500).json({ error: e.response ? JSON.stringify(e.response.data) : e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', fx: fxState.source }));

app.get('/reset-admin', async (req, res) => {
  try {
    const hash = await bcrypt.hash('buda2025', 10);
    const u = await pool.query('SELECT id FROM usuarios WHERE email=$1', ['alejandro@buda.com']);
    if (u.rows.length) {
      await pool.query('DELETE FROM simulaciones WHERE usuario_id=$1', [u.rows[0].id]);
      await pool.query('DELETE FROM usuarios WHERE id=$1', [u.rows[0].id]);
    }
    await pool.query('INSERT INTO usuarios (nombre,empresa,email,password_hash) VALUES ($1,$2,$3,$4)', ['Alejandro Beltran', 'Buda.com', 'alejandro@buda.com', hash]);
    res.json({ ok: true, msg: 'alejandro@buda.com / buda2025' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
  try { await initDB(); } catch(e) { console.error('[db]', e.message); }
  await refreshFX();
  setInterval(refreshFX, 3600000);
  app.listen(PORT, () => console.log('[server] Puerto', PORT));
}
start();

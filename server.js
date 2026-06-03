'use strict';
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

app.get('/health', (req, res) => res.json({ status: 'ok', fx: fxState.source, chat: !!ANTHROPIC_API_KEY, keyLen: ANTHROPIC_API_KEY.length }));

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

app.get('/create-jaime', async (req, res) => {
  try {
    const hash = await bcrypt.hash('buda2025', 10);
    await pool.query('INSERT INTO usuarios (nombre,empresa,email,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET password_hash=$4', ['Jaime', 'Buda.com', 'jaime@buda.com', hash]);
    res.json({ ok: true, msg: 'jaime@buda.com / buda2025' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/create-jaime', async (req, res) => {
  try {
    const hash = await bcrypt.hash('buda2025', 10);
    await pool.query('INSERT INTO usuarios (nombre,empresa,email,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET password_hash=$4', ['Jaime', 'Buda.com', 'jaime@buda.com', hash]);
    res.json({ ok: true, msg: 'jaime@buda.com / buda2025' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const HTML_PAGE = "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Buda.com \u00b7 Cross-Border Payments</title>\n<link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap\" rel=\"stylesheet\">\n<style>\n*{margin:0;padding:0;box-sizing:border-box}\n:root{\n  --bg:#F9FAFB;--bg2:#FFFFFF;--bg3:#F3F4F6;\n  --blue:#1A56DB;--blue-d:#1447BB;--blue-l:#EBF5FF;--blue-border:#BFDBFE;\n  --text:#111928;--gray:#6B7280;--border:#E5E7EB;\n  --green:#057A55;--green-l:#F3FAF7;\n  --red:#E02424;\n}\nbody{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;font-size:14px;min-height:100vh}\n\n.nav{background:#fff;border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;padding:0 24px;gap:16px;position:sticky;top:0;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,.05)}\n.logo{font-size:18px;font-weight:800;color:var(--text);letter-spacing:-.5px;cursor:pointer}\n.logo span{color:var(--blue)}\n.logo-sub{font-size:10px;color:var(--gray);text-transform:uppercase;letter-spacing:.1em;margin-left:8px}\n.nav-r{margin-left:auto;display:flex;align-items:center;gap:10px}\n.rates-pill{background:var(--blue-l);border:1px solid var(--blue-border);border-radius:20px;padding:3px 10px;font-size:11px;color:var(--blue);display:flex;align-items:center;gap:5px}\n.rdot{width:6px;height:6px;border-radius:50%;background:var(--blue)}\n.user-chip{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--gray)}\n.av{width:28px;height:28px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}\n.btn-nav{padding:5px 12px;border-radius:6px;border:1px solid var(--border);background:#fff;color:var(--gray);cursor:pointer;font-size:11px;font-family:'Inter',sans-serif}\n.btn-nav:hover{border-color:var(--blue);color:var(--blue)}\n.nav-tabs{display:flex;gap:0;margin-left:16px}\n.ntab{padding:0 14px;height:56px;display:flex;align-items:center;font-size:13px;color:var(--gray);cursor:pointer;border-bottom:2px solid transparent;transition:.15s;white-space:nowrap}\n.ntab:hover{color:var(--blue)}\n.ntab.active{color:var(--blue);border-bottom-color:var(--blue);font-weight:500}\n\n.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg3)}\n.login-card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:40px;width:360px;box-shadow:0 4px 24px rgba(0,0,0,.06)}\n.login-logo{text-align:center;margin-bottom:28px}\n.llogo{font-size:28px;font-weight:900;color:var(--text);letter-spacing:-1px}\n.llogo span{color:var(--blue)}\n.lsub{font-size:12px;color:var(--gray);margin-top:4px}\n.fg{margin-bottom:12px}\n.fg label{display:block;font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;font-weight:500}\n.fi{width:100%;padding:10px 12px;border-radius:8px;border:1.5px solid var(--border);font-size:13px;color:var(--text);font-family:'Inter',sans-serif;transition:.15s;background:#fff}\n.fi:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-l)}\n.btn-p{width:100%;padding:11px;border-radius:9px;border:none;background:var(--blue);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif}\n.btn-p:hover{background:var(--blue-d)}\n\n.main{display:flex;height:calc(100vh - 56px)}\n.left{width:340px;flex-shrink:0;background:#fff;border-right:1px solid var(--border);overflow-y:auto}\n.left-inner{padding:20px}\n.info-hero{background:linear-gradient(135deg,#1A56DB,#1447BB);border-radius:14px;padding:22px;color:#fff;margin-bottom:14px}\n.ih-tag{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;opacity:.7;margin-bottom:8px}\n.ih-title{font-size:20px;font-weight:800;line-height:1.25;margin-bottom:8px}\n.ih-sub{font-size:12px;opacity:.8;line-height:1.6}\n.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}\n.metric{background:var(--bg3);border-radius:10px;padding:10px;text-align:center}\n.mv{font-size:16px;font-weight:800;color:var(--blue);font-family:monospace}\n.ml{font-size:9px;color:var(--gray);margin-top:2px;text-transform:uppercase}\n.stitle{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--gray);margin-bottom:8px}\n.corridor{background:var(--bg3);border-radius:8px;padding:9px 12px;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}\n.cname{font-size:12px;font-weight:500}\n.crate{font-size:12px;font-family:monospace;color:var(--blue);font-weight:600}\n.cbadge{font-size:9px;font-weight:600;padding:2px 7px;border-radius:20px;background:var(--green-l);color:var(--green)}\n\n.chat-panel{flex:1;display:flex;flex-direction:column;background:var(--bg)}\n.chat-header{padding:14px 20px;background:#fff;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}\n.ch-av{width:36px;height:36px;background:linear-gradient(135deg,#1A56DB,#1447BB);border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex-shrink:0}\n.ch-name{font-size:14px;font-weight:600}\n.ch-sub{font-size:11px;color:var(--gray)}\n.msgs{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px}\n.msg{display:flex;gap:10px;max-width:78%}\n.msg.user{align-self:flex-end;flex-direction:row-reverse}\n.msg.bot{align-self:flex-start}\n.msg-av{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:2px}\n.msg.bot .msg-av{background:linear-gradient(135deg,#1A56DB,#1447BB);color:#fff}\n.msg.user .msg-av{background:var(--bg3);color:var(--gray)}\n.bubble{padding:11px 15px;border-radius:14px;font-size:13px;line-height:1.6}\n.msg.bot .bubble{background:#fff;border:1px solid var(--border);border-top-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.05)}\n.msg.user .bubble{background:var(--blue);color:#fff;border-top-right-radius:4px}\n.bubble p{margin-bottom:6px}\n.bubble p:last-child{margin:0}\n.bubble strong{font-weight:600}\n.bubble li{margin-left:16px;margin-bottom:2px}\n.typing{display:flex;gap:4px;align-items:center;padding:11px 15px;background:#fff;border:1px solid var(--border);border-radius:14px;border-top-left-radius:4px}\n.typing span{width:6px;height:6px;border-radius:50%;background:var(--gray);animation:bounce .8s infinite}\n.typing span:nth-child(2){animation-delay:.15s}\n.typing span:nth-child(3){animation-delay:.3s}\n@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}\n.sugs{padding:0 20px 10px;display:flex;gap:8px;flex-wrap:wrap}\n.sug{padding:6px 12px;background:#fff;border:1px solid var(--border);border-radius:20px;font-size:12px;color:var(--gray);cursor:pointer}\n.sug:hover{border-color:var(--blue);color:var(--blue)}\n.input-wrap{padding:12px 16px;background:#fff;border-top:1px solid var(--border)}\n.input-row{display:flex;gap:8px;align-items:flex-end;background:var(--bg3);border:1.5px solid var(--border);border-radius:12px;padding:8px 8px 8px 14px;transition:.15s}\n.input-row:focus-within{border-color:var(--blue);background:#fff;box-shadow:0 0 0 3px var(--blue-l)}\n.chat-ta{flex:1;border:none;background:transparent;font-size:13px;font-family:'Inter',sans-serif;color:var(--text);resize:none;outline:none;min-height:20px;max-height:120px;line-height:1.5}\n.chat-ta::placeholder{color:var(--gray)}\n.send{width:34px;height:34px;border-radius:8px;border:none;background:var(--blue);color:#fff;cursor:pointer;flex-shrink:0;font-size:16px}\n.send:hover{background:var(--blue-d)}\n.send:disabled{background:var(--border);cursor:not-allowed}\n.hint{font-size:10px;color:var(--gray);text-align:center;margin-top:5px}\n\n.sim-wrap{flex:1;overflow-y:auto;padding:24px}\n.card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px}\n.card-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--gray);margin-bottom:14px}\n.curr-btns{display:flex;gap:6px;flex-wrap:wrap}\n.curr-btn{padding:5px 11px;border-radius:20px;border:1.5px solid var(--border);background:#fff;font-size:11px;cursor:pointer;color:var(--gray)}\n.curr-btn.active{border-color:var(--blue);background:var(--blue-l);color:var(--blue);font-weight:600}\n.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}\n.kpi{background:var(--bg3);border-radius:10px;padding:14px;text-align:center}\n.kpi.blue{background:var(--blue-l);border:1px solid var(--blue-border)}\n.kv{font-size:22px;font-weight:800;font-family:monospace}\n.kpi.blue .kv{color:var(--blue)}\n.kl{font-size:10px;color:var(--gray);margin-top:2px;text-transform:uppercase;letter-spacing:.06em}\n.annual{background:#111928;border-radius:12px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:10px}\n.btn-save{width:100%;padding:10px;border-radius:9px;border:none;background:var(--blue);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif}\n\n.hist-wrap{flex:1;overflow-y:auto;padding:24px}\n.tbl{width:100%;border-collapse:collapse;font-size:12px}\n.tbl th{text-align:left;padding:10px 14px;color:var(--gray);font-size:10px;text-transform:uppercase;border-bottom:1px solid var(--border)}\n.tbl td{padding:10px 14px;border-bottom:1px solid var(--border)}\n.tbl tr:hover td{background:var(--bg3)}\n\n.float{position:fixed;top:16px;right:16px;z-index:9999;max-width:300px;border-radius:10px;padding:12px 14px;box-shadow:0 4px 20px rgba(0,0,0,.1);animation:slideIn .25s ease;display:flex;gap:8px;align-items:flex-start}\n@keyframes slideIn{from{transform:translateX(110%)}to{transform:translateX(0)}}\n\n@media(max-width:768px){.left{display:none}}\n</style>\n</head>\n<body>\n\n<!-- LOGIN -->\n<div id=\"loginWrap\">\n  <div class=\"login-wrap\">\n    <div class=\"login-card\">\n      <div class=\"login-logo\">\n        <div class=\"llogo\">buda<span>.</span>com</div>\n        <div class=\"lsub\">Cross-Border Payments</div>\n      </div>\n      <div class=\"fg\"><label>Email</label><input class=\"fi\" type=\"email\" id=\"lEmail\" placeholder=\"tu@empresa.com\" autocomplete=\"off\"></div>\n      <div class=\"fg\"><label>Contrasena</label><input class=\"fi\" type=\"password\" id=\"lPass\" placeholder=\"&#xB7;&#xB7;&#xB7;&#xB7;&#xB7;&#xB7;&#xB7;&#xB7;\" onkeydown=\"if(event.key==='Enter')login()\"></div>\n      <button class=\"btn-p\" onclick=\"login()\">Ingresar</button>\n      <div id=\"lErr\" style=\"font-size:11px;color:var(--red);text-align:center;margin-top:10px\"></div>\n      <div style=\"text-align:center;margin-top:16px;font-size:11px;color:var(--gray)\">Sin acceso? <a href=\"mailto:otc@buda.com\" style=\"color:var(--blue)\">Contactanos</a></div>\n    </div>\n  </div>\n</div>\n\n<!-- APP -->\n<div id=\"appWrap\" style=\"display:none\">\n  <nav class=\"nav\">\n    <div class=\"logo\" onclick=\"switchView('chat')\">buda<span>.</span>com <span class=\"logo-sub\">Cross-Border</span></div>\n    <div class=\"nav-tabs\">\n      <div class=\"ntab active\" id=\"ntab-chat\" onclick=\"switchView('chat')\">Asistente</div>\n      <div class=\"ntab\" id=\"ntab-sim\" onclick=\"switchView('sim')\">Simulador</div>\n      <div class=\"ntab\" id=\"ntab-hist\" onclick=\"switchView('hist');loadHist()\">Mis simulaciones</div>\n    </div>\n    <div class=\"nav-r\">\n      <div class=\"rates-pill\"><div class=\"rdot\"></div><span id=\"rSrc\">Cargando...</span></div>\n      <div class=\"user-chip\"><div class=\"av\" id=\"uAv\">B</div><span id=\"uName\"></span></div>\n      <button class=\"btn-nav\" onclick=\"logout()\">Salir</button>\n    </div>\n  </nav>\n\n  <!-- CHAT -->\n  <div class=\"main\" id=\"vChat\">\n    <div class=\"left\">\n      <div class=\"left-inner\">\n        <div class=\"info-hero\">\n          <div class=\"ih-tag\">B2B &middot; API-first &middot; LATAM &amp; Asia</div>\n          <div class=\"ih-title\">Pagos internacionales en minutos</div>\n          <div class=\"ih-sub\">Una sola integracion para operar en 6 paises. Sin bancos corresponsales, sin dias de espera.</div>\n        </div>\n        <div class=\"metrics\">\n          <div class=\"metric\"><div class=\"mv\">&lt;5min</div><div class=\"ml\">Liquidacion</div></div>\n          <div class=\"metric\"><div class=\"mv\">1 API</div><div class=\"ml\">Integracion</div></div>\n          <div class=\"metric\"><div class=\"mv\">6</div><div class=\"ml\">Paises</div></div>\n        </div>\n        <div class=\"stitle\">Tasas en tiempo real</div>\n        <div id=\"corridorRates\"></div>\n        <div style=\"font-size:10px;color:var(--gray);text-align:center;margin-top:6px\" id=\"rTime\"></div>\n      </div>\n    </div>\n    <div class=\"chat-panel\">\n      <div class=\"chat-header\">\n        <div class=\"ch-av\">B</div>\n        <div>\n          <div class=\"ch-name\">Asistente Buda Cross-Border</div>\n          <div class=\"ch-sub\">Tasas en tiempo real &middot; Simulaciones &middot; Consultas sobre el servicio</div>\n        </div>\n        <div style=\"margin-left:auto\"><button class=\"btn-nav\" onclick=\"clearChat()\">Nueva conversacion</button></div>\n      </div>\n      <div class=\"msgs\" id=\"msgs\"></div>\n      <div class=\"sugs\" id=\"sugs\"></div>\n      <div class=\"input-wrap\">\n        <div class=\"input-row\">\n          <textarea class=\"chat-ta\" id=\"chatInput\" placeholder=\"Pregunta sobre tasas, simula tu negocio...\" rows=\"1\"\n            onkeydown=\"if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg()}\"\n            oninput=\"this.style.height='auto';this.style.height=this.scrollHeight+'px'\"></textarea>\n          <button class=\"send\" id=\"sendBtn\" onclick=\"sendMsg()\">&#8593;</button>\n        </div>\n        <div class=\"hint\">Shift+Enter para nueva linea &middot; Enter para enviar</div>\n      </div>\n    </div>\n  </div>\n\n  <!-- SIMULATOR -->\n  <div style=\"display:none\" id=\"vSim\">\n    <div class=\"sim-wrap\">\n      <div style=\"font-size:20px;font-weight:700;margin-bottom:4px\">Simulador de negocio</div>\n      <div style=\"font-size:13px;color:var(--gray);margin-bottom:20px\">Proyecta tu volumen mensual y anual en cualquier corredor</div>\n      <div class=\"card\">\n        <div class=\"card-title\">Corredor</div>\n        <div style=\"display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin-bottom:12px\">\n          <div>\n            <div style=\"font-size:11px;color:var(--gray);margin-bottom:6px\">Moneda origen</div>\n            <div class=\"curr-btns\" id=\"origSel\"></div>\n          </div>\n          <div style=\"font-size:20px;color:var(--gray);margin-top:14px\">&#8594;</div>\n          <div>\n            <div style=\"font-size:11px;color:var(--gray);margin-bottom:6px\">Moneda destino</div>\n            <div class=\"curr-btns\" id=\"destSel\"></div>\n          </div>\n        </div>\n        <div id=\"tasaBanner\" style=\"display:none;background:var(--blue-l);border:1px solid var(--blue-border);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--blue);font-family:monospace\"></div>\n      </div>\n      <div class=\"card\">\n        <div class=\"card-title\">Parametros del negocio</div>\n        <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px\">\n          <div class=\"fg\" style=\"margin:0\"><label>Ticket promedio (origen)</label><input class=\"fi\" type=\"number\" id=\"sTicket\" placeholder=\"5000000\" oninput=\"calcSim()\"></div>\n          <div class=\"fg\" style=\"margin:0\"><label>Operaciones por dia</label><input class=\"fi\" type=\"number\" id=\"sOpsDay\" placeholder=\"10\" oninput=\"calcSim()\"></div>\n          <div class=\"fg\" style=\"margin:0\"><label>Dias operativos al mes</label><input class=\"fi\" type=\"number\" id=\"sDays\" placeholder=\"22\" oninput=\"calcSim()\"></div>\n          <div class=\"fg\" style=\"margin:0\"><label>Tu margen (%)</label><input class=\"fi\" type=\"number\" id=\"sMargen\" placeholder=\"1.5\" step=\"0.1\" oninput=\"calcSim()\"></div>\n        </div>\n        <div class=\"fg\" style=\"margin-top:10px;margin-bottom:0\"><label>Notas</label><input class=\"fi\" type=\"text\" id=\"sNotas\" placeholder=\"Ej: remesas Colombia-Chile\"></div>\n      </div>\n      <div id=\"simResult\">\n        <div style=\"background:#fff;border:1px solid var(--border);border-radius:14px;padding:40px;text-align:center;color:var(--gray)\">\n          <div style=\"font-size:32px;margin-bottom:8px\">&#128202;</div>\n          <div>Completa los parametros para ver la proyeccion</div>\n        </div>\n      </div>\n    </div>\n  </div>\n\n  <!-- HISTORY -->\n  <div style=\"display:none;padding:24px\" id=\"vHist\">\n    <div style=\"font-size:20px;font-weight:700;margin-bottom:16px\">Mis simulaciones</div>\n    <div style=\"background:#fff;border:1px solid var(--border);border-radius:12px;overflow:hidden\">\n      <table class=\"tbl\">\n        <thead><tr>\n          <th>Par</th><th>Tasa ref.</th><th>Margen</th><th>Volumen/mes</th><th>Ganancia proy.</th><th>Fecha</th>\n        </tr></thead>\n        <tbody id=\"histBody\"></tbody>\n      </table>\n    </div>\n  </div>\n</div>\n\n<script>\nvar BASE = '';\nvar TOKEN = localStorage.getItem('budaToken');\nvar USER = JSON.parse(localStorage.getItem('budaUser') || 'null');\nvar fx = {};\nvar orig = 'COP', dest = 'CLP';\nvar chatLog = [];\nvar busy = false;\n\nvar CURR = {\n  COP: {flag: 'CO', name: 'Peso Colombiano', sym: '$'},\n  CLP: {flag: 'CL', name: 'Peso Chileno', sym: '$'},\n  PEN: {flag: 'PE', name: 'Sol Peruano', sym: 'S/'},\n  BOB: {flag: 'BO', name: 'Boliviano', sym: 'Bs.'},\n  VES: {flag: 'VE', name: 'Bolivar', sym: 'Bs.'},\n  CNY: {flag: 'CN', name: 'Yuan Chino', sym: 'CNY'},\n  USD: {flag: 'US', name: 'Dolar USD', sym: '$'}\n};\nvar ACTIVE = ['COP','CLP','PEN','BOB','VES','CNY'];\n\nvar SUGS = [\n  'Cuanto es 50 millones de COP en CLP hoy?',\n  'Simula 20 ops/dia de USD 10.000 con margen 1.5%',\n  'Cuales son los corredores activos?',\n  'Como funciona la integracion API?',\n  'Cuanto gano al ano con 100 ops diarias de COP 5M?'\n];\n\nfunction fmt(n, d) {\n  if (n === null || n === undefined) return '--';\n  d = d !== undefined ? d : 2;\n  return parseFloat(n).toLocaleString('es-CO', {minimumFractionDigits: d, maximumFractionDigits: d});\n}\n\nasync function api(m, u, b) {\n  var h = {'Content-Type': 'application/json'};\n  if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;\n  var r = await fetch(BASE + u, {method: m, headers: h, body: b ? JSON.stringify(b) : undefined});\n  if (r.status === 401 && u !== '/auth/login') { logout(); return {}; }\n  return r.json();\n}\n\nasync function login() {\n  var email = document.getElementById('lEmail').value.trim();\n  var pass = document.getElementById('lPass').value;\n  var d = await api('POST', '/auth/login', {email: email, password: pass});\n  if (d.error) { document.getElementById('lErr').textContent = d.error; return; }\n  TOKEN = d.token; USER = d.user;\n  localStorage.setItem('budaToken', TOKEN);\n  localStorage.setItem('budaUser', JSON.stringify(USER));\n  showApp();\n}\n\nfunction logout() {\n  TOKEN = null; USER = null;\n  localStorage.removeItem('budaToken'); localStorage.removeItem('budaUser');\n  document.getElementById('appWrap').style.display = 'none';\n  document.getElementById('loginWrap').style.display = 'block';\n}\n\nfunction showApp() {\n  document.getElementById('loginWrap').style.display = 'none';\n  document.getElementById('appWrap').style.display = 'block';\n  if (USER) {\n    document.getElementById('uName').textContent = USER.nombre;\n    var av = USER.nombre.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();\n    document.getElementById('uAv').textContent = av;\n  }\n  buildSelectors();\n  loadRates();\n  setInterval(loadRates, 3600000);\n  welcome();\n  renderSugs();\n}\n\nfunction switchView(v) {\n  document.getElementById('vChat').style.display = v === 'chat' ? 'flex' : 'none';\n  document.getElementById('vSim').style.display = v === 'sim' ? 'block' : 'none';\n  document.getElementById('vHist').style.display = v === 'hist' ? 'block' : 'none';\n  ['chat','sim','hist'].forEach(function(x) {\n    var t = document.getElementById('ntab-' + x);\n    if (t) t.classList.toggle('active', x === v);\n  });\n  if (v === 'sim') { buildSelectors(); calcSim(); }\n}\n\nasync function loadRates() {\n  var d = await api('GET', '/api/rates');\n  if (!d.rates) return;\n  fx = d;\n  document.getElementById('rSrc').textContent = d.source === 'api' ? 'Tiempo real' : 'Tasas ref.';\n  var t = new Date(d.updatedAt);\n  var el = document.getElementById('rTime');\n  if (el) el.textContent = 'Act. ' + t.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit'});\n  renderCorridors(d.rates);\n  calcSim();\n}\n\nfunction renderCorridors(rates) {\n  var pairs = [['COP','CLP'],['COP','PEN'],['COP','BOB'],['COP','VES'],['COP','CNY'],['USD','COP']];\n  var el = document.getElementById('corridorRates');\n  if (!el) return;\n  var html = '';\n  pairs.forEach(function(p) {\n    var r = (rates[p[1]] || 1) / (rates[p[0]] || 1);\n    var dec = r < 10 ? 4 : 2;\n    html += '<div class=\"corridor\">' +\n      '<span class=\"cname\">' + p[0] + ' &#8594; ' + p[1] + '</span>' +\n      '<div style=\"display:flex;align-items:center;gap:8px\">' +\n        '<span class=\"crate\">' + fmt(r, dec) + '</span>' +\n        '<span class=\"cbadge\">Activo</span>' +\n      '</div></div>';\n  });\n  el.innerHTML = html;\n}\n\nfunction buildSelectors() {\n  var keys = ACTIVE.concat(['USD']);\n  var o = document.getElementById('origSel');\n  var d = document.getElementById('destSel');\n  if (!o || !d) return;\n  var ho = '', hd = '';\n  keys.forEach(function(c) {\n    ho += '<button class=\"curr-btn' + (c === orig ? ' active' : '') + '\" onclick=\"setOrig(\\'' + c + '\\')\">' + c + '</button>';\n    hd += '<button class=\"curr-btn' + (c === dest ? ' active' : '') + '\" onclick=\"setDest(\\'' + c + '\\')\">' + c + '</button>';\n  });\n  o.innerHTML = ho;\n  d.innerHTML = hd;\n}\n\nfunction setOrig(c) { orig = c; buildSelectors(); calcSim(); }\nfunction setDest(c) { dest = c; buildSelectors(); calcSim(); }\n\nfunction welcome() {\n  var name = USER ? USER.nombre.split(' ')[0] : 'bienvenido';\n  var txt = 'Hola, ' + name + '! Soy el asistente de Buda Cross-Border Payments. Puedo ayudarte con:\\n\\n' +\n    '- Consultar tasas de cambio en tiempo real\\n' +\n    '- Simular tu modelo de negocio y proyectar ingresos\\n' +\n    '- Responder preguntas sobre el servicio y la API\\n\\n' +\n    'En que puedo ayudarte hoy?';\n  addBot(txt);\n}\n\nfunction renderSugs() {\n  var el = document.getElementById('sugs');\n  if (!el) return;\n  var html = '';\n  SUGS.forEach(function(s) {\n    html += '<button class=\"sug\" onclick=\"useSug(this.textContent)\">' + s + '</button>';\n  });\n  el.innerHTML = html;\n}\n\nfunction useSug(s) {\n  document.getElementById('chatInput').value = s;\n  sendMsg();\n}\n\nfunction clearChat() {\n  chatLog = [];\n  document.getElementById('msgs').innerHTML = '';\n  welcome();\n  renderSugs();\n}\n\nfunction addBot(text) {\n  var el = document.getElementById('msgs');\n  var div = document.createElement('div');\n  div.className = 'msg bot';\n  var av = document.createElement('div');\n  av.className = 'msg-av';\n  av.textContent = 'B';\n  var bub = document.createElement('div');\n  bub.className = 'bubble';\n  bub.innerHTML = md(text);\n  div.appendChild(av);\n  div.appendChild(bub);\n  el.appendChild(div);\n  el.scrollTop = el.scrollHeight;\n  var sugs = document.getElementById('sugs');\n  if (chatLog.length > 0 && sugs) sugs.style.display = 'none';\n}\n\nfunction addUser(text) {\n  var el = document.getElementById('msgs');\n  var div = document.createElement('div');\n  div.className = 'msg user';\n  var av = document.createElement('div');\n  av.className = 'msg-av';\n  av.textContent = USER && USER.nombre ? USER.nombre[0].toUpperCase() : 'U';\n  var bub = document.createElement('div');\n  bub.className = 'bubble';\n  bub.textContent = text;\n  div.appendChild(av);\n  div.appendChild(bub);\n  el.appendChild(div);\n  el.scrollTop = el.scrollHeight;\n}\n\nfunction showTyping() {\n  var el = document.getElementById('msgs');\n  var div = document.createElement('div');\n  div.className = 'msg bot'; div.id = 'typing';\n  var av = document.createElement('div');\n  av.className = 'msg-av'; av.textContent = 'B';\n  var t = document.createElement('div');\n  t.className = 'typing';\n  t.innerHTML = '<span></span><span></span><span></span>';\n  div.appendChild(av); div.appendChild(t);\n  el.appendChild(div);\n  el.scrollTop = el.scrollHeight;\n}\n\nfunction hideTyping() {\n  var el = document.getElementById('typing');\n  if (el) el.remove();\n}\n\nasync function sendMsg() {\n  if (busy) return;\n  var input = document.getElementById('chatInput');\n  var text = input.value.trim();\n  if (!text) return;\n  input.value = '';\n  input.style.height = 'auto';\n  addUser(text);\n  chatLog.push({role:'user', content: text});\n  busy = true;\n  document.getElementById('sendBtn').disabled = true;\n  var sugs = document.getElementById('sugs');\n  if (sugs) sugs.style.display = 'none';\n  showTyping();\n  try {\n    var d = await api('POST', '/api/chat', {messages: chatLog});\n    hideTyping();\n    if (d.error) { addBot('Error: ' + d.error); }\n    else { chatLog.push({role:'assistant', content: d.response}); addBot(d.response); }\n  } catch(e) {\n    hideTyping();\n    addBot('Error de conexion. Intenta de nuevo.');\n  }\n  busy = false;\n  document.getElementById('sendBtn').disabled = false;\n  input.focus();\n}\n\nfunction md(text) {\n  var t = text\n    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')\n    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')\n    .replace(/\\*([^*]+)\\*/g,'<em>$1</em>');\n  var parts = t.split('\\n\\n');\n  var out = parts.map(function(p) {\n    var lines = p.split('\\n');\n    var hasListItem = lines.some(function(l){ return /^[-*]/.test(l.trim()); });\n    if (hasListItem) {\n      var items = lines.map(function(l){\n        if (/^[-*]/.test(l.trim())) return '<li>' + l.trim().replace(/^[-*]\\s*/,'') + '</li>';\n        return l;\n      });\n      return '<ul>' + items.join('') + '</ul>';\n    }\n    return '<p>' + lines.join('<br>') + '</p>';\n  });\n  return out.join('');\n}\n\nfunction calcSim() {\n  if (!fx.rates) return;\n  var ticket = parseFloat(document.getElementById('sTicket') && document.getElementById('sTicket').value) || 0;\n  var opsDay = parseFloat(document.getElementById('sOpsDay') && document.getElementById('sOpsDay').value) || 0;\n  var days = parseFloat(document.getElementById('sDays') && document.getElementById('sDays').value) || 22;\n  var margen = parseFloat(document.getElementById('sMargen') && document.getElementById('sMargen').value) || 0;\n  var rO = fx.rates[orig] || 1;\n  var rD = fx.rates[dest] || 1;\n  var tasaRef = rD / rO;\n  var tasaCli = tasaRef * (1 + margen / 100);\n  var dec = tasaRef < 10 ? 4 : 2;\n  var cO = CURR[orig] ? CURR[orig].sym : '$';\n  var cD = CURR[dest] ? CURR[dest].sym : '$';\n  var banner = document.getElementById('tasaBanner');\n  if (banner && tasaRef > 0) {\n    banner.style.display = 'block';\n    banner.textContent = '1 ' + orig + ' = ' + cD + ' ' + fmt(tasaRef, dec) + ' (ref.) | Tu tasa: ' + cD + ' ' + fmt(tasaCli, dec) + ' (+' + margen + '%)';\n  }\n  if (!ticket || !opsDay || !margen) {\n    document.getElementById('simResult').innerHTML = '<div style=\"background:#fff;border:1px solid var(--border);border-radius:14px;padding:40px;text-align:center;color:var(--gray)\"><div style=\"font-size:32px;margin-bottom:8px\">&#128202;</div><div>Completa los parametros para ver la proyeccion</div></div>';\n    return;\n  }\n  var ops = Math.round(opsDay * days);\n  var vol = ticket * ops;\n  var volD = vol * tasaCli;\n  var marg = vol * (margen / 100);\n  var margD = marg * tasaCli;\n  var year = marg * 12;\n  var yearD = margD * 12;\n  document.getElementById('simResult').innerHTML =\n    '<div class=\"kpi-grid\">' +\n      '<div class=\"kpi\"><div class=\"kv\">' + ops.toLocaleString('es-CO') + '</div><div class=\"kl\">Ops / mes</div></div>' +\n      '<div class=\"kpi\"><div class=\"kv\">' + cO + ' ' + fmt(vol) + '</div><div class=\"kl\">Volumen / mes</div></div>' +\n      '<div class=\"kpi blue\"><div class=\"kv\">' + cO + ' ' + fmt(marg) + '</div><div class=\"kl\">Tu margen / mes</div></div>' +\n    '</div>' +\n    '<div class=\"annual\">' +\n      '<div><div style=\"font-size:11px;color:rgba(255,255,255,.5);margin-bottom:4px\">Proyeccion anual</div>' +\n        '<div style=\"font-size:26px;font-weight:800;color:#fff;font-family:monospace\">' + cO + ' ' + fmt(year) + '</div>' +\n        '<div style=\"font-size:11px;color:rgba(255,255,255,.4)\">' + cD + ' ' + fmt(yearD) + ' a ' + margen + '% margen</div>' +\n      '</div>' +\n      '<div style=\"text-align:right\"><div style=\"font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px\">Corredor</div>' +\n        '<div style=\"font-size:16px;font-weight:700;color:#fff;font-family:monospace\">' + orig + ' &#8594; ' + dest + '</div>' +\n      '</div>' +\n    '</div>' +\n    '<div style=\"background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px;font-size:11px;color:var(--gray);font-family:monospace;line-height:2;margin-bottom:12px\">' +\n      'Tasa ref: ' + fmt(tasaRef, dec) + ' | Tu tasa: ' + fmt(tasaCli, dec) + ' | Ticket: ' + cO + ' ' + fmt(ticket) + ' | ' + opsDay + ' ops/dia x ' + days + ' dias = ' + ops + ' ops/mes' +\n    '</div>' +\n    '<button class=\"btn-save\" onclick=\"guardar()\">Guardar simulacion</button>';\n}\n\nasync function guardar() {\n  var ticket = parseFloat(document.getElementById('sTicket').value) || 0;\n  var opsDay = parseFloat(document.getElementById('sOpsDay').value) || 0;\n  var days = parseFloat(document.getElementById('sDays').value) || 22;\n  var margen = parseFloat(document.getElementById('sMargen').value) || 0;\n  var notas = document.getElementById('sNotas').value;\n  if (!ticket || !opsDay || !margen) { alert('Completa todos los campos'); return; }\n  var ops = Math.round(opsDay * days);\n  var d = await api('POST', '/api/simular', {moneda_origen: orig, moneda_destino: dest, margen_pct: margen, ticket_promedio: ticket, num_operaciones: ops, notas: notas});\n  if (d.error) { alert('Error: ' + d.error); return; }\n  var cO = CURR[orig] ? CURR[orig].sym : '$';\n  floatMsg('Simulacion guardada', 'Margen mensual: ' + cO + ' ' + fmt(d.ganancia_proyectada));\n}\n\nasync function loadHist() {\n  var d = await api('GET', '/api/mis-simulaciones');\n  var rows = d.simulaciones || [];\n  document.getElementById('histBody').innerHTML = rows.length ? rows.map(function(r) {\n    return '<tr>' +\n      '<td><span style=\"background:var(--blue-l);color:var(--blue);padding:2px 8px;border-radius:20px;font-size:11px;font-family:monospace\">' + r.par + '</span></td>' +\n      '<td style=\"font-family:monospace\">' + fmt(r.tasa_referencia, 4) + '</td>' +\n      '<td>' + fmt(r.margen_pct, 2) + '%</td>' +\n      '<td style=\"font-family:monospace\">' + fmt(r.volumen_total) + '</td>' +\n      '<td style=\"font-family:monospace;color:var(--green);font-weight:600\">' + fmt(r.ganancia_proyectada) + '</td>' +\n      '<td style=\"color:var(--gray);font-size:11px\">' + new Date(r.created_at).toLocaleString('es-CO', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'}) + '</td>' +\n    '</tr>';\n  }).join('') : '<tr><td colspan=\"6\" style=\"text-align:center;padding:32px;color:var(--gray)\">Sin simulaciones guardadas</td></tr>';\n}\n\nfunction floatMsg(title, body) {\n  var el = document.createElement('div');\n  el.className = 'float';\n  el.style.background = 'var(--blue-l)';\n  el.style.border = '1px solid var(--blue-border)';\n  el.innerHTML = '<span style=\"font-size:18px\">&#9989;</span><div style=\"flex:1\"><div style=\"font-size:12px;font-weight:500;color:var(--blue)\">' + title + '</div><div style=\"font-size:10px;color:#888;margin-top:2px\">' + body + '</div></div><button onclick=\"this.parentElement.remove()\" style=\"background:none;border:none;cursor:pointer;color:#aaa;font-size:16px\">x</button>';\n  document.body.appendChild(el);\n  setTimeout(function() { if (el.parentNode) { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(function(){ el.remove(); }, 300); } }, 5000);\n}\n\nif (TOKEN) {\n  USER = JSON.parse(localStorage.getItem('budaUser') || 'null');\n  showApp();\n} else {\n  document.getElementById('loginWrap').style.display = 'block';\n}\n</script>\n</body>\n</html>\n";

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_PAGE);
});

async function start() {
  console.log('[config] ANTHROPIC_API_KEY:', ANTHROPIC_API_KEY ? 'SET (len=' + ANTHROPIC_API_KEY.length + ')' : 'NOT SET');
  try { await initDB(); } catch(e) { console.error('[db]', e.message); }
  await refreshFX();
  setInterval(refreshFX, 3600000);
  app.listen(PORT, () => console.log('[server] Puerto', PORT));
}
start();

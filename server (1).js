/* MatrixEdu · servidor da escola
   Uso: node server.js (ou dois cliques em iniciar.bat no Windows)
   Sem instalar nada além do Node.js. Os dados ficam em dados.json.
   No Render: crie um Disk e defina a variável DATA_DIR (ex.: /var/data) para os dados não se perderem. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || DIR;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const DATA_FILE = path.join(DATA_DIR, 'dados.json');
const ONLINE_MS = 20000; // aluno some da lista se ficar 20 s sem sinal
const USERS_KEY = 'matrixedu_users_v2';

let db = { keys: {}, overrides: {} }; // keys = dados compartilhados; overrides = bloqueio/liberação manual por aluno
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
const students = {}; // presença em memória: email -> {nome, last, online}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(db), err => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
    backupDiario();
  }, 300);
}


/* Backup: uma cópia por dia em DATA_DIR/backups, guarda as últimas 14 */
function backupDiario() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'dados-' + new Date().toISOString().slice(0, 10) + '.json');
    if (fs.existsSync(f)) return;
    fs.writeFileSync(f, JSON.stringify(db));
    fs.readdirSync(dir).sort().slice(0, -14).forEach(x => fs.unlinkSync(path.join(dir, x)));
  } catch (e) {}
}

/* Contas: senha nunca fica em texto puro nem sai do servidor */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'mariahildaornelasdeoliveira@gmail.com').toLowerCase();
/* Senha padrão do administrador: só é aplicada se a variável ADMIN_SENHA não for definida no Render */
const ADMIN_SENHA_PADRAO = process.env.ADMIN_SENHA || 'MATRIXEDU@2026';
function hashar(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(senha), salt, 64).toString('hex') };
}
function confere(u, senha) {
  if (!u || !u.hash || !u.salt) return false;
  const h = crypto.scryptSync(String(senha), u.salt, 64), o = Buffer.from(u.hash, 'hex');
  return o.length === h.length && crypto.timingSafeEqual(o, h);
}
function lerUsers() { try { return JSON.parse(db.keys[USERS_KEY] || '{}'); } catch (e) { return {}; } }
function mesclar(atual, novo) {
  const out = Object.assign({}, atual);
  Object.keys(novo).forEach(k => {
    const n = novo[k]; if (!n || typeof n !== 'object') return;
    const a = atual[k], e = Object.assign({}, n);
    if (a) { // conta existente: papel e senha não mudam por aqui
      e.role = a.role; e.hash = a.hash; e.salt = a.salt;
      if (!a.hash && typeof n.senha === 'string') Object.assign(e, hashar(n.senha));
    } else { // conta nova: só professor ou aluno
      e.role = n.role === 'aluno' ? 'aluno' : 'professor';
      if (typeof n.senha === 'string') Object.assign(e, hashar(n.senha)); else { delete e.hash; delete e.salt; }
    }
    delete e.senha; out[k] = e;
  });
  return out;
}
function keysPublicas() {
  const us = lerUsers(), pub = {};
  Object.keys(us).forEach(k => { const c = Object.assign({}, us[k]); delete c.hash; delete c.salt; delete c.senha; pub[k] = c; });
  return Object.assign({}, db.keys, { [USERS_KEY]: JSON.stringify(pub) });
}
(function migrar() { // converte contas antigas (senha em texto) e garante um administrador
  const us = lerUsers(); let mudou = false;
  Object.keys(us).forEach(k => {
    if (us[k] && typeof us[k].senha === 'string') { Object.assign(us[k], hashar(us[k].senha)); delete us[k].senha; mudou = true; }
  });
  if (us[ADMIN_EMAIL] && !confere(us[ADMIN_EMAIL], ADMIN_SENHA_PADRAO)) { // trocar a senha do admin: mude ADMIN_SENHA_PADRAO acima ou defina ADMIN_SENHA no Render
    Object.assign(us[ADMIN_EMAIL], hashar(ADMIN_SENHA_PADRAO), { role: 'admin' }); mudou = true;
  }
  if (!Object.keys(us).some(k => us[k] && us[k].role === 'admin' && us[k].hash)) {
    us[ADMIN_EMAIL] = Object.assign({ nome: 'Administrador', licenca: 'liberada' }, us[ADMIN_EMAIL] || {}, hashar(ADMIN_SENHA_PADRAO), { role: 'admin' });
    mudou = true;
  }
  if (mudou) { db.keys[USERS_KEY] = JSON.stringify(us); save(); }
})();
const tentativas = {}; // trava o login após 5 erros por 15 min

function studentsView() {
  const now = Date.now(), out = {};
  Object.keys(students).forEach(email => {
    const s = students[email];
    out[email] = { nome: s.nome, on: !!s.online && (now - s.last) < ONLINE_MS };
  });
  Object.keys(db.overrides).forEach(email => {
    if (!out[email]) out[email] = { nome: (students[email] && students[email].nome) || '', on: false };
    out[email].override = db.overrides[email];
  });
  return out;
}

function send(req, res, code, body, type, extra) {
  const txt = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {});
  const comprimivel = /json|text|javascript|svg|html|css/.test(headers['Content-Type']);
  if (comprimivel && txt.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
    res.writeHead(code, headers); return res.end(zlib.gzipSync(txt));
  }
  res.writeHead(code, headers); res.end(txt);
}

function readBody(req, cb) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 20e6) req.destroy(); });
  req.on('end', () => { let j = {}; try { j = JSON.parse(raw || '{}'); } catch (e) {} cb(j); });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/api/state') return send(req, res, 200, { keys: keysPublicas(), students: studentsView() });

  if (req.method === 'POST' && url.startsWith('/api/')) {
    return readBody(req, b => {
      if (url === '/api/login') {
        const k = String(b.email || '').trim().toLowerCase(), t = tentativas[k] || { n: 0, ate: 0 };
        if (t.ate > Date.now()) return send(req, res, 429, { ok: false, erro: 'bloqueado' });
        const ok = confere(lerUsers()[k], b.senha);
        if (ok) delete tentativas[k]; else { t.n++; if (t.n >= 5) { t.ate = Date.now() + 15 * 60000; t.n = 0; } tentativas[k] = t; }
        return send(req, res, 200, { ok });
      }
      if (url === '/api/trocasenha') {
        const k = String(b.email || '').trim().toLowerCase(), us = lerUsers(), t = tentativas[k] || { n: 0, ate: 0 };
        if (t.ate > Date.now() || !us[k] || typeof b.nova !== 'string' || b.nova.length < 4) return send(req, res, 200, { ok: false });
        if (!confere(us[k], b.atual)) { t.n++; if (t.n >= 5) { t.ate = Date.now() + 15 * 60000; t.n = 0; } tentativas[k] = t; return send(req, res, 200, { ok: false }); }
        Object.assign(us[k], hashar(b.nova)); db.keys[USERS_KEY] = JSON.stringify(us); save();
        return send(req, res, 200, { ok: true });
      }
      if (url === '/api/set' && typeof b.key === 'string' && typeof b.value === 'string') {
        if (b.key === USERS_KEY) { // contas: junta com as que já existem, assim ninguém apaga a conta do outro
          try { b.value = JSON.stringify(mesclar(lerUsers(), JSON.parse(b.value))); } catch (e) { return send(req, res, 400, { ok: false }); }
        }
        db.keys[b.key] = b.value; save();
      } else if (url === '/api/resetusers') { // apaga todas as contas, menos as de administrador
        try {
          const atual = JSON.parse(db.keys[USERS_KEY] || '{}'), keep = {};
          Object.keys(atual).forEach(k => { if (atual[k] && atual[k].role === 'admin') keep[k] = atual[k]; });
          db.keys[USERS_KEY] = JSON.stringify(keep);
        } catch (e) {}
        db.overrides = {};
        Object.keys(students).forEach(k => delete students[k]);
        save();
      } else if (url === '/api/beat' && b.email) {
        students[b.email] = { nome: b.nome || (students[b.email] && students[b.email].nome) || '', last: Date.now(), online: true };
      } else if (url === '/api/offline' && b.email) {
        if (students[b.email]) students[b.email].online = false;
      } else if (url === '/api/override' && b.email) {
        if (b.v === 'auto') delete db.overrides[b.email]; else if (b.v === 'on' || b.v === 'off') db.overrides[b.email] = b.v;
        save();
      }
      send(req, res, 200, { ok: true });
    });
  }

  if (req.method === 'GET') { // arquivos do site (index.html etc.)
    let rel = decodeURIComponent(url === '/' ? '/index.html' : url);
    const file = path.normalize(path.join(DIR, rel));
    const base = path.basename(file);
    if (!file.startsWith(DIR) || base.startsWith('dados') || base === 'server.js' || file.includes(path.sep + 'backups' + path.sep)) return send(req, res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
    return fs.readFile(file, (err, buf) => {
      if (err) return send(req, res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
      send(req, res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    });
  }
  send(req, res, 405, 'Método não permitido', 'text/plain; charset=utf-8');
}).listen(PORT, '0.0.0.0', () => {
  console.log('\n MatrixEdu rodando!\n');
  console.log(' Neste computador: http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(n => nets[n].forEach(i => {
    if (i.family === 'IPv4' && !i.internal) console.log(' Nos outros computadores da escola: http://' + i.address + ':' + PORT);
  }));
  console.log('\n Deixe esta janela aberta. Para parar: Ctrl + C\n');
});

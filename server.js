/* MatrixEdu · servidor da escola
   Uso: node server.js (ou dois cliques em iniciar.bat no Windows)
   Sem instalar nada além do Node.js. Os dados ficam em dados.json.
   No Render: crie um Disk e defina a variável DATA_DIR (ex.: /var/data) para os dados não se perderem.
   Senha padrão do administrador: ADMIN_SENHA_PADRAO abaixo. Para usar outra, defina ADMIN_SENHA no Render. */
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
const PROIBIDAS = ['__proto__', 'constructor', 'prototype'];
const SENHA_MIN = 6;

let db = { keys: {}, overrides: {} }; // keys = dados compartilhados; overrides = bloqueio/liberação manual por aluno
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
if (!db.keys || typeof db.keys !== 'object') db.keys = {};
if (!db.overrides || typeof db.overrides !== 'object') db.overrides = {};
const students = Object.create(null); // presença em memória: email -> {nome, last, online}

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

/* Validações simples */
function emailOk(k) { return typeof k === 'string' && k.length > 0 && k.length <= 254 && k === k.toLowerCase() && !PROIBIDAS.includes(k); }
function chaveOk(k) { return typeof k === 'string' && k.length > 0 && k.length <= 200 && !PROIBIDAS.includes(k); }
function tem(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/* Limites por IP / chave (em memória) */
const limites = Object.create(null);
function estourou(chave, max, janelaMs) {
  const agora = Date.now(), l = limites[chave];
  if (!l || l.ate < agora) { limites[chave] = { n: 1, ate: agora + janelaMs }; return false; }
  l.n++; return l.n > max;
}
function ipDe(req) { // no Render o IP real vem em x-forwarded-for
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '?';
}

/* Contas: senha nunca fica em texto puro nem sai do servidor */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'mariahildaornelasdeoliveira@gmail.com').toLowerCase();
/* Senha padrão do administrador: é reaplicada a cada início do servidor (como na versão original).
   Para usar outra senha, defina ADMIN_SENHA no Render (ela tem prioridade). */
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
const DUMMY = hashar('dummy'); // gasta o mesmo tempo quando o e-mail não existe
function lerUsers() { try { const u = JSON.parse(db.keys[USERS_KEY] || '{}'); return u && typeof u === 'object' ? u : {}; } catch (e) { return {}; } }

/* Junta as contas enviadas com as existentes.
   - Sem login: só pode CRIAR conta nova (professor/aluno, nunca já liberada).
   - Logado: pode editar só a própria conta (sem mexer em papel, senha ou licença).
   - Administrador: edita qualquer conta (papel e senha continuam protegidos). */
function mesclar(atual, novo, viewer, ip) {
  const admin = !!viewer && viewer.role === 'admin';
  const out = Object.assign({}, atual);
  let criados = 0;
  Object.keys(novo).forEach(k => {
    if (!emailOk(k)) return;
    const n = novo[k]; if (!n || typeof n !== 'object' || Array.isArray(n)) return;
    const a = tem(atual, k) ? atual[k] : null, e = Object.assign({}, n);
    if (a) { // conta existente: papel e senha não mudam por aqui
      if (!admin && !(viewer && viewer.email === k)) return; // ninguém mexe na conta dos outros
      e.role = a.role; e.hash = a.hash; e.salt = a.salt;
      if (!admin) e.licenca = a.licenca; // só o administrador libera/bloqueia licença
      if (!a.hash && typeof n.senha === 'string') Object.assign(e, hashar(n.senha));
    } else { // conta nova: só professor ou aluno
      if (!admin) {
        if (criados >= 1) return; // 1 conta nova por pedido
        if (estourou('cadastro:' + ip, 10, 60 * 60000)) return; // no máx. 10 contas novas por hora por IP
      }
      criados++;
      e.role = n.role === 'aluno' ? 'aluno' : 'professor';
      if (!admin && e.licenca === 'liberada') e.licenca = 'pendente'; // conta nova nunca nasce liberada
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
  if (tem(us, ADMIN_EMAIL) && !confere(us[ADMIN_EMAIL], ADMIN_SENHA_PADRAO)) { // trocar a senha do admin: mude ADMIN_SENHA_PADRAO acima ou defina ADMIN_SENHA no Render
    Object.assign(us[ADMIN_EMAIL], hashar(ADMIN_SENHA_PADRAO), { role: 'admin' }); mudou = true;
  }
  if (!Object.keys(us).some(k => us[k] && us[k].role === 'admin' && us[k].hash)) {
    us[ADMIN_EMAIL] = Object.assign({ nome: 'Administrador', licenca: 'liberada' }, us[ADMIN_EMAIL] || {}, hashar(ADMIN_SENHA_PADRAO), { role: 'admin' });
    mudou = true;
  }
  if (mudou) { db.keys[USERS_KEY] = JSON.stringify(us); save(); }
})();

const tentativas = Object.create(null); // trava o login após 5 erros por 15 min
const sessoes = Object.create(null); // token -> {email, ate} — sessão em memória, válida por 12h
const SESSAO_MS = 12 * 60 * 60 * 1000;
function criarSessao(email) {
  const token = crypto.randomBytes(24).toString('hex');
  sessoes[token] = { email, ate: Date.now() + SESSAO_MS };
  return token;
}
function tokenDoPedido(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers['authorization'] || '');
  return m ? m[1] : null;
}
function viewerDoPedido(req) {
  const token = tokenDoPedido(req);
  if (!token) return null;
  const s = sessoes[token];
  if (!s || s.ate < Date.now()) { delete sessoes[token]; return null; }
  const us = lerUsers(), u = tem(us, s.email) ? us[s.email] : null;
  if (!u) return null;
  return { email: s.email, nome: u.nome, role: u.role };
}
function encerrarSessoes(email, manter) { // derruba as sessões de uma conta (menos a atual, se pedido)
  Object.keys(sessoes).forEach(t => { if (sessoes[t].email === email && t !== manter) delete sessoes[t]; });
}
setInterval(() => { // limpeza periódica da memória
  const agora = Date.now();
  Object.keys(sessoes).forEach(t => { if (sessoes[t].ate < agora) delete sessoes[t]; });
  Object.keys(limites).forEach(k => { if (limites[k].ate < agora) delete limites[k]; });
  Object.keys(tentativas).forEach(k => { if (tentativas[k].ate < agora && !tentativas[k].n) delete tentativas[k]; });
}, 10 * 60000).unref();

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

const SEG = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
function send(req, res, code, body, type, extra) {
  const txt = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEG, extra || {});
  const comprimivel = /json|text|javascript|svg|html|css/.test(headers['Content-Type']);
  if (comprimivel && txt.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
    res.writeHead(code, headers); return res.end(zlib.gzipSync(txt));
  }
  res.writeHead(code, headers); res.end(txt);
}

function readBody(req, res, limite, cb) {
  let raw = '', estourado = false;
  req.on('data', c => {
    if (estourado) return;
    raw += c;
    if (raw.length > limite) { estourado = true; send(req, res, 413, { ok: false }, null, { Connection: 'close' }); req.destroy(); }
  });
  req.on('end', () => { if (estourado) return; let j = {}; try { j = JSON.parse(raw || '{}'); } catch (e) {} if (!j || typeof j !== 'object') j = {}; cb(j); });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function negar(req, res, viewer, admin) { // 401 sem login, 403 sem permissão
  if (!viewer) { send(req, res, 401, { ok: false, erro: 'login' }); return true; }
  if (admin && viewer.role !== 'admin') { send(req, res, 403, { ok: false, erro: 'proibido' }); return true; }
  return false;
}

function rota(req, res, url, b, v, ip) {
  if (url === '/api/login') {
    if (estourou('ip-login:' + ip, 30, 15 * 60000)) return send(req, res, 429, { ok: false, erro: 'bloqueado' });
    const k = String(b.email || '').trim().toLowerCase();
    if (!emailOk(k)) return send(req, res, 200, { ok: false });
    const t = tentativas[k] || { n: 0, ate: 0 };
    if (t.ate > Date.now()) return send(req, res, 429, { ok: false, erro: 'bloqueado' });
    const us = lerUsers(), u = tem(us, k) ? us[k] : null;
    let ok = false;
    if (u) ok = confere(u, b.senha); else confere(DUMMY, b.senha);
    if (ok) { delete tentativas[k]; const token = criarSessao(k); return send(req, res, 200, { ok: true, token }); }
    t.n++; if (t.n >= 5) { t.ate = Date.now() + 15 * 60000; t.n = 0; } tentativas[k] = t;
    return send(req, res, 200, { ok: false });
  }
  if (url === '/api/logout') {
    if (typeof b.token === 'string') delete sessoes[b.token];
    return send(req, res, 200, { ok: true });
  }
  if (url === '/api/trocasenha') { // a própria pessoa troca a senha (precisa da atual)
    if (estourou('ip-troca:' + ip, 20, 15 * 60000)) return send(req, res, 429, { ok: false });
    const k = String(b.email || '').trim().toLowerCase(), us = lerUsers();
    const t = tentativas[k] || { n: 0, ate: 0 };
    if (!emailOk(k) || t.ate > Date.now() || !tem(us, k) || typeof b.atual !== 'string' || typeof b.nova !== 'string' || b.nova.length < SENHA_MIN || b.nova.length > 200) return send(req, res, 200, { ok: false });
    if (!confere(us[k], b.atual)) { t.n++; if (t.n >= 5) { t.ate = Date.now() + 15 * 60000; t.n = 0; } tentativas[k] = t; return send(req, res, 200, { ok: false }); }
    Object.assign(us[k], hashar(b.nova)); db.keys[USERS_KEY] = JSON.stringify(us); save();
    encerrarSessoes(k, tokenDoPedido(req)); // derruba outras sessões abertas dessa conta
    return send(req, res, 200, { ok: true });
  }
  if (url === '/api/definirsenha') { // só o administrador: define a senha de uma pessoa pelo e-mail
    if (negar(req, res, v, true)) return;
    const k = String(b.email || '').trim().toLowerCase(), us = lerUsers();
    if (!emailOk(k) || !tem(us, k) || typeof b.nova !== 'string' || b.nova.length < SENHA_MIN || b.nova.length > 200) return send(req, res, 200, { ok: false });
    Object.assign(us[k], hashar(b.nova)); db.keys[USERS_KEY] = JSON.stringify(us); save();
    encerrarSessoes(k, k === v.email ? tokenDoPedido(req) : null);
    delete tentativas[k];
    return send(req, res, 200, { ok: true });
  }
  if (url === '/api/set') {
    if (typeof b.key !== 'string' || typeof b.value !== 'string' || !chaveOk(b.key)) return send(req, res, 400, { ok: false });
    if (b.key === USERS_KEY) { // contas: junta com as que já existem, assim ninguém apaga a conta do outro
      let novo;
      try { novo = JSON.parse(b.value); } catch (e) { return send(req, res, 400, { ok: false }); }
      if (!novo || typeof novo !== 'object' || Array.isArray(novo)) return send(req, res, 400, { ok: false });
      db.keys[USERS_KEY] = JSON.stringify(mesclar(lerUsers(), novo, v, ip));
    } else {
      if (negar(req, res, v, false)) return; // dados da escola: só com login
      db.keys[b.key] = b.value;
    }
    save();
    return send(req, res, 200, { ok: true });
  }
  if (url === '/api/resetusers') { // apaga todas as contas, menos as de administrador
    if (negar(req, res, v, true)) return;
    try {
      const atual = lerUsers(), keep = {};
      Object.keys(atual).forEach(k => { if (atual[k] && atual[k].role === 'admin') keep[k] = atual[k]; });
      db.keys[USERS_KEY] = JSON.stringify(keep);
      Object.keys(sessoes).forEach(t => { if (!tem(keep, sessoes[t].email)) delete sessoes[t]; });
    } catch (e) {}
    db.overrides = {};
    Object.keys(students).forEach(k => delete students[k]);
    save();
    return send(req, res, 200, { ok: true });
  }
  if (url === '/api/beat') { // presença: sempre da conta logada (ninguém finge ser outro aluno)
    if (negar(req, res, v, false)) return;
    students[v.email] = { nome: v.nome || (students[v.email] && students[v.email].nome) || '', last: Date.now(), online: true };
    return send(req, res, 200, { ok: true });
  }
  if (url === '/api/offline') {
    if (negar(req, res, v, false)) return;
    if (students[v.email]) students[v.email].online = false;
    return send(req, res, 200, { ok: true });
  }
  if (url === '/api/override') { // só o administrador bloqueia/libera aluno
    if (negar(req, res, v, true)) return;
    const k = String(b.email || '').trim().toLowerCase();
    if (!emailOk(k)) return send(req, res, 400, { ok: false });
    if (b.v === 'auto') delete db.overrides[k]; else if (b.v === 'on' || b.v === 'off') db.overrides[k] = b.v;
    save();
    return send(req, res, 200, { ok: true });
  }
  return send(req, res, 404, { ok: false });
}

function atender(req, res) {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/api/state') return send(req, res, 200, { keys: keysPublicas(), students: studentsView(), viewer: viewerDoPedido(req) });

  if (req.method === 'POST' && url.startsWith('/api/')) {
    const v = viewerDoPedido(req), ip = ipDe(req);
    const pequeno = ['/api/login', '/api/logout', '/api/trocasenha', '/api/definirsenha', '/api/beat', '/api/offline', '/api/override', '/api/resetusers'].includes(url);
    const limite = pequeno ? 20e3 : (v ? 20e6 : 1e6); // sem login, pedidos grandes não são aceitos
    return readBody(req, res, limite, b => {
      try { rota(req, res, url, b, v, ip); } catch (e) { console.error(e); try { send(req, res, 500, { ok: false }); } catch (e2) {} }
    });
  }

  if (req.method === 'GET') { // arquivos do site (index.html etc.)
    let rel;
    try { rel = decodeURIComponent(url === '/' ? '/index.html' : url); } catch (e) { return send(req, res, 400, 'Pedido inválido', 'text/plain; charset=utf-8'); }
    if (rel.indexOf('\0') !== -1) return send(req, res, 400, 'Pedido inválido', 'text/plain; charset=utf-8');
    const file = path.normalize(path.join(DIR, rel));
    const base = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    const partes = path.relative(DIR, file).split(path.sep);
    if (!file.startsWith(DIR + path.sep) || !MIME[ext] || base.startsWith('dados') || base.startsWith('package') || base === 'server.js' ||
        partes.some(p => p.startsWith('.') || p === 'node_modules' || p === 'backups')) {
      return send(req, res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
    }
    return fs.readFile(file, (err, buf) => {
      if (err) return send(req, res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
      send(req, res, 200, buf, MIME[ext]);
    });
  }
  send(req, res, 405, 'Método não permitido', 'text/plain; charset=utf-8');
}

process.on('uncaughtException', e => console.error('Erro não tratado:', e));
process.on('unhandledRejection', e => console.error('Promessa rejeitada:', e));

http.createServer((req, res) => {
  try { atender(req, res); } catch (e) { console.error(e); try { send(req, res, 500, 'Erro interno', 'text/plain; charset=utf-8'); } catch (e2) {} }
}).listen(PORT, '0.0.0.0', () => {
  console.log('\n MatrixEdu rodando!\n');
  console.log(' Neste computador: http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(n => nets[n].forEach(i => {
    if (i.family === 'IPv4' && !i.internal) console.log(' Nos outros computadores da escola: http://' + i.address + ':' + PORT);
  }));
  console.log('\n Deixe esta janela aberta. Para parar: Ctrl + C\n');
});

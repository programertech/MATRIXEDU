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

const MODO_TESTE = process.env.MODO_TESTE === '1'; // 1 = professores novos entram sem aprovação do admin
const SESSAO_MS = 7 * 24 * 3600e3; // login vale 7 dias
const CHAVES = ['matrixedu_users_v2','matrixedu_grade_v1','matrixedu_carts_v1','matrixedu_log_v1','matrixedu_attendance_v1','matrixedu_activity_log_v1','matrixedu_access_log_v1','matrixedu_stucfg_v1','matrixedu_aviso_v1'];
const CHAVES_ALUNO = []; // aluno não grava nada compartilhado; os registros de acesso e cadastro são feitos pelo próprio servidor

let db = { keys: {}, overrides: {}, sessions: {} }; // keys = dados compartilhados; overrides = bloqueio/liberação manual por aluno
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
db.sessions = db.sessions || {};
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
function mesclar(atual, novo, adm) {
  const out = Object.assign({}, atual);
  Object.keys(novo).forEach(k => {
    const n = novo[k]; if (!n || typeof n !== 'object') return;
    const a = atual[k];
    if (!a) return;
    if (a) { // conta existente: só o administrador mexe (nome e licença); papel e senha nunca mudam por aqui
      if (!adm) return;
      const e = Object.assign({}, a);
      if (typeof n.nome === 'string') e.nome = n.nome.slice(0, 80);
      if (a.role !== 'admin' && ['liberada', 'pendente', 'bloqueada'].includes(n.licenca)) e.licenca = n.licenca;
      out[k] = e; return;
    }
    // conta nova: só pela rota /api/cadastro
  });
  return out;
}
const PUBLICAS = ['matrixedu_grade_v1','matrixedu_stucfg_v1','matrixedu_aviso_v1']; // o que a página mostra sem login
function estadoPara(who) { // cada pessoa só recebe o que pode ver
  const keys = {};
  PUBLICAS.forEach(k => { if (db.keys[k] != null) keys[k] = db.keys[k]; });
  const alunoSo = who && who.role === 'aluno';
  if (who) {
    const us = lerUsers(), vis = {};
    Object.keys(us).forEach(k => {
      if (alunoSo && k !== who.email) return; // aluno só vê a própria conta
      const u = us[k]; vis[k] = { nome: u.nome, role: u.role, licenca: u.licenca };
    });
    keys[USERS_KEY] = JSON.stringify(vis);
    if (!alunoSo) CHAVES.forEach(k => { if (k !== USERS_KEY && db.keys[k] != null) keys[k] = db.keys[k]; });
  }
  let st = who ? studentsView() : {};
  if (alunoSo) { const o = {}; if (st[who.email]) o[who.email] = st[who.email]; st = o; }
  return { keys, students: st, viewer: who ? { email: who.email, role: who.role } : null };
}
(function migrar() { // converte contas antigas (senha em texto) e garante um administrador
  const us = lerUsers(); let mudou = false;
  Object.keys(us).forEach(k => {
    if (us[k] && typeof us[k].senha === 'string') { Object.assign(us[k], hashar(us[k].senha)); delete us[k].senha; mudou = true; }
  });
  if (process.env.ADMIN_SENHA && us[ADMIN_EMAIL] && !confere(us[ADMIN_EMAIL], process.env.ADMIN_SENHA)) { // trocar a senha do admin: defina ADMIN_SENHA no Render
    Object.assign(us[ADMIN_EMAIL], hashar(process.env.ADMIN_SENHA), { role: 'admin' }); mudou = true;
  }
  if (!Object.keys(us).some(k => us[k] && us[k].role === 'admin' && us[k].hash)) {
    const s = process.env.ADMIN_SENHA || crypto.randomBytes(6).toString('hex');
    us[ADMIN_EMAIL] = Object.assign({ nome: 'Administrador', licenca: 'liberada' }, us[ADMIN_EMAIL] || {}, hashar(s), { role: 'admin' });
    if (!process.env.ADMIN_SENHA) console.log('\n ATENÇÃO: senha provisória do administrador: ' + s + '\n');
    mudou = true;
  }
  if (mudou) { db.keys[USERS_KEY] = JSON.stringify(us); save(); }
})();
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function novaSessao(email) { // o servidor guarda só o hash do token
  const t = crypto.randomBytes(24).toString('hex'), now = Date.now();
  Object.keys(db.sessions).forEach(h => { if (db.sessions[h].exp < now) delete db.sessions[h]; });
  db.sessions[sha(t)] = { email, exp: now + SESSAO_MS }; save();
  return t;
}
function licencaOk(u) { return !!u && (u.role !== 'professor' || u.licenca === 'liberada' || MODO_TESTE); }
function quem(b, req) { // quem está fazendo o pedido? null = ninguém logado
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const t = (b && typeof b.token === 'string' && b.token) || (m && m[1]);
  if (!t) return null;
  const s = db.sessions[sha(t)];
  if (!s || s.exp < Date.now()) return null;
  const u = lerUsers()[s.email];
  return licencaOk(u) ? { email: s.email, role: u.role } : null;
}
(function zerarLogs() { // pedido do dono: começa do zero (acessos, atividades, notebooks, presença); roda uma vez só
  const LOGS = ['matrixedu_access_log_v1', 'matrixedu_activity_log_v1', 'matrixedu_log_v1', 'matrixedu_attendance_v1'];
  if (db.logsZerados) return;
  LOGS.forEach(k => { db.keys[k] = '[]'; });
  db.logsZerados = new Date().toISOString();
  try { // limpa também as cópias antigas (backups) para os logs não voltarem
    const dir = path.join(DATA_DIR, 'backups');
    fs.readdirSync(dir).forEach(f => {
      const fp = path.join(dir, f);
      try { const d = JSON.parse(fs.readFileSync(fp, 'utf8')); d.keys = d.keys || {}; LOGS.forEach(k => { d.keys[k] = '[]'; }); fs.writeFileSync(fp, JSON.stringify(d)); } catch (e) {}
    });
  } catch (e) {}
  save();
})();
/* Registros feitos pelo servidor (cadastros e logins), do mais novo para o mais antigo, no mesmo formato que o painel do administrador lê */
const K_ACESSO = 'matrixedu_access_log_v1', K_ATIV = 'matrixedu_activity_log_v1';
const limpo = (x, n) => String(x == null ? '' : x).replace(/[<>"'`&]/g, '').trim().slice(0, n || 80); // sem HTML: o painel mostra esses textos
function carimbo() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '');
}
function registrar(chave, entrada, max) {
  let a = []; try { a = JSON.parse(db.keys[chave] || '[]'); } catch (e) {}
  if (!Array.isArray(a)) a = [];
  a.unshift(entrada); db.keys[chave] = JSON.stringify(a.slice(0, max)); save();
}
const falhasIp = {}; // evita encher o registro com milhares de tentativas erradas de um mesmo IP
function ipDe(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function logAcesso(req, email, nome, perfil, resultado, sucesso) {
  if (!sucesso) {
    const ip = ipDe(req), agora = Date.now(), f = (falhasIp[ip] = (falhasIp[ip] || []).filter(t => agora - t < 600000));
    if (f.length >= 30) return; f.push(agora);
  }
  const c = carimbo(), e = limpo(email, 80) || '—';
  registrar(K_ACESSO, { carimbo: c, email: e, nome: limpo(nome) || '—', perfil: limpo(perfil, 20) || '—', resultado, sucesso: !!sucesso }, 300);
  registrar(K_ATIV, { carimbo: c, tipo: 'Acesso', usuario: e, detalhe: resultado }, 500);
}
const tentativas = {};
const cadastros = {}; // limite de cadastros por IP // trava o login após 5 erros por 15 min

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
  if (req.method === 'GET' && url === '/api/state') return send(req, res, 200, estadoPara(quem({}, req)));

  if (req.method === 'POST' && url.startsWith('/api/')) {
    return readBody(req, b => {
      if (url === '/api/login') {
        const k = String(b.email || '').trim().toLowerCase(), t = tentativas[k] || { n: 0, ate: 0 };
        if (t.ate > Date.now()) return send(req, res, 429, { ok: false, erro: 'bloqueado' });
        const us = lerUsers(), u = us[k], ok = confere(u, b.senha);
        let token = null;
        if (ok) {
          delete tentativas[k];
          if (licencaOk(u)) { token = novaSessao(k); logAcesso(req, k, u.nome, u.role, 'Login bem-sucedido', true); }
          else logAcesso(req, k, u.nome, u.role, u.licenca === 'pendente' ? 'Licença pendente' : 'Licença bloqueada', false);
        } else {
          t.n++; logAcesso(req, k, u ? u.nome : '—', u ? u.role : '—', 'Senha ou e-mail incorretos', false);
          if (t.n >= 5) { t.ate = Date.now() + 15 * 60000; t.n = 0; logAcesso(req, k, u ? u.nome : '—', u ? u.role : '—', 'Bloqueado por 15 min após 5 erros', false); }
          tentativas[k] = t;
        }
        const eu = ok && u ? { nome: u.nome, role: u.role, licenca: u.licenca } : null;
        return send(req, res, 200, { ok, token, user: eu });
      }
      if (url === '/api/logout') { const h = sha(b.token || ''); if (db.sessions[h]) { delete db.sessions[h]; save(); } return send(req, res, 200, { ok: true }); }
      if (url === '/api/trocasenha') {
        const k = String(b.email || '').trim().toLowerCase(), us = lerUsers(), t = tentativas[k] || { n: 0, ate: 0 };
        if (t.ate > Date.now() || !us[k] || typeof b.nova !== 'string' || b.nova.length < 4) return send(req, res, 200, { ok: false });
        if (!confere(us[k], b.atual)) { t.n++; if (t.n >= 5) { t.ate = Date.now() + 15 * 60000; t.n = 0; } tentativas[k] = t; return send(req, res, 200, { ok: false }); }
        Object.assign(us[k], hashar(b.nova)); db.keys[USERS_KEY] = JSON.stringify(us); save();
        return send(req, res, 200, { ok: true });
      }
      if (url === '/api/cadastro') {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), agora = Date.now();
        const c = (cadastros[ip] = (cadastros[ip] || []).filter(t => agora - t < 600000));
        if (c.length >= 100) return send(req, res, 429, { ok: false, erro: 'muitos' });
        const k = String(b.email || '').trim().toLowerCase(), us = lerUsers(), nome = String(b.nome || '').replace(/[<>`]/g, '').trim().slice(0, 80);
        if (k.length > 80 || !/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(k) || typeof b.senha !== 'string' || b.senha.length < 4 || !nome) return send(req, res, 200, { ok: false, erro: 'invalido' });
        if (us[k]) return send(req, res, 200, { ok: false, erro: 'existe' });
        const role = b.perfil === 'aluno' ? 'aluno' : 'professor';
        us[k] = Object.assign({ nome, role, licenca: (role === 'aluno' || MODO_TESTE) ? 'liberada' : 'pendente' }, hashar(b.senha));
        db.keys[USERS_KEY] = JSON.stringify(us); save(); c.push(agora);
        registrar(K_ATIV, { carimbo: carimbo(), tipo: 'Cadastro de conta', usuario: k, detalhe: 'Conta de ' + role + ' criada para ' + limpo(nome) + (us[k].licenca === 'pendente' ? ' (aguardando liberação de licença)' : '') }, 500);
        return send(req, res, 200, { ok: true, licenca: us[k].licenca });
      }
      const who = quem(b, req), staff = !!who && who.role !== 'aluno';
      if (url === '/api/set' && typeof b.key === 'string' && typeof b.value === 'string') {
        if (!CHAVES.includes(b.key)) return send(req, res, 400, { ok: false });
        if (b.key === USERS_KEY) { // alterar contas existentes: só o administrador
          if (!who || who.role !== 'admin') return send(req, res, who ? 403 : 401, { ok: false });
          try { b.value = JSON.stringify(mesclar(lerUsers(), JSON.parse(b.value), !!who && who.role === 'admin')); } catch (e) { return send(req, res, 400, { ok: false }); }
        } else if (!who || (!staff && !CHAVES_ALUNO.includes(b.key))) return send(req, res, who ? 403 : 401, { ok: false });
        db.keys[b.key] = b.value; save();
      } else if (url === '/api/beat') { // o aluno só pode avisar por si mesmo
        if (!who) return send(req, res, 401, { ok: false });
        students[who.email] = { nome: String(b.nome || (students[who.email] && students[who.email].nome) || '').slice(0, 80), last: Date.now(), online: true };
      } else if (url === '/api/offline') {
        if (!who) return send(req, res, 401, { ok: false });
        if (students[who.email]) students[who.email].online = false;
      } else if (url === '/api/override' && b.email) { // bloquear/liberar tela de aluno: só professor ou administrador
        if (!staff) return send(req, res, who ? 403 : 401, { ok: false });
        if (b.v === 'auto') delete db.overrides[b.email]; else if (b.v === 'on' || b.v === 'off') db.overrides[b.email] = b.v;
        save();
      }
      send(req, res, 200, { ok: true });
    });
  }

  if (req.method === 'GET') { // arquivos do site (index.html etc.)
    let rel;
    try { rel = decodeURIComponent(url === '/' ? '/index.html' : url); } catch (e) { return send(req, res, 400, 'Pedido inválido', 'text/plain; charset=utf-8'); }
    const file = path.normalize(path.join(DIR, rel));
    const base = path.basename(file);
    if (rel.includes('\0') || !(file === DIR || file.startsWith(DIR + path.sep)) || base.startsWith('dados') || base === 'server.js' || file.includes(path.sep + 'backups' + path.sep)) return send(req, res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
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

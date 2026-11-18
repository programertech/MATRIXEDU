// Servidor do MatrixEdu — sem dependências. Rode com: node server.js
// Compartilha entre todos os computadores: contas, grade, carrinhos, registros e alunos logados.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const ONLINE_MS = 20000; // aluno conta como logado se deu sinal nos últimos 20s

const SHARED = ['matrixedu_users_v2','matrixedu_grade_v1','matrixedu_carts_v1','matrixedu_log_v1',
  'matrixedu_attendance_v1','matrixedu_activity_log_v1','matrixedu_access_log_v1','matrixedu_stucfg_v1'];

let db = { keys: {}, students: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('Erro ao salvar:', e.message); }
  }, 500);
}

function studentsView() {
  const now = Date.now(), out = {};
  Object.keys(db.students).forEach(k => {
    const s = db.students[k];
    out[k] = Object.assign({}, s, { on: !!s.online && (now - (s.last || 0)) < ONLINE_MS });
  });
  return out;
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/state') return json(res, 200, { keys: db.keys, students: studentsView() });

  if (req.method === 'POST' && url.startsWith('/api/')) {
    const b = await readBody(req);
    if (url === '/api/set') {
      if (SHARED.includes(b.key) && typeof b.value === 'string') { db.keys[b.key] = b.value; save(); }
    } else if (url === '/api/beat') {
      if (b.email) {
        const s = db.students[b.email] || {};
        db.students[b.email] = Object.assign(s, { nome: b.nome || s.nome || '', last: Date.now(), online: true });
        save();
      }
    } else if (url === '/api/override') {
      const s = db.students[b.email];
      if (s) { if (b.v === 'auto') delete s.override; else if (b.v === 'on' || b.v === 'off') s.override = b.v; save(); }
    } else if (url === '/api/offline') {
      const s = db.students[b.email];
      if (s) { s.online = false; save(); }
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('index.html não encontrado'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  res.writeHead(404); res.end('Não encontrado');
}).listen(PORT, () => console.log('MatrixEdu rodando na porta ' + PORT));

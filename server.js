/* MatrixEdu · servidor da escola
   Uso:  node server.js        (ou dê dois cliques em iniciar.bat no Windows)
   Sem instalar nada além do Node.js. Os dados ficam no arquivo dados.json, na mesma pasta. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DATA_FILE = path.join(DIR, 'dados.json');
const ONLINE_MS = 20000;               // aluno some da lista se ficar 20 s sem sinal
const USERS_KEY = 'matrixedu_users_v2';

let db = { keys: {}, overrides: {} };   // keys = dados compartilhados; overrides = bloqueio/liberação manual por aluno
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
const students = {};                    // presença em memória: email -> {nome, last, online}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(db), err => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 300);
}

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

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, cb) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 20e6) req.destroy(); });
  req.on('end', () => { let j = {}; try { j = JSON.parse(raw || '{}'); } catch (e) {} cb(j); });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/state') return send(res, 200, { keys: db.keys, students: studentsView() });

  if (req.method === 'POST' && url.startsWith('/api/')) {
    return readBody(req, b => {
      if (url === '/api/set' && typeof b.key === 'string' && typeof b.value === 'string') {
        if (b.key === USERS_KEY) {            // contas: junta com as que já existem, assim ninguém apaga a conta do outro
          try {
            const atual = JSON.parse(db.keys[USERS_KEY] || '{}'), novo = JSON.parse(b.value);
            b.value = JSON.stringify(Object.assign({}, atual, novo));
          } catch (e) {}
        }
        db.keys[b.key] = b.value; save();
      } else if (url === '/api/beat' && b.email) {
        students[b.email] = { nome: b.nome || (students[b.email] && students[b.email].nome) || '', last: Date.now(), online: true };
      } else if (url === '/api/offline' && b.email) {
        if (students[b.email]) students[b.email].online = false;
      } else if (url === '/api/override' && b.email) {
        if (b.v === 'auto') delete db.overrides[b.email]; else if (b.v === 'on' || b.v === 'off') db.overrides[b.email] = b.v;
        save();
      }
      send(res, 200, { ok: true });
    });
  }

  if (req.method === 'GET') {                 // arquivos do site (index.html etc.)
    let rel = decodeURIComponent(url === '/' ? '/index.html' : url);
    const file = path.normalize(path.join(DIR, rel));
    const base = path.basename(file);
    if (!file.startsWith(DIR) || base === 'dados.json' || base === 'server.js') return send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
    return fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }
  send(res, 405, 'Método não permitido', 'text/plain; charset=utf-8');
}).listen(PORT, '0.0.0.0', () => {
  console.log('\n  MatrixEdu rodando!\n');
  console.log('  Neste computador:  http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(n => nets[n].forEach(i => {
    if (i.family === 'IPv4' && !i.internal) console.log('  Nos outros computadores da escola:  http://' + i.address + ':' + PORT);
  }));
  console.log('\n  Deixe esta janela aberta. Para parar: Ctrl + C\n');
});

'use strict';
// NEXUS AI — backend. Sem dependências (Node 18+). A chave fica só aqui, em variável de ambiente.
const http = require('http'), fs = require('fs'), path = require('path');

try { // carregador mínimo de .env (uso local)
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const KEY = process.env.GROQ_API_KEY || '';
const MODEL = process.env.GROQ_MODEL || process.env.OPENAI_MODEL || '';
const BASE = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const PORT = +process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_MSGS = 20, MAX_CHARS = 4000, MAX_BODY = 65536, RATE = 20, WINDOW = 60000;

const SYSTEM = `Você é o NEXUS, assistente do painel NEXUS AI. Responda sempre em português brasileiro, com frases curtas e claras, pois a resposta pode ser lida em voz alta. Ajude com perguntas gerais, estudos, programação e tarefas do dia a dia. Você NÃO tem acesso ao navegador, ao computador, à internet em tempo real nem às contas do usuário; nunca diga que executou, abriu ou alterou algo. Para propor abrir um serviço ou fazer uma pesquisa, termine a resposta com exatamente uma destas marcas: [[ACAO:abrir:NOME]] (NOME: YouTube, Netflix, Prime Video, HBO Max, Spotify, Gmail, Google Drive, Google Calendar ou Google) ou [[ACAO:pesquisar:TERMO]]. A interface pedirá confirmação ao usuário; diga apenas que está propondo a ação. Se não souber algo, diga que não sabe.`;

const log = (...a) => console.log(new Date().toISOString(), ...a); // nunca registra chave nem conteúdo
const send = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
};
const hits = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < WINDOW)) hits.delete(k); }, WINDOW).unref();
function limited(req) {
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const n = Date.now(), arr = (hits.get(ip) || []).filter(t => n - t < WINDOW);
  arr.push(n); hits.set(ip, arr);
  return arr.length > RATE;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { if (size - c.length <= MAX_BODY) { const e = new Error('big'); e.code = 413; reject(e); } } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

async function chat(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin', message: 'Origem não permitida.' });
  if (!KEY || !MODEL) return send(res, 503, { error: 'not_configured', message: 'O serviço de IA não está configurado no servidor (faltam OPENAI_API_KEY e/ou OPENAI_MODEL).' });
  if (limited(req)) return send(res, 429, { error: 'rate_limited', message: 'Muitas mensagens em pouco tempo. Aguarde um minuto.' });
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { if (e.code === 413) res.once('finish', () => req.destroy()); return send(res, e.code === 413 ? 413 : 400, { error: 'bad_request', message: e.code === 413 ? 'Mensagem grande demais.' : 'Requisição inválida.' }); }
  const m = body && body.messages;
  const ok = Array.isArray(m) && m.length >= 1 && m.length <= MAX_MSGS &&
    m.every(x => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string' && x.content.trim() && x.content.length <= MAX_CHARS) &&
    m[m.length - 1].role === 'user';
  if (!ok) return send(res, 400, { error: 'bad_request', message: `Envie de 1 a ${MAX_MSGS} mensagens de até ${MAX_CHARS} caracteres, terminando com uma mensagem do usuário.` });
  const input = m.map(x => ({ role: x.role, content: x.content }));

  let r;
  try {
    r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
     body: JSON.stringify({
  model: MODEL,
  messages: [{ role: 'system', content: SYSTEM }, ...input],
  max_tokens: 900
}),
      signal: AbortSignal.timeout(30000)
    });
  } catch (e) {
    log('upstream_unreachable', e.name);
    return send(res, 502, { error: 'upstream_unreachable', message: 'O servidor não conseguiu contatar a OpenAI. Verifique a conexão e tente de novo.' });
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const code = (data && data.error && (data.error.code || data.error.type)) || '';
    log('openai_error', r.status, code);
    if (r.status === 401) return send(res, 502, { error: 'auth', message: 'A OpenAI recusou a chave de API. Verifique OPENAI_API_KEY no servidor.' });
    if (r.status === 429) return send(res, 429, code === 'insufficient_quota'
      ? { error: 'quota', message: 'A conta da OpenAI está sem crédito ou cota. Verifique o faturamento.' }
      : { error: 'rate_limited', message: 'Limite de uso da OpenAI atingido. Tente novamente em instantes.' });
    if (r.status === 404 || code === 'model_not_found') return send(res, 502, { error: 'model', message: 'O modelo configurado em OPENAI_MODEL não está disponível para esta conta.' });
    if (r.status === 400) return send(res, 502, { error: 'upstream_bad_request', message: 'A OpenAI rejeitou a requisição.' });
    return send(res, 502, { error: 'upstream_unavailable', message: 'A OpenAI está indisponível no momento. Tente novamente.' });
  }
 const text = data && data.choices && data.choices[0] &&
  data.choices[0].message && data.choices[0].message.content
  ? data.choices[0].message.content.trim()
  : '';

if (!text) {
  return send(res, 502, {
    error: 'empty',
    message: 'A IA não retornou texto. Tente reformular.'
  });
}

send(res, 200, { reply: text });
  if (!text) return send(res, 502, { error: 'empty', message: 'A IA não retornou texto. Tente reformular.' });
  send(res, 200, { reply: text });
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/health') return send(res, 200, { configured: !!(KEY && MODEL) });
    if (req.method === 'POST' && url === '/api/chat') return await chat(req, res);
    if (req.method === 'GET' && url === '/api/search') {
  const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
  if (!q.trim()) return send(res, 400, { error: 'Digite o que deseja pesquisar.' });

  try {
  const response = await fetch(
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q),
    {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error('Falha na pesquisa');
  }

  const html = await response.text();
  const results = [];
  const blocks = html.split('class="result ');

  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);

    if (titleMatch) {
      const clean = (s) => s.replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();

      results.push({
        title: clean(titleMatch[2]),
        snippet: snippetMatch ? clean(snippetMatch[1]) : '',
        url: titleMatch[1]
      });
    }

    if (results.length >= 8) break;
  }

  return send(res, 200, { results });

    const results = [];
    if (data.AbstractText) {
      results.push({
        title: data.Heading || q,
        snippet: data.AbstractText,
        url: data.AbstractURL || ''
      });
    }

    for (const item of (data.RelatedTopics || [])) {
      if (item.Text && item.FirstURL) {
        results.push({
          title: item.Text.split(' - ')[0],
          snippet: item.Text,
          url: item.FirstURL
        });
      }
      if (item.Topics) {
        for (const sub of item.Topics) {
          if (sub.Text && sub.FirstURL) {
            results.push({
              title: sub.Text.split(' - ')[0],
              snippet: sub.Text,
              url: sub.FirstURL
            });
          }
        }
      }
    }

    return send(res, 200, { results: results.slice(0, 8) });
  } catch {
    return send(res, 502, { error: 'Não foi possível pesquisar agora.' });
  }
}
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    send(res, 404, { error: 'not_found', message: 'Não encontrado.' });
  } catch (e) {
    log('internal_error', e.name);
    if (!res.headersSent) send(res, 500, { error: 'internal', message: 'Erro interno do servidor.' });
  }
});
if (require.main === module) server.listen(PORT, () => log(`NEXUS em http://localhost:${PORT} | IA ${KEY && MODEL ? 'configurada' : 'NÃO configurada'}`));
module.exports = server;

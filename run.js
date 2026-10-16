// Testa o backend contra uma "OpenAI" falsa local (não usa chave real nem internet).
const http = require('http'), { spawn } = require('child_process'), path = require('path');
let fails = 0; const ok = (c, n) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const auth = req.headers.authorization, j = JSON.parse(b), last = j.input[j.input.length - 1].content;
    const out = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url !== '/v1/responses' || j.store !== false || !j.model || !j.instructions) return out(400, { error: { code: 'bad' } });
    if (auth === 'Bearer chave-ruim') return out(401, { error: { code: 'invalid_api_key' } });
    if (auth === 'Bearer sem-cota') return out(429, { error: { code: 'insufficient_quota' } });
    out(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: `n=${j.input.length}; primeira=${j.input[0].content}; ultima=${last}` }] }] });
  });
}).listen(4010);
const start = (port, env) => new Promise(r => {
  const p = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, PORT: port, OPENAI_BASE_URL: 'http://127.0.0.1:4010/v1', ...env } });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  p.getLog = () => log; setTimeout(() => r(p), 400);
});
const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }).then(async r => ({ s: r.status, j: await r.json() }));
(async () => {
  const good = await start(4011, { OPENAI_API_KEY: 'chave-boa', OPENAI_MODEL: 'modelo-teste' });
  const bad = await start(4012, { OPENAI_API_KEY: 'chave-ruim', OPENAI_MODEL: 'm' });
  const quota = await start(4013, { OPENAI_API_KEY: 'sem-cota', OPENAI_MODEL: 'm' });
  const down = await start(4014, { OPENAI_API_KEY: 'x', OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' });
  const none = await start(4015, {});
  const U = (t) => ({ role: 'user', content: t });
  let r = await fetch('http://127.0.0.1:4011/api/health').then(x => x.json()); ok(r.configured === true, 'health configurado');
  r = await fetch('http://127.0.0.1:4015/api/health').then(x => x.json()); ok(r.configured === false, 'health sem chave');
  r = await post(4011, { messages: [U('O que é fotossíntese?')] }); ok(r.s === 200 && r.j.reply.includes('n=1'), 'pergunta simples em português');
  r = await post(4011, { messages: [U('Fale de Marte'), { role: 'assistant', content: 'Marte é um planeta.' }, U('E o tamanho dele?')] });
  ok(r.s === 200 && r.j.reply.includes('n=3') && r.j.reply.includes('primeira=Fale de Marte'), 'contexto de duas mensagens relacionadas chega ao modelo');
  r = await post(4012, { messages: [U('oi')] }); ok(r.s === 502 && r.j.error === 'auth', 'falha de autenticação (401)');
  r = await post(4013, { messages: [U('oi')] }); ok(r.s === 429 && r.j.error === 'quota', 'sem cota/faturamento (429)');
  r = await post(4014, { messages: [U('oi')] }); ok(r.s === 502 && r.j.error === 'upstream_unreachable', 'falha de conexão com a OpenAI');
  r = await post(4015, { messages: [U('oi')] }); ok(r.s === 503 && r.j.error === 'not_configured', 'servidor sem chave');
  r = await post(4011, { messages: [] }); ok(r.s === 400, 'valida lista vazia');
  r = await post(4011, { messages: [U('a'.repeat(4001))] }); ok(r.s === 400, 'limita tamanho da mensagem');
  r = await post(4011, { messages: [U('a'), { role: 'assistant', content: 'b' }] }); ok(r.s === 400, 'exige terminar com mensagem do usuário');
  r = await post(4011, { messages: [{ role: 'system', content: 'x' }] }); ok(r.s === 400, 'rejeita papel inválido');
  r = await post(4011, '{"messages":"' + 'a'.repeat(70000) + '"}'); ok(r.s === 413, 'limita tamanho do corpo');
  r = await post(4011, { messages: [U('oi')] }, { Origin: 'http://site-malicioso.com' }); ok(r.s === 403, 'bloqueia origem diferente');
  let last; for (let i = 0; i < 25; i++) last = await post(4011, { messages: [U('x')] }); ok(last.s === 429 && last.j.error === 'rate_limited', 'limite de requisições por IP');
  const html = await fetch('http://127.0.0.1:4011/').then(x => x.text());
  ok(html.includes('NEXUS') && !/chave-boa|Bearer|sk-/.test(html), 'interface servida sem expor chave');
  const all = good.getLog() + bad.getLog() + quota.getLog() + down.getLog();
  ok(!/chave-boa|chave-ruim|sem-cota|Fale de Marte|fotoss/.test(all), 'logs sem chave nem conteúdo das conversas');
  [good, bad, quota, down, none].forEach(p => p.kill()); mock.close();
  console.log(fails ? `\n${fails} falha(s)` : '\nTodos os testes passaram'); process.exit(fails ? 1 : 0);
})();

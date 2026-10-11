import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';

const EMPTY_REFLECTION = JSON.stringify({ memories: [] });
const MODEL = 'test-model';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function sendJSON(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function startMockOllama() {
  const events = new EventEmitter();
  const state = {
    models: [{ name: `${MODEL}:latest` }],
    calls: [],
    onChat: async () => 'Готовый ответ Братика.',
    onReflection: async () => EMPTY_REFLECTION,
    onShow: async () => ({ capabilities: ['completion'], details: { family: 'test' } }),
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const call = { method: req.method, path: req.url, body };
      state.calls.push(call);
      events.emit('call', call);
      if (req.method === 'GET' && req.url === '/api/tags') return sendJSON(res, 200, { models: state.models });
      if (req.method === 'POST' && req.url === '/api/show') {
        const value = await state.onShow(call);
        return sendJSON(res, value?.status || 200, value?.body || value);
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        const value = await (body.format ? state.onReflection : state.onChat)(call);
        return typeof value === 'string'
          ? sendJSON(res, 200, { message: { content: value } })
          : sendJSON(res, value.status, value.body);
      }
      sendJSON(res, 404, { error: 'Unexpected mock endpoint' });
    } catch (error) { sendJSON(res, 500, { error: `Mock failure: ${error.message}` }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    get chats() { return state.calls.filter(call => call.path === '/api/chat' && !call.body.format); },
    get reflections() { return state.calls.filter(call => call.path === '/api/chat' && call.body.format); },
    waitForCall(predicate, count = 1) {
      const matched = () => state.calls.filter(predicate);
      if (matched().length >= count) return Promise.resolve(matched()[count - 1]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { events.off('call', onCall); reject(new Error(`Mock did not receive ${count} expected calls`)); }, 2000);
        function onCall() {
          const calls = matched();
          if (calls.length < count) return;
          clearTimeout(timer);
          events.off('call', onCall);
          resolve(calls[count - 1]);
        }
        events.on('call', onCall);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await stopped;
    },
  };
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bratik-server-'));
  const dbPath = join(directory, 'bratik.db');
  options.prepareDatabase?.(dbPath);
  const mock = await startMockOllama();
  const config = { dbPath, ollamaUrl: mock.url, model: MODEL, timeoutMs: 1500, statusTimeoutMs: 200, ...options.appOptions };
  const env = { directory, dbPath, mock, gates: [], app: null, url: null };
  env.gate = () => { const gate = deferred(); env.gates.push(gate); return gate; };
  env.start = async () => {
    env.app = await createApplication(config);
    env.url = await env.app.listen(0);
  };
  env.restart = async () => { await env.app.close(); await env.start(); };
  t.after(async () => {
    for (const gate of env.gates) gate.resolve();
    await env.app?.close();
    await mock.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await env.start();
  return env;
}

async function request(env, path, { method = 'GET', body, rawBody, headers = {} } = {}) {
  const response = await fetch(`${env.url}${path}`, {
    method,
    headers: { ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function chat(env, request_id, message) {
  return request(env, '/api/chat', { method: 'POST', body: { request_id, message } });
}

async function turnState(env, id, expected) {
  const deadline = Date.now() + 2000;
  let last;
  while (Date.now() < deadline) {
    last = await request(env, `/api/turns/${id}`);
    if (last.body.reflection?.state === expected) return last.body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Turn ${id} did not reach ${expected}: ${JSON.stringify(last?.body)}`);
}

function reflectionUser(call) {
  return JSON.parse(call.body.messages.find(message => message.role === 'user').content).user_message;
}

test('status distinguishes a missing model, incompatible model and offline Ollama', async t => {
  const env = await fixture(t);
  let result = await request(env, '/api/status');
  assert.equal(result.status, 200);
  assert.equal(result.body.ollama.ready, true);
  assert.equal(result.body.ollama.code, 'ready');
  assert.deepEqual(result.body.memories, { pending: 0, approved: 0, forgotten: 0 });
  assert.equal(env.mock.chats.length, 0, 'status checks must not consume a generation');
  env.mock.state.models = [];
  result = await request(env, '/api/status');
  assert.equal(result.body.ollama.ready, false);
  assert.equal(result.body.ollama.code, 'model_missing');
  env.mock.state.models = [{ name: `${MODEL}:latest` }];
  env.mock.state.onShow = async () => ({ capabilities: ['embedding'], details: { family: 'test' } });
  result = await request(env, '/api/status');
  assert.equal(result.body.ollama.ready, false);
  assert.match(result.body.ollama.message, /не поддерживает текстовый разговор/);
  const unsupported = await chat(env, 'unsupported-model', 'Проверка модели.');
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.code, 'MODEL_UNSUPPORTED');
  assert.equal(env.mock.chats.length, 0);
  await env.mock.close();
  result = await request(env, '/api/status');
  assert.equal(result.status, 200);
  assert.equal(result.body.ollama.ready, false);
  assert.equal(result.body.ollama.code, 'unreachable');
  const offline = await chat(env, 'offline-request', 'Проверка соединения.');
  assert.equal(offline.status, 503);
  assert.equal(offline.body.code, 'OLLAMA_UNAVAILABLE');
  assert.deepEqual((await request(env, '/api/history')).body.messages, []);
});

test('successful chat saves one ordered pair, survives reopen, and replays the same request id', async t => {
  const env = await fixture(t);
  env.mock.state.onChat = async () => 'Двенадцать эпизодов. Продолжаем.';
  const id = 'persisted-turn-001';
  const message = 'Продолжим проект Антарктида.';
  const result = await chat(env, id, message);
  assert.equal(result.status, 200);
  assert.equal(result.body.request_id, id);
  assert.equal(result.body.answer, 'Двенадцать эпизодов. Продолжаем.');
  assert.deepEqual(result.body.memories_used, []);
  await turnState(env, id, 'completed');
  let history = (await request(env, '/api/history')).body;
  assert.deepEqual(history.messages.map(row => [row.role, row.content, row.request_id]), [
    ['user', message, id], ['assistant', result.body.answer, id],
  ]);
  assert.equal(history.has_more, false);
  const replay = await chat(env, id, message);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.answer, result.body.answer);
  assert.equal(env.mock.chats.length, 1);
  await env.restart();
  history = (await request(env, '/api/history')).body;
  assert.equal(history.messages.length, 2);
  const replayAfterRestart = await chat(env, id, message);
  assert.equal(replayAfterRestart.body.replayed, true);
  assert.equal(replayAfterRestart.body.answer, result.body.answer);
  assert.equal(env.mock.chats.length, 1);
  const conflict = await chat(env, id, 'Другое сообщение с прежним ID.');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'REQUEST_CONFLICT');
  const exported = await request(env, '/api/export');
  assert.equal(exported.body.messages.length, 2);
  assert.equal(exported.body.turns.length, 1);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
});

test('simultaneous same-id requests share one generation; conflicting chats and model changes get 409', async t => {
  const env = await fixture(t);
  const gate = env.gate();
  env.mock.state.onChat = async () => { await gate.promise; return 'Единственный ответ.'; };
  const first = chat(env, 'concurrent-turn-001', 'Не дублируй этот запрос.');
  await env.mock.waitForCall(call => call.path === '/api/chat' && !call.body.format);
  const repeated = chat(env, 'concurrent-turn-001', 'Не дублируй этот запрос.');
  const busy = await chat(env, 'concurrent-turn-002', 'Другой запрос.');
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'CHAT_BUSY');
  const conflict = await chat(env, 'concurrent-turn-001', 'Тот же ID, другой текст.');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'REQUEST_CONFLICT');
  const change = await request(env, '/api/settings', { method: 'POST', body: { model: MODEL } });
  assert.equal(change.status, 409);
  gate.resolve();
  const [a, b] = await Promise.all([first, repeated]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.answer, b.body.answer);
  assert.equal(b.body.replayed, true);
  assert.equal(env.mock.chats.length, 1);
  assert.equal((await request(env, '/api/history')).body.messages.length, 2);
});

test('upstream failure and timeout leave no orphan user message, and same-id retry succeeds once', async t => {
  const env = await fixture(t, { appOptions: { timeoutMs: 100 } });
  const gate = env.gate();
  let attempts = 0;
  env.mock.state.onChat = async () => {
    attempts++;
    if (attempts === 1) return { status: 503, body: { error: 'Temporary test model failure' } };
    if (attempts === 2) { await gate.promise; return 'Слишком поздний ответ.'; }
    return 'Ответ после повторной попытки.';
  };
  const id = 'retryable-turn-001';
  const first = await chat(env, id, 'Закончи только один раз.');
  assert.equal(first.status, 502);
  assert.equal(first.body.code, 'OLLAMA_ERROR');
  assert.equal((await request(env, '/api/history')).body.messages.length, 0);
  assert.equal((await request(env, `/api/turns/${id}`)).status, 404);
  const timeout = await chat(env, id, 'Закончи только один раз.');
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.code, 'MODEL_TIMEOUT');
  assert.equal((await request(env, '/api/history')).body.messages.length, 0);
  gate.resolve();
  const success = await chat(env, id, 'Закончи только один раз.');
  assert.equal(success.status, 200);
  assert.equal(success.body.answer, 'Ответ после повторной попытки.');
  const history = (await request(env, '/api/history')).body.messages;
  assert.equal(history.length, 2);
  assert.equal(history.filter(row => row.role === 'user').length, 1);
});

test('memory HTTP workflow keeps pending out of context, applies approved edits, and excludes forgotten text', async t => {
  const env = await fixture(t);
  const fact = 'Для проекта Кварц-спектр выбран лазурный цвет.';
  const edited = 'Для проекта Кварц-спектр выбран фиолетовый цвет.';
  env.mock.state.onReflection = async call => reflectionUser(call).startsWith('Запомни:')
    ? JSON.stringify({ memories: [{ kind: 'project', content: fact, importance: 9, confidence: 1 }] })
    : EMPTY_REFLECTION;
  assert.equal((await chat(env, 'memory-workflow-001', `Запомни: ${fact}`)).status, 200);
  await turnState(env, 'memory-workflow-001', 'completed');
  const pending = await request(env, '/api/memories?status=pending');
  assert.equal(pending.status, 200);
  assert.equal(pending.body.memories.length, 1);
  const memory = pending.body.memories[0];
  assert.equal(memory.status, 'pending');
  assert.equal(memory.source_turn_id, 'memory-workflow-001');
  const before = await chat(env, 'memory-workflow-002', 'Продолжим Кварц-спектр.');
  assert.deepEqual(before.body.memories_used, []);
  assert.equal(env.mock.chats.at(-1).body.messages[0].content.includes(fact), false);
  const approved = await request(env, `/api/memories/${memory.id}/approve`, { method: 'POST', body: {} });
  assert.equal(approved.body.memory.status, 'approved');
  const patch = await request(env, `/api/memories/${memory.id}`, { method: 'PATCH', body: { content: edited } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.memory.content, edited);
  assert.equal(patch.body.memory.status, 'approved');
  const after = await chat(env, 'memory-workflow-003', 'Что выбрано для Кварц-спектр?');
  assert.deepEqual(after.body.memories_used.map(row => row.content), [edited]);
  assert.equal(env.mock.chats.at(-1).body.messages[0].content.includes(edited), true);
  assert.equal((await request(env, `/api/memories/${memory.id}`, { method: 'DELETE' })).status, 200);
  const forgotten = await chat(env, 'memory-workflow-004', 'Что теперь с Кварц-спектр?');
  assert.deepEqual(forgotten.body.memories_used, []);
  assert.equal(env.mock.chats.at(-1).body.messages[0].content.includes(edited), false);
  assert.equal((await request(env, '/api/memories')).body.memories.length, 0);
  const status = await request(env, '/api/status');
  assert.deepEqual(status.body.memories, { pending: 0, approved: 0, forgotten: 1 });
});

test('reflection trusts only the user message and exposes a failed extraction for explicit retry', async t => {
  const env = await fixture(t);
  const userText = 'Моя долговременная цель: закончить проект Север.';
  const fabricated = 'ASSISTANT_ONLY_FAKE: пользователь уже закончил все проекты.';
  env.mock.state.onChat = async () => fabricated;
  let attempts = 0;
  env.mock.state.onReflection = async () => ++attempts === 1 ? 'invalid JSON from model' : JSON.stringify({ memories: [
    { kind: 'goal', content: 'Закончить проект Север.', importance: 8, confidence: 0.9 },
  ] });
  assert.equal((await chat(env, 'reflection-retry-001', userText)).status, 200);
  await turnState(env, 'reflection-retry-001', 'failed');
  const extraction = env.mock.reflections[0];
  assert.equal(reflectionUser(extraction), userText);
  assert.equal(extraction.body.messages.some(row => row.role === 'assistant'), false);
  assert.equal(JSON.stringify(extraction.body.messages).includes(fabricated), false);
  assert.equal(extraction.body.stream, false);
  assert.equal((await request(env, '/api/status')).body.reflection.failed, 1);
  const retry = await request(env, '/api/reflection/retry', { method: 'POST', body: {} });
  assert.equal(retry.body.count, 1);
  await turnState(env, 'reflection-retry-001', 'completed');
  const pending = (await request(env, '/api/memories?status=pending')).body.memories;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].source_turn_id, 'reflection-retry-001');
  assert.equal(env.mock.chats.length, 1);
  assert.equal((await request(env, '/api/history')).body.messages.length, 2);
});

test('new chat interrupts reflection, then the queued extraction resumes without duplicate memory', async t => {
  const env = await fixture(t);
  const gate = env.gate();
  let firstMessageAttempts = 0;
  env.mock.state.onReflection = async call => {
    if (reflectionUser(call) !== 'Проект Орион нужно продолжить.') return EMPTY_REFLECTION;
    if (++firstMessageAttempts === 1) await gate.promise;
    return JSON.stringify({ memories: [{ kind: 'project', content: 'Продолжить проект Орион.', importance: 7, confidence: 0.9 }] });
  };
  assert.equal((await chat(env, 'interrupt-memory-001', 'Проект Орион нужно продолжить.')).status, 200);
  await env.mock.waitForCall(call => call.path === '/api/chat' && call.body.format);
  await turnState(env, 'interrupt-memory-001', 'running');
  assert.equal((await chat(env, 'interrupt-memory-002', 'Новая задача важнее фоновой обработки.')).status, 200);
  await turnState(env, 'interrupt-memory-001', 'completed');
  await turnState(env, 'interrupt-memory-002', 'completed');
  gate.resolve();
  assert.equal(firstMessageAttempts, 2);
  assert.equal(env.mock.chats.length, 2);
  assert.equal((await request(env, '/api/memories?status=pending')).body.memories.length, 1);
  assert.equal((await request(env, '/api/history')).body.messages.length, 4);
});

test('restart recovers an extraction persisted as running without regenerating its chat answer', async t => {
  const env = await fixture(t);
  const gate = env.gate();
  let reflections = 0;
  env.mock.state.onReflection = async () => {
    if (++reflections === 1) await gate.promise;
    return JSON.stringify({ memories: [{ kind: 'task', content: 'Доделать проект Полюс.', importance: 7, confidence: 0.8 }] });
  };
  assert.equal((await chat(env, 'recovered-memory-001', 'Доделать проект Полюс.')).status, 200);
  await env.mock.waitForCall(call => call.path === '/api/chat' && call.body.format);
  await env.app.close();
  // Simulate the durable state left by a process termination during extraction.
  const database = new DatabaseSync(env.dbPath);
  database.prepare("UPDATE turns SET reflection_state='running' WHERE request_id=?").run('recovered-memory-001');
  database.close();
  await env.start();
  await turnState(env, 'recovered-memory-001', 'completed');
  gate.resolve();
  assert.equal(env.mock.chats.length, 1);
  assert.equal((await request(env, '/api/history')).body.messages.length, 2);
  assert.equal((await request(env, '/api/memories?status=pending')).body.memories.length, 1);
});

test('legacy database migration creates an intact backup once and preserves messages and memory statuses', async t => {
  const env = await fixture(t, { prepareDatabase(dbPath) {
    const database = new DatabaseSync(dbPath);
    database.exec(`
      CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, role TEXT NOT NULL, content TEXT NOT NULL);
      CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, kind TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL UNIQUE, importance INTEGER NOT NULL DEFAULT 5, confidence REAL NOT NULL DEFAULT 0.8, active INTEGER NOT NULL DEFAULT 1);
      INSERT INTO conversations(id,created_at,role,content) VALUES (21,'2026-09-04 10:20:00','user','Старая история.'),(22,'2026-09-04 10:20:10','assistant','Старый ответ.');
      INSERT INTO memories(id,content,active) VALUES (31,'Продолжить проект Вектор.',1),(32,'Забытый старый факт.',0);
    `);
    database.close();
  } });
  assert.ok(env.app.backupPath);
  assert.equal(existsSync(env.app.backupPath), true);
  const backup = new DatabaseSync(env.app.backupPath, { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 2);
    assert.equal(backup.prepare('PRAGMA table_info(memories)').all().some(row => row.name === 'status'), false);
    assert.equal(backup.prepare('PRAGMA table_info(conversations)').all().some(row => row.name === 'request_id'), false);
    assert.equal(backup.prepare('SELECT active FROM memories WHERE id=32').get().active, 0);
  } finally { backup.close(); }
  const before = (await request(env, '/api/history')).body.messages;
  assert.deepEqual(before.map(row => [row.id, row.role, row.content]), [[21, 'user', 'Старая история.'], [22, 'assistant', 'Старый ответ.']]);
  assert.deepEqual((await request(env, '/api/status')).body.memories, { pending: 0, approved: 1, forgotten: 1 });
  assert.deepEqual((await request(env, '/api/memories?status=approved')).body.memories.map(row => row.id), [31]);
  await env.restart();
  assert.equal(env.app.backupPath, null);
  // SQLite may create WAL/SHM companions while the read-only backup is open;
  // count actual snapshot files, not SQLite connection sidecars.
  assert.equal(readdirSync(join(env.directory, 'backups')).filter(name => name.endsWith('.sqlite')).length, 1);
  assert.deepEqual((await request(env, '/api/history')).body.messages, before);
});

test('HTTP boundaries reject malformed, oversized and foreign-origin requests and preserve chunked Cyrillic', async t => {
  const env = await fixture(t);
  const bad = [
    [{ rawBody: '{"message":', method: 'POST' }, 400, 'INVALID_REQUEST'],
    [{ body: [], method: 'POST' }, 400, 'INVALID_REQUEST'],
    [{ body: { request_id: 'boundary-id-001', message: 'x'.repeat(70_000) }, method: 'POST' }, 413, 'REQUEST_TOO_LARGE'],
    [{ rawBody: 'text', headers: { 'content-type': 'text/plain' }, method: 'POST' }, 415, 'INVALID_REQUEST'],
    [{ body: { request_id: 'boundary-id-001', message: 'Текст.' }, headers: { origin: 'https://foreign.example' }, method: 'POST' }, 403, 'ORIGIN_REJECTED'],
    [{ body: { request_id: 'boundary-id-001', message: 'Текст.' }, headers: { 'sec-fetch-site': 'cross-site' }, method: 'POST' }, 403, 'ORIGIN_REJECTED'],
    [{ rawBody: Buffer.from([0xc3, 0x28]), method: 'POST' }, 400, 'INVALID_REQUEST'],
  ];
  for (const [options, status, code] of bad) {
    const response = await request(env, '/api/chat', options);
    assert.equal(response.status, status);
    assert.equal(response.body.code, code);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
  const unknown = await request(env, '/api/not-a-route');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'NOT_FOUND');
  assert.equal(env.mock.chats.length, 0);
  const text = 'Братик, сохрани смысл: ёжик, Прага, Антарктида — 444.';
  const payload = Buffer.from(JSON.stringify({ request_id: 'chunked-utf8-001', message: text }), 'utf8');
  const split = payload.indexOf(Buffer.from('Б')) + 1; // Deliberately split a two-byte Cyrillic character.
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${env.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.write(payload.subarray(0, split));
    setImmediate(() => req.end(payload.subarray(split)));
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.message, text);
  assert.equal(env.mock.chats[0].body.messages.at(-1).content, text);
  assert.equal((await request(env, '/api/history')).body.messages[0].content, text);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = http.get(`${env.url}/api/status`, { headers: { host: 'foreign.example' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
  });
  assert.equal(foreignHost.status, 403);
  assert.equal(foreignHost.body.code, 'LOCAL_ONLY');
});

test('model settings reject absent, remote and incompatible models and persist the selected local model', async t => {
  const env = await fixture(t);
  env.mock.state.models = [{ name: `${MODEL}:latest` }, { name: 'local-second:latest' }, { name: 'embedding:latest' }, { name: 'remote:latest', remote_model: 'cloud' }];
  env.mock.state.onShow = async call => call.body.model.startsWith('embedding')
    ? { capabilities: ['embedding'], details: { family: 'test' } }
    : call.body.model.startsWith('remote')
      ? { remote_model: 'cloud', capabilities: ['completion'] }
      : { capabilities: ['completion'], details: { family: 'test' } };
  const missing = await request(env, '/api/settings', { method: 'POST', body: { model: 'not-installed' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'MODEL_MISSING');
  const unsupported = await request(env, '/api/settings', { method: 'POST', body: { model: 'embedding:latest' } });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.code, 'MODEL_UNSUPPORTED');
  const remote = await request(env, '/api/settings', { method: 'POST', body: { model: 'remote:latest' } });
  assert.equal(remote.status, 400);
  assert.equal(remote.body.code, 'REMOTE_MODEL_UNSUPPORTED');
  assert.equal((await request(env, '/api/status')).body.model, MODEL);
  const changed = await request(env, '/api/settings', { method: 'POST', body: { model: 'local-second:latest' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.model, 'local-second:latest');
  assert.equal(changed.body.ollama.ready, true);
  await env.restart();
  assert.equal((await request(env, '/api/status')).body.model, 'local-second:latest');
  assert.equal((await chat(env, 'changed-model-001', 'Какой ответ?')).status, 200);
  assert.equal(env.mock.chats[0].body.model, 'local-second:latest');
});

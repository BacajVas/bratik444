import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createOllama } from '../ollama.mjs';

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({path: req.url, body});
    const result = handler(req.url, body);
    res.writeHead(result.status || 200, {'content-type': 'application/json', ...result.headers});
    res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {client: createOllama({url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 500, statusTimeoutMs: 500}), requests};
}

test('cloud aliases are blocked by model metadata before any conversation leaves the app', async t => {
  const {client, requests} = await fixture(t, path => {
    if (path === '/api/tags') return {body: {models: [{name: 'friendly-name:latest'}]}};
    if (path === '/api/show') return {body: {remote_host: 'https://ollama.com', remote_model: 'model:cloud'}};
    return {body: {message: {content: 'must never be called'}}};
  });
  const status = await client.status('friendly-name:latest');
  assert.equal(status.ready, false);
  await assert.rejects(client.chat([{role: 'user', content: 'private fixture'}], {model: 'friendly-name:latest'}), {code: 'REMOTE_MODEL_UNSUPPORTED'});
  assert.equal(requests.filter(item => item.path === '/api/chat').length, 0);
  assert.ok(requests.every(item => !JSON.stringify(item.body).includes('private fixture')));
});

test('remote entries and embedding-only models cannot become a ready chat model', async t => {
  const {client} = await fixture(t, path => path === '/api/tags'
    ? {body: {models: [{name: 'remote:latest', remote_model: 'remote'}, {name: 'embedding:latest'}]}}
    : {body: {capabilities: ['embedding']}});
  const remote = await client.status('remote:latest');
  assert.equal(remote.ready, false);
  assert.deepEqual(remote.models.map(item => item.name), ['embedding:latest']);
  const embedding = await client.status('embedding:latest');
  assert.equal(embedding.ready, false);
  await assert.rejects(client.chat([], {model: 'embedding:latest'}), {code: 'MODEL_UNSUPPORTED'});
});

test('redirects from the local Ollama endpoint are not followed', async t => {
  const {client, requests} = await fixture(t, path => path === '/api/show'
    ? {status: 307, headers: {location: '/redirect-target'}, body: {}}
    : {body: {message: {content: 'unexpected'}}});
  await assert.rejects(client.chat([{role: 'user', content: 'not-forwarded'}], {model: 'local:latest'}), {code: 'OLLAMA_UNAVAILABLE'});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/show');
});

test('structured reflection is deterministic and empty model responses are explicit failures', async t => {
  let blank = false;
  const {client, requests} = await fixture(t, path => path === '/api/show'
    ? {body: {capabilities: ['completion']}}
    : {body: {message: {content: blank ? '   ' : '{"memories":[]}'}}});
  const format = {type: 'object'};
  assert.equal(await client.chat([{role: 'user', content: 'fixture'}], {model: 'local:latest', format}), '{"memories":[]}');
  const payload = requests.find(item => item.path === '/api/chat').body;
  assert.equal(payload.stream, false);
  assert.deepEqual(payload.format, format);
  assert.equal(payload.options.temperature, 0);
  blank = true;
  await assert.rejects(client.chat([], {model: 'local:latest'}), {code: 'EMPTY_RESPONSE'});
});

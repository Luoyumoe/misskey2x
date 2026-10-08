import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createStore } from '../src/db.js';
import { createService } from '../src/server.js';

function request(server, path, { method = 'GET', headers = {}, body } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: address.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP webhook authenticates, queues, deduplicates and exposes status', async () => {
  const store = createStore(':memory:');
  const published = [];
  const publisher = {
    async publishPlan(plan, state) {
      for (let index = 0; index < plan.units.length; index += 1) {
        state.published[index] = `tweet-${index + 1}`;
        published.push(plan.units[index].text);
      }
      return state;
    },
  };
  const service = createService({
    env: { MISSKEY_WEBHOOK_SECRET: 'shared-secret', REQUIRED_TAG: 'to_x' },
    store,
    publisher,
    logger: { info() {}, error() {} },
    queueIntervalMs: 60_000,
  });
  const server = http.createServer(service.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const health = await request(server, '/healthz');
    assert.equal(health.status, 200);

    const unauthorized = await request(server, '/webhooks/misskey', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 2 },
      body: '{}',
    });
    assert.equal(unauthorized.status, 401);

    const headers = {
      'content-type': 'application/json',
      'x-misskey-hook-secret': 'shared-secret',
    };
    const payload = JSON.stringify({ type: 'note', body: { id: 'n1', text: 'hello #to_x' } });
    const queued = await request(server, '/webhooks/misskey', { method: 'POST', headers, body: payload });
    assert.equal(queued.status, 202);
    assert.equal(JSON.parse(queued.body).action, 'queued');
    await service.drain();

    const duplicate = await request(server, '/webhooks/misskey', { method: 'POST', headers, body: payload });
    assert.equal(JSON.parse(duplicate.body).action, 'duplicate');
    const status = await request(server, '/webhooks/misskey/status?note_id=n1', { headers });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).status, 'completed');
    assert.equal(JSON.parse(status.body).published[0], 'tweet-1');
    assert.deepEqual(published, ['hello']);
  } finally {
    server.close();
    await service.stop();
  }
});

test('webhook rejects malformed and oversized requests', async () => {
  const store = createStore(':memory:');
  const service = createService({
    env: { MISSKEY_WEBHOOK_SECRET: 'secret' },
    store,
    publisher: { async publishPlan() {} },
    logger: { info() {}, error() {} },
    maxBodyBytes: 4,
  });
  const server = http.createServer(service.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const headers = { 'content-type': 'application/json', 'x-misskey-hook-secret': 'secret' };
    const malformed = await request(server, '/webhooks/misskey', { method: 'POST', headers, body: '{bad' });
    assert.equal(malformed.status, 400);
    const oversized = await request(server, '/webhooks/misskey', { method: 'POST', headers, body: '12345' });
    assert.equal(oversized.status, 413);
  } finally {
    server.close();
    await service.stop();
  }
});

test('non-note webhook events are acknowledged as ignored', async () => {
  const store = createStore(':memory:');
  const service = createService({
    env: { MISSKEY_WEBHOOK_SECRET: 'secret' },
    store,
    publisher: { async publishPlan() {} },
    logger: { info() {}, error() {} },
  });
  const server = http.createServer(service.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = JSON.stringify({ type: 'follow', body: {} });
    const result = await request(server, '/webhooks/misskey', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-misskey-hook-secret': 'secret' },
      body,
    });
    assert.equal(result.status, 202);
    assert.equal(JSON.parse(result.body).action, 'ignored');
  } finally {
    server.close();
    await service.stop();
  }
});

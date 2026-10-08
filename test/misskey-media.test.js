import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildSyncPlan,
  decideWebhook,
  normalizeControlTag,
  parseWebhook,
  removeControlTag,
  splitXText,
  weightedLength,
} from '../src/misskey.js';
import {
  fetchMedia,
  isPrivateAddress,
  isSupportedMediaFile,
  validateMediaUrl,
} from '../src/media.js';

test('parseWebhook accepts note envelope and rejects other event types', () => {
  const note = { id: 'n1', text: '#to_x hello' };
  assert.deepEqual(parseWebhook({ type: 'note', body: note }), note);
  assert.deepEqual(parseWebhook({ type: 'note', body: { note } }), note);
  assert.equal(parseWebhook({ type: 'mention', body: note }), null);
  assert.equal(parseWebhook({ type: 'note', body: {} }), null);
});

test('tag matching is case insensitive and URL fragments do not trigger', () => {
  assert.equal(normalizeControlTag('##TO_X'), 'to_x');
  assert.equal(decideWebhook({ type: 'note', body: { id: 'n1', text: 'https://x.test/#to_x' } }).action, 'ignored');
  assert.equal(decideWebhook({ type: 'note', body: { id: 'n2', text: 'hello #TO_X' } }).action, 'queue');
  assert.equal(decideWebhook({ type: 'note', body: { id: 'n3', text: 'hello', tags: ['TO_X'] } }).action, 'queue');
});

test('replies, renotes and quotes are ignored', () => {
  for (const extra of [{ replyId: 'r' }, { renoteId: 'r' }, { quoteId: 'q' }, { reply: {} }, { renote: {} }]) {
    const decision = decideWebhook({ type: 'note', body: { id: `n-${Object.keys(extra)[0]}`, text: '#to_x', ...extra } });
    assert.equal(decision.action, 'ignored');
    assert.equal(decision.reason, 'not_original');
  }
});

test('control tag removed, other tags and URL fragments preserved; CW prefixed', () => {
  const text = 'hello #to_x #other https://x.test/#to_x';
  assert.equal(removeControlTag(text), 'hello  #other https://x.test/#to_x');
  const plan = buildSyncPlan({ id: 'n1', text, tags: ['to_x'], cw: 'sensitive' });
  assert.equal(plan.accepted, true);
  assert.equal(plan.text, 'CW: sensitive\n\nhello  #other https://x.test/#to_x');
  assert.equal(plan.units.length, 1);
  assert.deepEqual(plan.units[0].files, []);
});

test('X weighted length counts URL as 23 and CJK/emoji as 2', () => {
  assert.equal(weightedLength('abc'), 3);
  assert.equal(weightedLength('中😀'), 4);
  assert.equal(weightedLength('https://example.test/a-long-path'), 23);
});

test('splitXText keeps URLs and grapheme clusters intact', () => {
  const chunks = splitXText(`prefix ${'a'.repeat(275)} https://example.test/x`);
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /https:\/\/example\.test\/x$/u);
  assert.equal(chunks.join(''), `prefix ${'a'.repeat(275)} https://example.test/x`);
  assert.deepEqual(splitXText('👨‍👩‍👧‍👦', 2), ['👨‍👩‍👧‍👦']);
  assert.throws(() => splitXText('a', 0), /positive integer/);
});

test('buildSyncPlan exposes publish units with media on first unit', () => {
  const files = [{ id: 'f1', url: 'https://media.example/f1.jpg', type: 'image/jpeg' }];
  const plan = buildSyncPlan({ id: 'n1', text: '#to_x hello', tags: ['to_x'], files });
  assert.deepEqual(plan.units, [{ text: 'hello', files }]);
});

test('buildSyncPlan groups four static images and isolates GIFs', () => {
  const files = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, url: `https://media.example/${index}.png`, type: 'image/png' })),
    { id: 'g', url: 'https://media.example/a.gif', type: 'image/gif' },
  ];
  const plan = buildSyncPlan({ id: 'n2', text: '#to_x body', files });
  assert.deepEqual(plan.units.map((unit) => unit.files.map((file) => file.id)), [
    ['p0', 'p1', 'p2', 'p3'],
    ['p4'],
    ['g'],
  ]);
});

test('media URL validation enforces HTTPS, credentials, allowlist and DNS SSRF', async () => {
  await assert.rejects(validateMediaUrl('http://public.example/a'), /HTTPS/);
  await assert.rejects(validateMediaUrl('https://user:pass@public.example/a'), /credentials/);
  await assert.rejects(validateMediaUrl('https://public.example/a', {
    allowedHosts: ['media.example'],
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  }), /MEDIA_ALLOWED_HOSTS/);
  await assert.rejects(validateMediaUrl('https://public.example/a', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }), /private/);
  const target = await validateMediaUrl('https://media.example/a', {
    allowedHosts: ['media.example'],
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  });
  assert.equal(target.hostname, 'media.example');
});

test('private and reserved address checks cover IPv4, IPv6 and mapped IPv4', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('192.168.1.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
});

function fakeResponse({ statusCode = 200, contentType = 'image/png', chunks = [] } = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = { 'content-type': contentType };
  response.resume = () => {};
  response.emitBody = () => {
    for (const chunk of chunks) response.emit('data', chunk);
    response.emit('end');
  };
  return response;
}

function fakeRequest(response) {
  const request = new EventEmitter();
  request.setTimeout = () => {};
  request.destroy = (error) => {
    if (error) request.emit('error', error);
  };
  request.end = () => queueMicrotask(() => response.emitBody());
  return request;
}

function fakeRequestImpl({ statusCode = 200, contentType = 'image/png', chunks = [] } = {}) {
  return (_url, _options, callback) => {
    const response = fakeResponse({ statusCode, contentType, chunks });
    const request = fakeRequest(response);
    queueMicrotask(() => callback(response));
    return request;
  };
}

test('fetchMedia rejects redirects and validates image magic bytes', async () => {
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  await assert.rejects(fetchMedia('https://media.example/redirect', {
    lookup,
    requestImpl: fakeRequestImpl({ statusCode: 302, chunks: [] }),
  }), /redirects/);

  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const media = await fetchMedia('https://media.example/a.png', {
    lookup,
    requestImpl: fakeRequestImpl({ chunks: [png] }),
  });
  assert.equal(media.contentType, 'image/png');
  assert.equal(media.size, png.length);
});

test('media type helper requires supported image MIME', () => {
  assert.equal(isSupportedMediaFile({ type: 'image/jpeg' }), true);
  assert.equal(isSupportedMediaFile({ type: 'video/mp4' }), false);
  assert.equal(isSupportedMediaFile({}), false);
});

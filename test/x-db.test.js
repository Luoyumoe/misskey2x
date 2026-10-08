import assert from 'node:assert/strict';
import test from 'node:test';

import { createStore } from '../src/db.js';
import { createPublisher, RettiwtError } from '../src/x.js';

test('SQLite queue deduplicates, claims, persists state and retries', () => {
  const store = createStore(':memory:');
  const note = { id: 'note-1', text: '#to_x hello' };
  assert.equal(store.insertJob(note).inserted, true);
  assert.equal(store.insertJob(note).inserted, false);
  const job = store.claimNextJob(Date.now());
  assert.equal(job.attempts, 1);
  assert.equal(job.status, 'processing');
  store.saveState(job.id, { published: { 0: 'tweet-1' }, media: {} });
  store.markRetry(job.id, 1, 'temporary', Date.now() - 1, { published: { 0: 'tweet-1' }, media: {} });
  assert.equal(store.claimNextJob(Date.now()).attempts, 2);
  store.close();
});

test('Rettiwt publisher uploads media and chains replies', async () => {
  const calls = [];
  const logs = [];
  let mediaCounter = 0;
  let tweetCounter = 0;
  const publisher = createPublisher({
    client: {
      tweet: {
        async upload(bytes) {
          calls.push(['upload', bytes.byteLength]);
          return `media-${++mediaCounter}`;
        },
        async post(options) {
          calls.push(['post', options]);
          return `tweet-${++tweetCounter}`;
        },
      },
    },
    mediaFetcher: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
    logger: { info(line) { logs.push(JSON.parse(line)); }, warn(line) { logs.push(JSON.parse(line)); } },
  });
  const state = await publisher.publishPlan({
    units: [
      { text: 'first', files: [{ id: 'file-1', url: 'https://media.test/one.png', type: 'image/png' }] },
      { text: 'second', files: [] },
    ],
  });
  assert.equal(state.published[0], 'tweet-1');
  assert.equal(state.published[1], 'tweet-2');
  assert.equal(calls[0][0], 'upload');
  assert.deepEqual(calls[1][1].media, [{ id: 'media-1' }]);
  assert.equal(calls[2][1].replyTo, 'tweet-1');
  assert.deepEqual(
    logs.filter((entry) => entry.event).map((entry) => entry.event),
    ['x_publish_started', 'x_media_upload_started', 'x_media_uploaded', 'x_publish_completed', 'x_publish_started', 'x_publish_completed'],
  );
  assert.equal(logs.find((entry) => entry.event === 'x_publish_started').text, 'first');
  assert.equal(logs.find((entry) => entry.event === 'x_publish_completed').tweetId, 'tweet-1');
});

test('Rettiwt errors classify transient statuses', () => {
  assert.equal(new RettiwtError('busy', { status: 429 }).retryable, true);
  assert.equal(new RettiwtError('bad auth', { status: 401 }).retryable, false);
});

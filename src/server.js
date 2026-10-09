import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './db.js';
import {
  buildSyncPlan,
  decideWebhook,
} from './misskey.js';
import { logEvent } from './log.js';
import { createPublisher, isRetryableError } from './x.js';

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_PORT = 3000;
const DEFAULT_QUEUE_INTERVAL_MS = 1000;
const MAX_BATCH_SIZE = 10;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function authorized(request, secret) {
  if (!secret) return false;
  return constantTimeEqual(request.headers['x-misskey-hook-secret'] || '', secret);
}

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function readRequestBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers['content-length'] || 0);
    if (declaredLength > limit) {
      reject(Object.assign(new Error('request_body_too_large'), { code: 'BODY_TOO_LARGE' }));
      request.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('request_body_too_large'), { code: 'BODY_TOO_LARGE' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', fail);
  });
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('invalid_json'), { code: 'INVALID_JSON' });
  }
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function errorText(error) {
  return String(error?.message || error || 'unknown error').slice(0, 4000);
}

function retryDelayMs(attempts, retryAfterMs = 0) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(60 * 60 * 1000, retryAfterMs);
  }
  return Math.min(60 * 60 * 1000, 1000 * 60 * 2 ** Math.max(0, attempts - 1));
}

function isoAfter(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function normalizeStatus(row) {
  if (!row) return null;
  const state = safeJson(row.state_json ?? row.state, { published: {}, media: {} });
  return {
    noteId: row.id ?? row.note_id,
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || null,
    published: state.published || {},
    media: state.media || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null,
  };
}

function createLogger(logger = console) {
  const call = (level) => (...args) => (logger[level] || logger.info || logger.log || (() => {}))(...args);
  return {
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
  };
}

function noteLogFields(note) {
  if (!note || typeof note !== 'object') return { noteId: null, text: null, cw: null, media: [] };
  return {
    noteId: typeof note.id === 'string' ? note.id : null,
    text: typeof note.text === 'string' ? note.text : '',
    cw: typeof note.cw === 'string' ? note.cw : null,
    media: Array.isArray(note.files)
      ? note.files.map((file) => ({
        id: file?.id ?? file?.name ?? null,
        type: file?.type ?? file?.mimeType ?? null,
      }))
      : [],
  };
}

function planLogFields(plan) {
  return {
    text: typeof plan?.text === 'string' ? plan.text : '',
    units: Array.isArray(plan?.units)
      ? plan.units.map((unit) => ({
        text: typeof unit?.text === 'string' ? unit.text : '',
        mediaCount: Array.isArray(unit?.files) ? unit.files.length : 0,
      }))
      : [],
  };
}

/**
 * Create an injectable service. Tests can provide an in-memory-compatible
 * store and publisher without opening a listening socket or contacting X.
 */
export function createService({
  env = process.env,
  store = null,
  publisher = null,
  logger = console,
  maxBodyBytes = MAX_BODY_BYTES,
  queueIntervalMs = null,
} = {}) {
  const log = createLogger(logger);
  const config = {
    port: parsePositiveInteger(env.PORT, DEFAULT_PORT, 65535),
    secret: String(env.MISSKEY_WEBHOOK_SECRET || ''),
    requiredTag: String(env.REQUIRED_TAG || 'to_x'),
    queueIntervalMs: parsePositiveInteger(
      queueIntervalMs ?? env.QUEUE_INTERVAL_MS,
      DEFAULT_QUEUE_INTERVAL_MS,
      60_000,
    ),
  };
  const jobStore = store || createStore(env.DATABASE_PATH || '/data/misskey-to-x.sqlite');
  const xPublisher = publisher || createPublisher({
    apiKey: env.API_KEY,
    logging: String(env.RETTIWT_LOGGING || '').toLowerCase() === 'true',
    mediaAllowedHosts: env.MEDIA_ALLOWED_HOSTS,
    logger: log,
  });

  let timer = null;
  let draining = false;
  let stopped = false;

  async function processJob(job) {
    const state = safeJson(job.state_json ?? job.state, { published: {}, media: {} });
    state.published ||= {};
    state.media ||= {};
    let plan = safeJson(job.plan_json ?? job.plan, null);

    try {
      const note = safeJson(job.note_json ?? job.note, null);
      if (!note) throw new Error('stored_note_is_invalid');
      if (!plan) {
        plan = buildSyncPlan(note, { requiredTag: config.requiredTag });
        if (typeof jobStore.savePlanAndState === 'function') {
          await jobStore.savePlanAndState(job.id, plan, state);
        } else {
          await jobStore.saveState(job.id, state);
        }
      }

      logEvent(log, 'forward_started', {
        ...noteLogFields(note),
        ...planLogFields(plan),
        attempts: Number(job.attempts || 1),
      });

      const finalState = await xPublisher.publishPlan(plan, state, async (nextState) => {
        await jobStore.saveState(job.id, nextState);
      });
      await jobStore.markCompleted(job.id, finalState || state);
      logEvent(log, 'forward_completed', {
        noteId: note.id,
        ...planLogFields(plan),
        attempts: Number(job.attempts || 1),
        published: (finalState || state).published || {},
        media: (finalState || state).media || {},
      });
    } catch (error) {
      // claimNextJob increments attempts before handing job to worker.
      const attempts = Number(job.attempts || 1);
      const retryable = isRetryableError(error);
      const retryAfterMs = Number(error?.retryAfterMs || 0);
      const message = errorText(error);
      const note = safeJson(job.note_json ?? job.note, null);
      const commonFields = {
        ...noteLogFields(note),
        ...planLogFields(plan),
        noteId: job.id,
        attempts,
        retryable,
        message,
        causeName: error?.cause?.name ?? null,
        errorCode: error?.code ?? error?.cause?.code ?? null,
        httpStatus: error?.status ?? error?.cause?.status ?? error?.cause?.response?.status ?? null,
        errorDetails: error?.details ?? null,
      };
      if (retryable && attempts < 5) {
        const nextRetryAt = isoAfter(retryDelayMs(attempts, retryAfterMs));
        await jobStore.markRetry(
          job.id,
          attempts,
          message,
          Date.parse(nextRetryAt),
          state,
        );
        logEvent(log, 'forward_retry_scheduled', { ...commonFields, nextRetryAt });
      } else {
        await jobStore.markDead(job.id, message, state);
        logEvent(log, 'forward_failed', { ...commonFields, final: true });
      }
    }
  }

  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      for (let count = 0; count < MAX_BATCH_SIZE; count += 1) {
        const job = await jobStore.claimNextJob(new Date().toISOString());
        if (!job) break;
        await processJob(job);
      }
    } catch (error) {
      log.error(JSON.stringify({ scope: 'drain', message: errorText(error) }));
    } finally {
      draining = false;
    }
  }

  async function authenticate(request, response) {
    if (!config.secret) {
      json(response, 500, { error: 'missing_webhook_secret' });
      return false;
    }
    if (!authorized(request, config.secret)) {
      json(response, 401, { error: 'invalid_webhook_secret' });
      return false;
    }
    return true;
  }

  async function handleWebhook(request, response) {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const contentType = String(request.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      json(response, 415, { error: 'content_type_must_be_json' });
      return;
    }
    if (!(await authenticate(request, response))) return;

    let envelope;
    try {
      envelope = parseJsonBody(await readRequestBody(request, maxBodyBytes));
    } catch (error) {
      if (error.code === 'BODY_TOO_LARGE') {
        json(response, 413, { error: 'request_body_too_large' });
      } else {
        json(response, 400, { error: 'invalid_json' });
      }
      return;
    }

    const decision = decideWebhook(envelope, config.requiredTag);
    logEvent(log, 'webhook_received', {
      eventType: envelope?.type ?? null,
      action: decision.action,
      reason: decision.reason ?? null,
      ...noteLogFields(decision.note),
    });
    if (decision.action === 'invalid_note') {
      json(response, 400, { error: 'invalid_note' });
      return;
    }
    if (decision.action !== 'queue') {
      logEvent(log, 'webhook_ignored', {
        eventType: envelope?.type ?? null,
        reason: decision.reason ?? null,
        ...noteLogFields(decision.note),
      });
      json(response, 202, { action: decision.action });
      return;
    }

    // Keep original text, including control tag, in storage. buildSyncPlan
    // removes control tag when creating X-facing units; retaining it makes
    // retries deterministic and keeps the persisted Misskey payload auditable.
    const note = decision.note;
    try {
      const result = await jobStore.insertJob(note);
      if (!result.inserted) {
        logEvent(log, 'webhook_duplicate', {
          ...noteLogFields(note),
          ...planLogFields(decision.plan),
        });
        json(response, 202, { action: 'duplicate', noteId: note.id });
        return;
      }
      logEvent(log, 'webhook_queued', {
        ...noteLogFields(note),
        ...planLogFields(decision.plan),
      });
      void drain();
      json(response, 202, { action: 'queued', noteId: note.id });
    } catch (error) {
      logEvent(log, 'webhook_queue_failed', {
        ...noteLogFields(note),
        message: errorText(error),
      }, 'error');
      json(response, 500, { error: 'queue_unavailable' });
    }
  }

  async function handleStatus(request, response, url) {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (!(await authenticate(request, response))) return;
    const noteId = url.searchParams.get('note_id');
    if (!noteId) {
      json(response, 400, { error: 'missing_note_id' });
      return;
    }
    const row = await jobStore.getJob(noteId);
    if (!row) {
      json(response, 404, { error: 'job_not_found' });
      return;
    }
    json(response, 200, normalizeStatus(row));
  }

  async function handler(request, response) {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === '/webhooks/misskey') {
        await handleWebhook(request, response);
        return;
      }
      if (url.pathname === '/webhooks/misskey/status') {
        await handleStatus(request, response, url);
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      logEvent(log, 'http_error', { message: errorText(error) }, 'error');
      if (!response.headersSent) json(response, 500, { error: 'internal_error' });
      else response.destroy();
    }
  }

  async function start() {
    if (typeof jobStore.recoverProcessing === 'function') {
      await jobStore.recoverProcessing(Date.now());
    }
    stopped = false;
    timer = setInterval(() => void drain(), config.queueIntervalMs);
    timer.unref?.();
    void drain();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (typeof jobStore.close === 'function') await jobStore.close();
  }

  return {
    config,
    handler,
    start,
    stop,
    drain,
    store: jobStore,
    publisher: xPublisher,
  };
}

export async function startServer(options = {}) {
  const service = createService(options);
  const server = http.createServer(service.handler);
  await service.start();
  await new Promise((resolve) => server.listen(service.config.port, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : service.config.port;
  logEvent(options.logger || console, 'server_started', { port });

  const shutdown = async () => {
    server.close();
    await service.stop();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { server, service };
}

const entryPath = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;
if (entryPath) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export const __testables = {
  constantTimeEqual,
  parsePositiveInteger,
  retryDelayMs,
  normalizeStatus,
};

import { fetchMedia, SUPPORTED_MEDIA_TYPES } from './media.js';

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ENETUNREACH',
]);

export class RettiwtError extends Error {
  constructor(message, { status, retryable, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RettiwtError';
    this.status = Number.isFinite(Number(status)) ? Number(status) : undefined;
    this.retryable = retryable ?? isRetryableError({ status: this.status, cause });
  }
}

function errorStatus(error) {
  return Number(error?.status ?? error?.response?.status ?? error?.cause?.status);
}

export function isRetryableError(error) {
  if (!error) return false;
  if (typeof error.retryable === 'boolean') return error.retryable;
  const status = errorStatus(error);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  if (status >= 400) return false;
  const code = error.code || error.cause?.code;
  return RETRYABLE_CODES.has(code);
}

function toArrayBuffer(file) {
  if (file instanceof ArrayBuffer) return file;
  if (ArrayBuffer.isView(file)) {
    return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  }
  if (file?.data instanceof ArrayBuffer) return file.data;
  if (ArrayBuffer.isView(file?.data)) {
    return file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength);
  }
  if (file?.buffer instanceof ArrayBuffer) return file.buffer;
  if (ArrayBuffer.isView(file?.buffer)) {
    return file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength);
  }
  return file;
}

function mediaKey(file, unitIndex, fileIndex) {
  return String(file?.key ?? file?.mediaKey ?? file?.id ?? file?.misskeyId ?? file?.url ?? `${unitIndex}:${fileIndex}`);
}

function postedId(result) {
  if (typeof result === 'string' || typeof result === 'number') return String(result);
  return result?.id_str || result?.id || result?.tweetId || result?.rest_id;
}

async function loadRettiwt(apiKey, logging) {
  const module = await import('rettiwt-api');
  const Rettiwt = module.Rettiwt || module.default?.Rettiwt || module.default;
  if (typeof Rettiwt !== 'function') throw new Error('Rettiwt-API export Rettiwt not found');
  return new Rettiwt({ apiKey, logging });
}

function wrapError(error) {
  if (error instanceof RettiwtError) return error;
  const status = errorStatus(error);
  const message = error?.message || String(error);
  return new RettiwtError(message, {
    status: Number.isFinite(status) ? status : undefined,
    retryable: isRetryableError(error),
    cause: error,
  });
}

/**
 * Adapter around Rettiwt-API. `client` is injectable for tests and local
 * verification; production uses lazy import so health checks do not need to
 * load the package until a queued note is actually published.
 */
export function createPublisher({
  apiKey = process.env.API_KEY,
  logging = false,
  client,
  mediaAllowedHosts = process.env.MEDIA_ALLOWED_HOSTS || '',
  mediaFetcher = fetchMedia,
  logger = console,
} = {}) {
  if (!client && !apiKey) throw new Error('API_KEY is required');
  let instance = client;

  async function getClient() {
    if (!instance) instance = await loadRettiwt(apiKey, logging);
    if (!instance?.tweet || typeof instance.tweet.post !== 'function') {
      throw new Error('Rettiwt client does not expose tweet.post');
    }
    return instance;
  }

  async function upload(file) {
    const rettiwt = await getClient();
    if (file?.xMediaId) return String(file.xMediaId);
    if (typeof file === 'string') return String(await rettiwt.tweet.upload(file));
    let source;
    if (file?.bytes || file?.data) {
      source = file;
    } else if (file?.url) {
      try {
        source = await mediaFetcher(file.url, { allowedHosts: mediaAllowedHosts });
      } catch (error) {
        error.mediaSkip = true;
        throw error;
      }
    } else {
      source = file;
    }
    return String(await rettiwt.tweet.upload(toArrayBuffer(source?.bytes || source)));
  }

  async function publishPlan(plan, initialState = {}, saveState) {
    const state = initialState && typeof initialState === 'object'
      ? initialState
      : {};
    state.published ||= {};
    state.media ||= {};
    const units = Array.isArray(plan?.units) ? plan.units : [];
    let previousId = plan?.replyTo ? String(plan.replyTo) : undefined;

    // Upload and post each unit in order. Persist after every side effect so a
    // retry never needs to repeat an already successful upload or post.
    for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
      const unit = units[unitIndex] || {};
      if (state.published[unitIndex]) {
        previousId = String(state.published[unitIndex]);
        continue;
      }

      const mediaIds = [];
      const files = Array.isArray(unit.files) ? unit.files : [];
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex];
        const declaredType = String(file?.type || file?.mimeType || '').toLowerCase().split(';', 1)[0];
        if (declaredType && !SUPPORTED_MEDIA_TYPES.includes(declaredType)) continue;
        const isBinary = file instanceof ArrayBuffer || ArrayBuffer.isView(file);
        if (!file || (typeof file !== 'string' && !isBinary && !file.url && !file.bytes && !file.data && !file.buffer)) continue;
        const key = mediaKey(file, unitIndex, fileIndex);
        const existing = state.media[key];
        if (existing?.skipped) continue;
        let id = typeof existing === 'string' ? existing : existing?.id;
        if (!id) {
          try {
            id = await upload(file);
          } catch (error) {
            // Unsupported, unavailable or unsafe Misskey media must not block text.
            // Rettiwt failures remain retryable and surface to queue worker.
            if (error.mediaSkip) {
              state.media[key] = { skipped: true, error: String(error.message || error).slice(0, 500) };
              if (typeof saveState === 'function') await saveState(state);
              logger.warn?.(`Skipping Misskey media ${key}: ${error.message}`);
              continue;
            }
            throw wrapError(error);
          }
        }
        state.media[key] = id;
        mediaIds.push({ id });
        if (typeof saveState === 'function') await saveState(state);
      }

      const options = { text: String(unit.text ?? '') };
      if (mediaIds.length) options.media = mediaIds;
      const replyTo = unit.replyTo ?? previousId;
      if (replyTo) options.replyTo = String(replyTo);
      let result;
      try {
        result = await (await getClient()).tweet.post(options);
      } catch (error) {
        throw wrapError(error);
      }
      const id = postedId(result);
      if (!id) throw new RettiwtError('Rettiwt returned no tweet ID', { retryable: true });
      state.published[unitIndex] = id;
      previousId = id;
      if (typeof saveState === 'function') await saveState(state);
    }
    return state;
  }

  async function publishUnit({ text = '', files = [], replyTo } = {}) {
    const state = await publishPlan({ units: [{ text, files, replyTo }] }, { published: {}, media: {} });
    return state.published[0];
  }

  return { publishPlan, publishUnit, upload };
}

export default createPublisher;

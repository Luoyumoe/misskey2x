/**
 * Misskey webhook payload and X text helpers.
 *
 * This module deliberately has no network or database dependency.  The server
 * can therefore validate and prepare a note before handing it to its queue.
 */

export const DEFAULT_REQUIRED_TAG = 'to_x';
export const X_TEXT_LIMIT = 280;
export const X_URL_WEIGHT = 23;
export const SUPPORTED_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const URL_TRAILING_PUNCTUATION = /[.,!?;:)}\]>]+$/u;

function isObject(value) {
  return value !== null && typeof value === 'object';
}

/**
 * Normalize a configured or received hashtag.
 *
 * Misskey's `tags` array normally contains names without '#', while note text
 * contains the prefix.  Accept both forms and compare case-insensitively.
 */
export function normalizeControlTag(value = DEFAULT_REQUIRED_TAG) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^#+/u, '').toLocaleLowerCase();
}

function hashtagNames(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  // URL fragments can contain strings such as `https://host/#to_x`; remove
  // URL spans from the searchable text, while keeping their offsets irrelevant
  // because this function only returns names.
  const withoutUrls = text.replace(URL_PATTERN, ' ');
  const names = [];
  const pattern = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_-]+)/gu;
  for (const match of withoutUrls.matchAll(pattern)) {
    names.push(match[2].toLocaleLowerCase());
  }
  return names;
}

function noteTagNames(note) {
  if (!Array.isArray(note?.tags)) return [];
  return note.tags
    .map((tag) => (typeof tag === 'string' ? tag : tag?.name))
    .filter((tag) => typeof tag === 'string')
    .map((tag) => normalizeControlTag(tag))
    .filter(Boolean);
}

function hasRequiredTag(note, requiredTag) {
  const tag = normalizeControlTag(requiredTag);
  if (!tag) return false;
  if (noteTagNames(note).includes(tag)) return true;
  return hashtagNames(note?.text).includes(tag);
}

function isNonOriginalNote(note) {
  return Boolean(
    note?.replyId ||
      note?.renoteId ||
      note?.quoteId ||
      note?.reply ||
      note?.renote ||
      note?.quote,
  );
}

function mediaGroups(files) {
  const groups = [];
  let staticGroup = [];
  for (const file of Array.isArray(files) ? files : []) {
    const type = String(file?.type || file?.mimeType || '').split(';', 1)[0].toLowerCase();
    if (!SUPPORTED_IMAGE_TYPES.includes(type) || !file?.url) continue;
    const normalized = { ...file, type };
    if (type === 'image/gif') {
      if (staticGroup.length) groups.push(staticGroup);
      staticGroup = [];
      groups.push([normalized]);
    } else {
      staticGroup.push(normalized);
      if (staticGroup.length === 4) {
        groups.push(staticGroup);
        staticGroup = [];
      }
    }
  }
  if (staticGroup.length) groups.push(staticGroup);
  return groups;
}

/**
 * Parse Misskey's standard webhook envelope.
 *
 * A note webhook usually has `{ type: 'note', body: <note> }`.  Some Misskey
 * versions wrap the note once more as `{ body: { note: <note> } }`; both forms
 * are accepted.  Unsupported event types and malformed bodies return null so
 * callers can answer with an ignored 202 instead of treating them as jobs.
 */
export function parseWebhook(payload) {
  if (!isObject(payload) || payload.type !== 'note') return null;
  const body = payload.body;
  const note = isObject(body?.note) ? body.note : body;
  if (!isObject(note) || typeof note.id !== 'string' || note.id.length === 0) {
    return null;
  }
  return note;
}

/**
 * Decide whether webhook envelope should enter queue.  `server.js` uses this
 * small decision object to keep HTTP handling separate from note preparation.
 */
export function decideWebhook(payload, requiredTag = DEFAULT_REQUIRED_TAG) {
  if (!isObject(payload) || payload.type !== 'note') {
    return { action: 'ignored', reason: 'not_note' };
  }
  const note = parseWebhook(payload);
  if (!note) return { action: 'invalid_note', reason: 'invalid_note' };
  const plan = buildSyncPlan(note, { requiredTag });
  if (!plan.accepted) return { action: 'ignored', reason: plan.reason, note };
  return { action: 'queue', note, plan };
}

/**
 * Remove an exact control hashtag from note text, without touching URL
 * fragments.  Other hashtags, punctuation and line breaks stay intact.
 */
export function removeControlTag(text, requiredTag = DEFAULT_REQUIRED_TAG) {
  if (isObject(text)) {
    return { ...text, text: removeControlTag(text.text ?? '', requiredTag) };
  }
  if (typeof text !== 'string' || text.length === 0) return '';
  const tag = normalizeControlTag(requiredTag);
  if (!tag) return text;

  let cursor = 0;
  let output = '';
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = match[0];
    output += replaceControlTagInPlainText(text.slice(cursor, start), tag);
    output += url;
    cursor = start + url.length;
  }
  output += replaceControlTagInPlainText(text.slice(cursor), tag);

  // Removing a standalone control tag can leave an otherwise surprising
  // trailing space.  Preserve internal whitespace, normalize only the edges.
  return output.trim();
}

function replaceControlTagInPlainText(text, tag) {
  const escaped = tag.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  return text.replace(
    new RegExp(`(^|[^\\p{L}\\p{N}_])#${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'giu'),
    '$1',
  );
}

function isWideGrapheme(grapheme) {
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (
      (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
      (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3ffff)
    ) {
      return true;
    }
  }
  return false;
}

function graphemeWeight(grapheme) {
  return isWideGrapheme(grapheme) ? 2 : 1;
}

/**
 * Calculate X's practical weighted length for a prepared text fragment.
 * URLs count as 23 characters, CJK/emoji graphemes as 2, other graphemes as 1.
 */
export function weightedLength(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return tokenizeForX(text).reduce((total, token) => total + token.weight, 0);
}

function weightedPlainText(text) {
  if (!text) return 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let length = 0;
  for (const { segment } of segmenter.segment(text)) length += graphemeWeight(segment);
  return length;
}

function tokenizeForX(text) {
  const tokens = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    tokens.push(...graphemeTokens(text.slice(cursor, start)));

    // Keep punctuation after URLs as independent graphemes.  This preserves
    // natural sentence punctuation while guaranteeing URL itself stays intact.
    const rawUrl = match[0];
    const punctuation = rawUrl.match(URL_TRAILING_PUNCTUATION)?.[0] ?? '';
    const url = punctuation ? rawUrl.slice(0, -punctuation.length) : rawUrl;
    if (url) tokens.push({ value: url, weight: X_URL_WEIGHT, url: true });
    if (punctuation) tokens.push(...graphemeTokens(punctuation));
    cursor = start + rawUrl.length;
  }
  tokens.push(...graphemeTokens(text.slice(cursor)));
  return tokens;
}

function graphemeTokens(text) {
  if (!text) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), ({ segment }) => ({
    value: segment,
    weight: graphemeWeight(segment),
    url: false,
  }));
}

/**
 * Split text into X-sized fragments.  URLs and grapheme clusters are atomic.
 * A single URL is allowed to occupy its own chunk even when its source length
 * exceeds the limit because X counts it as `X_URL_WEIGHT`.
 */
export function splitXText(text, limit = X_TEXT_LIMIT) {
  if (typeof text !== 'string' || text.length === 0) return [];
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer');

  const chunks = [];
  let current = '';
  let currentWeight = 0;
  for (const token of tokenizeForX(text)) {
    if (current && currentWeight + token.weight > limit) {
      chunks.push(current.trim());
      current = '';
      currentWeight = 0;
    }
    current += token.value;
    currentWeight += token.weight;
  }
  if (current) chunks.push(current.trim());
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Build immutable data consumed by queue/X layers.
 *
 * Return shape always includes `accepted`; ignored notes carry a stable
 * `reason` and no publish fields.
 */
export function buildSyncPlan(note, { requiredTag = DEFAULT_REQUIRED_TAG } = {}) {
  if (!isObject(note) || typeof note.id !== 'string' || note.id.length === 0) {
    return { accepted: false, reason: 'invalid_note' };
  }
  if (isNonOriginalNote(note)) return { accepted: false, reason: 'not_original' };
  if (!hasRequiredTag(note, requiredTag)) return { accepted: false, reason: 'missing_tag' };

  const cleanText = removeControlTag(note.text ?? '', requiredTag);
  const withWarning = typeof note.cw === 'string' && note.cw.trim()
    ? `CW: ${note.cw.trim()}${cleanText ? `\n\n${cleanText}` : ''}`
    : cleanText;
  const chunks = splitXText(withWarning);
  const groups = mediaGroups(note.files);
  if (!chunks.length && !groups.length) return { accepted: false, reason: 'empty_content' };
  const textChunks = chunks.length > 0 ? chunks : [''];
  const units = textChunks.map((text, index) => ({ text, files: index === 0 ? (groups[0] || []) : [] }));
  for (const group of groups.slice(1)) units.push({ text: '', files: group });
  return {
    accepted: true,
    noteId: note.id,
    text: withWarning,
    chunks: chunks.length > 0 ? chunks : [''],
    units,
    files: groups.flat(),
    visibility: note.visibility,
  };
}

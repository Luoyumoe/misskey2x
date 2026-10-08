import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_MEDIA_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Return whether a Misskey file advertises one of the supported image types. */
export function isSupportedMediaFile(file) {
  const type = normalizeContentType(file?.type || file?.mimeType);
  return SUPPORTED_MEDIA_TYPES.includes(type);
}

const TYPE_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
]);

function normalizeContentType(value) {
  const mediaType = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return TYPE_ALIASES.get(mediaType) ?? mediaType;
}

function parseAllowedHosts(allowedHosts) {
  if (typeof allowedHosts === 'string') {
    return allowedHosts
      .split(',')
      .map((host) => host.trim().toLowerCase().replace(/\.$/u, ''))
      .filter(Boolean);
  }
  if (Array.isArray(allowedHosts)) {
    return allowedHosts
      .map((host) => String(host).trim().toLowerCase().replace(/\.$/u, ''))
      .filter(Boolean);
  }
  return [];
}

function hostAllowed(hostname, allowedHosts) {
  const allowlist = parseAllowedHosts(allowedHosts);
  return allowlist.length === 0 || allowlist.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}

function ipv4ToInt(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InSubnet(address, network, prefix) {
  const ip = ipv4ToInt(address);
  const base = ipv4ToInt(network);
  if (ip === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

const IPV4_DENY = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv6Words(address) {
  const normalized = address.toLowerCase().split('%', 1)[0];
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const v4 = normalized.slice(lastColon + 1);
    const value = ipv4ToInt(v4);
    if (value === null) return null;
    return `${normalized.slice(0, lastColon + 1)}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  return normalized;
}

function ipv6WordsArray(address) {
  const normalized = ipv6Words(address);
  if (!normalized) return null;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((word) => Number.parseInt(word || '0', 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return words;
}

function ipv6InSubnet(address, network, prefix) {
  const value = ipv6WordsArray(address);
  const base = ipv6WordsArray(network);
  if (!value || !base || prefix < 0 || prefix > 128) return false;
  const fullWords = Math.floor(prefix / 16);
  const extraBits = prefix % 16;
  for (let index = 0; index < fullWords; index += 1) {
    if (value[index] !== base[index]) return false;
  }
  if (extraBits > 0) {
    const mask = (0xffff << (16 - extraBits)) & 0xffff;
    if ((value[fullWords] & mask) !== (base[fullWords] & mask)) return false;
  }
  return true;
}

/** Return true for IPv4/IPv6 addresses that must never be fetched. */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return IPV4_DENY.some(([network, prefix]) => ipv4InSubnet(address, network, prefix));
  if (family !== 6) return true;

  const normalized = ipv6Words(address);
  if (!normalized) return true;
  // IPv4-mapped IPv6 inherits IPv4's policy. Convert final two words back to
  // dotted notation so 127.0.0.1 and RFC1918 ranges cannot bypass the check.
  const words = ipv6WordsArray(address);
  if (words?.slice(0, 6).every((word, index) => word === (index === 5 ? 0xffff : 0))) {
    const mapped = `${words[6] >>> 8}.${words[6] & 0xff}.${words[7] >>> 8}.${words[7] & 0xff}`;
    return isPrivateAddress(mapped);
  }
  if (
    ipv6InSubnet(address, '::', 128) ||
    ipv6InSubnet(address, '::1', 128) ||
    ipv6InSubnet(address, 'fc00::', 7) || // unique local
    ipv6InSubnet(address, 'fe80::', 10) || // link local
    ipv6InSubnet(address, 'fec0::', 10) || // deprecated site local
    ipv6InSubnet(address, 'ff00::', 8) || // multicast
    ipv6InSubnet(address, '2001:db8::', 32) || // documentation
    ipv6InSubnet(address, '2001::', 32) // protocol assignment / transition ranges
  ) return true;
  // Only global unicast 2000::/3 is accepted. This rejects unspecified
  // protocol/reserved ranges without relying on string formatting.
  if (!ipv6InSubnet(address, '2000::', 3)) return true;
  return false;
}

async function resolvePublicAddress(hostname, lookup) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('media host resolves to a private or reserved address');
    return { address: hostname, family: net.isIP(hostname) };
  }

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('media host DNS lookup failed');
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error('media host DNS lookup returned no addresses');
  if (records.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('media host resolves to a private or reserved address');
  }
  return records[0];
}

/** Validate URL syntax, host policy and DNS/IP SSRF constraints. */
export async function validateMediaUrl(value, { allowedHosts = [], lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('media URL is invalid');
  }
  if (url.protocol !== 'https:') throw new TypeError('media URL must use HTTPS');
  if (url.username || url.password) throw new TypeError('media URL credentials are not allowed');
  if (
    !url.hostname ||
    url.hostname.toLowerCase() === 'localhost' ||
    url.hostname.toLowerCase() === 'local' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local')
  ) {
    throw new TypeError('media URL host is not allowed');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (!hostAllowed(hostname, allowedHosts)) throw new TypeError('media URL host is not in MEDIA_ALLOWED_HOSTS');
  const address = await resolvePublicAddress(hostname, lookup);
  return { url, hostname, address };
}

function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

function requestPinnedHttps({ url, hostname, address }, { maxBytes, timeoutMs, requestImpl }) {
  return new Promise((resolve, reject) => {
    const family = address.family ?? net.isIP(address.address);
    const request = requestImpl(url, {
      method: 'GET',
      headers: { accept: 'image/jpeg,image/png,image/webp,image/gif' },
      servername: net.isIP(hostname) ? undefined : hostname,
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [{ address: address.address, family }]);
        else callback(null, address.address, family);
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        reject(new Error('media redirects are not allowed'));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`media download returned HTTP ${response.statusCode}`));
        return;
      }
      const declaredType = normalizeContentType(response.headers['content-type']);
      if (!SUPPORTED_MEDIA_TYPES.includes(declaredType)) {
        response.resume();
        reject(new Error(`unsupported media content type: ${declaredType || 'missing'}`));
        return;
      }
      const declaredSize = Number(response.headers['content-length']);
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        response.resume();
        reject(new Error('media exceeds 5 MB limit'));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error('media exceeds 5 MB limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const bytes = Buffer.concat(chunks, size);
        const actualType = sniffImageType(bytes);
        if (!actualType || actualType !== declaredType) {
          reject(new Error('media bytes do not match supported image content type'));
          return;
        }
        resolve({ bytes, contentType: actualType, size });
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('media download timed out')));
    request.on('error', reject);
    request.end();
  });
}

/** Download and validate one image, pinning the HTTPS connection to checked DNS. */
export async function fetchMedia(value, {
  allowedHosts = [],
  maxBytes = MAX_MEDIA_BYTES,
  timeoutMs = 15_000,
  lookup = dns.lookup,
  requestImpl = https.request,
} = {}) {
  const target = await validateMediaUrl(value, { allowedHosts, lookup });
  const media = await requestPinnedHttps(target, { maxBytes, timeoutMs, requestImpl });
  return { ...media, size: media.bytes.length };
}

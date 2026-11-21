/**
 * Inline markup handling and deterministic text normalization/hashing.
 * Zero DOM dependencies.
 */

const INLINE_TOKEN_RE = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_|\`[^`\n]+?\`)/g;

/**
 * Removes inline emphasis/code markup for comparison and matching,
 * while preserving the inner text.
 * @param {string} text
 * @returns {string}
 */
export function stripInlineMarkup(text) {
  if (!text) return '';
  return text.replace(INLINE_TOKEN_RE, (match) => {
    if (match.startsWith('**') && match.endsWith('**')) {
      return match.slice(2, -2);
    }
    if (match.startsWith('__') && match.endsWith('__')) {
      return match.slice(2, -2);
    }
    return match.slice(1, -1);
  });
}

/**
 * Tokenizes inline markup into safe render tokens.
 * @param {string} text
 * @returns {Array<{type: 'text'|'strong'|'em'|'code', value: string}>}
 */
export function tokenizeInlineMarkup(text) {
  if (!text) return [];
  const tokens = [];
  let lastIndex = 0;
  INLINE_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    if ((raw.startsWith('**') && raw.endsWith('**')) || (raw.startsWith('__') && raw.endsWith('__'))) {
      tokens.push({ type: 'strong', value: raw.slice(2, -2) });
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push({ type: 'code', value: raw.slice(1, -1) });
    } else {
      tokens.push({ type: 'em', value: raw.slice(1, -1) });
    }
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return tokens;
}

/**
 * Normalizes text for deterministic block comparison and hashing.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForHash(text) {
  if (!text) return '';
  return stripInlineMarkup(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

/**
 * Deterministic 64-bit FNV-1a-based hex hash (two 32-bit lanes).
 * Synchronous and identical across browser and Node.js.
 * @param {string} input
 * @returns {string}
 */
export function computeDeterministicHash(input) {
  const str = String(input ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const p2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${p1}${p2}`;
}

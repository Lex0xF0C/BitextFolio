/**
 * Pure deterministic omission, contamination, and copy-paste duplication hint detector.
 * Supports per-hint dismissal persistence via project.dismissedHints.
 * Zero DOM dependencies.
 */

import { computeDeterministicHash, stripInlineMarkup } from './markup.js';
import { buildCharNgrams, jaccardSimilarity } from './tm.js';

function normalizeForMatch(text, literalText = false) {
  const raw = String(text || '');
  const base = literalText ? raw : stripInlineMarkup(raw);
  return base
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNumbers(norm) {
  const rawMatches = norm.match(/\b\d+(?:[.,-]\d+)*(?:[a-zA-Z]\d+)?%?/g) || [];
  const tokens = [];
  for (const raw of rawMatches) {
    // Strip trailing dot/comma if punctuation
    const clean = raw.replace(/[.,]+$/, '');
    if (clean) tokens.push(clean);
  }
  return [...new Set(tokens)];
}

function extractJaNumbers(norm) {
  const results = [];
  const re = /\d+(?:[.,-]\d+)*(?:[a-zA-Z]\d+)?%?/g;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const token = m[0].replace(/[.,]+$/, '');
    if (!token) continue;
    const after = norm.slice(m.index + m[0].length);
    // Ignore harmless Japanese single-digit ordinals like "1つ", "2つ目", "1点"
    if (/^\d$/.test(token) && /^(?:つ目|つ|個目|個|点目|点|回目|番目)/.test(after)) {
      continue;
    }
    results.push(token);
  }
  return [...new Set(results)];
}

function numberAppearsInText(numToken, targetNorm) {
  const plainNum = numToken.replace(/,/g, '');
  const targetNoCommas = targetNorm.replace(/,/g, '');
  if (targetNoCommas.includes(plainNum)) return true;
  if (plainNum.endsWith('%') && targetNoCommas.includes(plainNum.slice(0, -1))) return true;
  return false;
}

function extractUrlsAndIds(norm) {
  const urls = norm.match(/https?:\/\/[^\s)>\]"'、。]+/gi) || [];
  const emails = norm.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  const cves = norm.match(/\bCVE-\d{4}-\d{4,}\b/gi) || [];
  return [...new Set([...urls, ...emails, ...cves])];
}

function extractAcronymsAndCodes(norm) {
  const matches = norm.match(/\b(?:[A-Z]{2,}(?:-[A-Z0-9]+)*|[A-Z]+\d+[A-Z0-9-]*)\b/g) || [];
  // Filter out common non-content Roman numerals or single-word uppercase pronouns
  const ignore = new Set(['II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII']);
  return [...new Set(matches.filter((m) => !ignore.has(m)))];
}

/**
 * Builds an index of normalized Japanese group texts across all blocks for copy-paste duplication checks.
 * @param {Array} blocks
 * @returns {Map<string, Array<{ groupId: string, blockId: string, enPlain: string, enNgrams: string[] }>>}
 */
export function buildDuplicateJaIndex(blocks) {
  const index = new Map();
  for (const blk of blocks || []) {
    const enMap = new Map((blk.enSentences || []).map((s) => [s.id, s]));
    const jaMap = new Map((blk.jaSentences || []).map((s) => [s.id, s]));
    for (const grp of blk.groups || []) {
      const jaLiteral = (grp.jaIds || []).some((id) => Boolean(jaMap.get(id)?.literalText));
      const enLiteral = (grp.enIds || []).some((id) => Boolean(enMap.get(id)?.literalText));
      const jaPlain = normalizeForMatch(
        (grp.jaIds || []).map((id) => jaMap.get(id)?.plainText || '').join(' '),
        jaLiteral,
      );
      if (jaPlain.length < 12) continue;
      const enPlain = normalizeForMatch(
        (grp.enIds || []).map((id) => enMap.get(id)?.plainText || '').join(' '),
        enLiteral,
      );
      const list = index.get(jaPlain) || [];
      list.push({
        groupId: grp.id,
        blockId: blk.id,
        blockIndex: blk.index,
        enPlain,
        enNgrams: buildCharNgrams(enPlain, 3, { literalText: enLiteral }),
      });
      index.set(jaPlain, list);
    }
  }
  return index;
}

/**
 * Detects deterministic omission, contamination, and duplication hints for a single alignment group.
 */
export function detectGroupHints(
  group,
  block,
  { allBlocks = null, duplicateJaIndex = null, dismissedHints = {} } = {},
) {
  const enMap = new Map((block.enSentences || []).map((s) => [s.id, s]));
  const jaMap = new Map((block.jaSentences || []).map((s) => [s.id, s]));
  const enLiteral = (group.enIds || []).some((id) => Boolean(enMap.get(id)?.literalText));
  const jaLiteral = (group.jaIds || []).some((id) => Boolean(jaMap.get(id)?.literalText));

  const enPlain = normalizeForMatch(
    (group.enIds || []).map((id) => enMap.get(id)?.plainText || '').join(' '),
    enLiteral,
  );
  const jaPlain = normalizeForMatch(
    (group.jaIds || []).map((id) => jaMap.get(id)?.plainText || '').join(' '),
    jaLiteral,
  );

  const hints = [];
  const pushHint = (type, severity, title, detail, tokens = []) => {
    const key = computeDeterministicHash(`${type}:${tokens.join('|') || detail}`);
    const id = `${group.id}:${type}:${key}`;
    hints.push({
      id,
      type,
      severity, // 'warning' | 'info'
      title,
      detail,
      tokens,
      dismissed: Boolean(dismissedHints && dismissedHints[id]),
    });
  };

  // If block has no Japanese text at all (e.g. English-only mode before translation), omit per-group hints
  if (!String(block.jaRaw || '').trim()) {
    return { activeHints: [], dismissedList: [], hasActiveHints: false };
  }

  // 1. Unmatched side (omission / extra Japanese sentence)
  if ((group.enIds || []).length > 0 && (group.jaIds || []).length === 0) {
    pushHint(
      'UNTRANSLATED_SIDE',
      'warning',
      '訳文なし（訳し漏れまたは対応グループの分離）',
      '英文に対応する日本語文がこのグループにありません。意図的な省略でない場合は訳文を追加するか対応付けを見直してください。',
      ['en-only'],
    );
  } else if ((group.enIds || []).length === 0 && (group.jaIds || []).length > 0) {
    pushHint(
      'UNMATCHED_JA_SIDE',
      'warning',
      '対応する英文なし（補足または混入の可能性）',
      '日本語文に対応する英文がこのグループにありません。訳注・補足でなければ誤記やコピペ混入を確認してください。',
      ['ja-only'],
    );
  }

  if (enPlain && jaPlain) {
    // 2. Missing numbers / years / versions / percentages
    const enNumbers = extractNumbers(enPlain);
    const missingNumbers = enNumbers.filter((num) => !numberAppearsInText(num, jaPlain));
    if (missingNumbers.length > 0) {
      pushHint(
        'MISSING_NUMBER',
        'warning',
        '数値・年号の訳し漏れ疑い',
        `英文中の数値（${missingNumbers.join(', ')}）が和文に見当たりません（漢数字表記や丸めがある場合は許容できます）。`,
        missingNumbers,
      );
    }

    // 3. Missing URLs / Emails / CVE IDs
    const enUrls = extractUrlsAndIds(enPlain);
    const missingUrls = enUrls.filter((u) => !jaPlain.toLowerCase().includes(u.toLowerCase()));
    if (missingUrls.length > 0) {
      pushHint(
        'MISSING_URL_OR_ID',
        'warning',
        'URL・メールアドレス・識別子の漏れ疑い',
        `英文中の識別子（${missingUrls.join(', ')}）が和文にそのまま含まれていません。`,
        missingUrls,
      );
    }

    // 4. Missing uppercase acronyms / alphanumeric codes
    const enAcronyms = extractAcronymsAndCodes(enPlain);
    const missingAcronyms = enAcronyms.filter(
      (ac) => !jaPlain.toLowerCase().includes(ac.toLowerCase()),
    );
    if (missingAcronyms.length > 0) {
      pushHint(
        'MISSING_ACRONYM',
        'info',
        '略語・英字表記の未出現',
        `英文中の略語・コード（${missingAcronyms.join(', ')}）が和文にそのまま含まれていません（カタカナ・日本語訳に展開している場合は許容できます）。`,
        missingAcronyms,
      );
    }

    // 5. Extra numbers in Japanese (contamination / typo check)
    const jaNumbers = extractJaNumbers(jaPlain);
    const extraJaNumbers = jaNumbers.filter((num) => !numberAppearsInText(num, enPlain));
    if (extraJaNumbers.length > 0) {
      pushHint(
        'EXTRA_JA_NUMBER',
        'warning',
        '英文にない数値の混入疑い',
        `和文中の数値（${extraJaNumbers.join(', ')}）が英文に見当たりません。転記ミスや別段落の数値混入を確認してください。`,
        extraJaNumbers,
      );
    }

    // 6. Extra uppercase acronyms/codes in Japanese
    const jaAcronyms = extractAcronymsAndCodes(jaPlain);
    const extraJaAcronyms = jaAcronyms.filter(
      (ac) => !enPlain.toLowerCase().includes(ac.toLowerCase()),
    );
    if (extraJaAcronyms.length > 0) {
      pushHint(
        'EXTRA_JA_LATIN',
        'warning',
        '英文にない英字略語の混入疑い',
        `和文中の英字表記（${extraJaAcronyms.join(', ')}）が英文に見当たりません。`,
        extraJaAcronyms,
      );
    }

    // 7. Copy-paste duplication across groups with differing English
    const dupIdx = duplicateJaIndex || (allBlocks ? buildDuplicateJaIndex(allBlocks) : null);
    if (dupIdx && jaPlain.length >= 12) {
      const occurrences = dupIdx.get(jaPlain) || [];
      const enNgrams = buildCharNgrams(enPlain, 3, { literalText: enLiteral });
      const differing = occurrences.filter(
        (occ) =>
          occ.groupId !== group.id &&
          occ.enPlain &&
          jaccardSimilarity(enNgrams, occ.enNgrams) < 0.5,
      );
      if (differing.length > 0) {
        const refBlocks = [...new Set(differing.map((d) => `#${d.blockIndex + 1}`))].join(', ');
        pushHint(
          'DUPLICATE_JA_TEXT',
          'warning',
          'コピペ重複の疑い',
          `別の英文（ブロック ${refBlocks}）とまったく同じ和文が入力されています。ペースト箇所の誤りがないか確認してください。`,
          [refBlocks],
        );
      }
    }
  }

  const activeHints = hints.filter((h) => !h.dismissed);
  const dismissedList = hints.filter((h) => h.dismissed);
  return {
    activeHints,
    dismissedList,
    hasActiveHints: activeHints.length > 0,
  };
}

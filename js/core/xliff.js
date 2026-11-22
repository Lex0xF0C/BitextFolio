/**
 * Pure deterministic OASIS XLIFF 2.1 bilingual export and importer for EN <-> JA.
 * Maps BitextFolio blocks to <group>, alignment groups (including n:m) to <unit>/<segment>,
 * group status to <segment state/subState>, memos to <notes>/<note>, and markers to <mrk>.
 * Zero DOM dependencies (uses a self-contained XML parser without external DTD/ENTITY loading).
 */

import { isListLine } from './block-parser.js';
import { makeSentenceItem, nextLocalId, syncBlockMeta } from './alignment.js';
import { buildBlockHashes } from './hash-diff.js';
import { normalizeMarkerRanges } from './markers.js';
import { stripInlineMarkup } from './markup.js';
import { migrateProject } from './schema.js';
import { DEFAULT_ABBREVIATIONS } from './sentence-splitter.js';

export const XLIFF_21_NAMESPACE = 'urn:oasis:names:tc:xliff:document:2.0';

const STATUS_TO_XLIFF = new Map([
  ['unread', { state: 'initial', subState: 'bitextfolio:unread' }],
  ['source_changed', { state: 'initial', subState: 'bitextfolio:source_changed' }],
  ['read', { state: 'translated', subState: 'bitextfolio:read' }],
  ['needs_review', { state: 'translated', subState: 'bitextfolio:needs_review' }],
  ['verified', { state: 'final', subState: 'bitextfolio:verified' }],
]);

const SUBSTATE_TO_STATUS = new Map([
  ['bitextfolio:unread', 'unread'],
  ['bitextfolio:read', 'read'],
  ['bitextfolio:needs_review', 'needs_review'],
  ['bitextfolio:source_changed', 'source_changed'],
  ['bitextfolio:verified', 'verified'],
]);

const STATE_TO_STATUS = new Map([
  ['initial', 'unread'],
  ['translated', 'read'],
  ['reviewed', 'read'],
  ['final', 'verified'],
]);

function stripInvalidXmlChars(str) {
  return String(str ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function escapeXml(str) {
  return stripInvalidXmlChars(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toSafeXmlId(raw, fallback) {
  const clean = String(raw || fallback || 'id')
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .replace(/^[^A-Za-z0-9_]/, '_');
  return clean || fallback || 'id';
}

function serializeSentenceWithMarkers(sentence, idPrefix) {
  if (!sentence) return '';
  const text =
    typeof sentence.plainText === 'string'
      ? sentence.plainText
      : stripInlineMarkup(sentence.rawText || '');
  if (!text) return '';

  const markers = normalizeMarkerRanges(sentence.markers || [], text.length);
  if (markers.length === 0) return escapeXml(text);

  let out = '';
  let cursor = 0;
  markers.forEach((m, idx) => {
    if (m.start > cursor) {
      out += escapeXml(text.slice(cursor, m.start));
    }
    const mrkId = toSafeXmlId(`${idPrefix}_${idx + 1}`, `mrk_${idx + 1}`);
    out += `<mrk id="${mrkId}" type="comment" value="bitextfolio:marker">${escapeXml(
      text.slice(m.start, m.end),
    )}</mrk>`;
    cursor = m.end;
  });
  if (cursor < text.length) {
    out += escapeXml(text.slice(cursor));
  }
  return out;
}

/**
 * Exports a DocumentProject as a standard OASIS XLIFF 2.1 XML document string.
 * @param {object} project
 * @returns {string}
 */
export function exportProjectToXliff21(project) {
  if (!project || !Array.isArray(project.blocks)) {
    throw new Error('XLIFF 2.1 エクスポート対象のドキュメントが不正です');
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xliff xmlns="${XLIFF_21_NAMESPACE}" version="2.1" srcLang="en" trgLang="ja">`,
  ];

  const fileId = toSafeXmlId(project.id, 'f1');
  const fileOrig = escapeXml(project.title || 'untitled');
  lines.push(`  <file id="${fileId}" original="${fileOrig}">`);
  lines.push('    <notes>');
  lines.push(
    `      <note id="note_title" category="bitextfolio:title">${escapeXml(project.title || '')}</note>`,
  );
  lines.push(
    `      <note id="note_schema" category="bitextfolio:schemaVersion">${project.schemaVersion || 2}</note>`,
  );
  if (project.splitInsideList) {
    lines.push('      <note id="note_split_list" category="bitextfolio:splitInsideList">true</note>');
  }
  lines.push('    </notes>');

  (project.blocks || []).forEach((block, blkIdx) => {
    const grpId = toSafeXmlId(block.id, `blk_${blkIdx + 1}`);
    const grpName = `block-${String(blkIdx + 1).padStart(2, '0')}`;
    lines.push(`    <group id="${grpId}" name="${grpName}">`);

    const enMap = new Map((block.enSentences || []).map((s) => [s.id, s]));
    const jaMap = new Map((block.jaSentences || []).map((s) => [s.id, s]));

    (block.groups || []).forEach((group, gIdx) => {
      const unitId = toSafeXmlId(group.id, `${grpId}_u_${gIdx + 1}`);
      lines.push(`      <unit id="${unitId}">`);

      const unitNotes = [];
      if (group.memo) {
        unitNotes.push(
          `          <note id="${unitId}_n_memo" category="bitextfolio:memo">${escapeXml(group.memo)}</note>`,
        );
      }
      if (group.previousMemoNote) {
        unitNotes.push(
          `          <note id="${unitId}_n_prev" category="bitextfolio:previousMemoNote">${escapeXml(group.previousMemoNote)}</note>`,
        );
      }
      if (group.tempNoOmission) {
        unitNotes.push(
          `          <note id="${unitId}_n_omit" category="bitextfolio:tempNoOmission">true</note>`,
        );
      }
      if (
        (group.enIds || []).length === 1 &&
        (group.jaIds || []).length === 1 &&
        group.confirmedAlignment === false
      ) {
        unitNotes.push(
          `          <note id="${unitId}_n_align" category="bitextfolio:confirmedAlignment">false</note>`,
        );
      }
      if (unitNotes.length > 0) {
        lines.push('        <notes>');
        lines.push(...unitNotes);
        lines.push('        </notes>');
      }

      const enList = (group.enIds || []).map((id) => enMap.get(id)).filter(Boolean);
      const jaList = (group.jaIds || []).map((id) => jaMap.get(id)).filter(Boolean);
      const mapping = STATUS_TO_XLIFF.get(group.status) || STATUS_TO_XLIFF.get('unread');
      const segCount = Math.max(1, enList.length, jaList.length);

      for (let i = 0; i < segCount; i += 1) {
        const enSent = enList[i] || null;
        const jaSent = jaList[i] || null;
        const segId = `${unitId}_s${i + 1}`;
        lines.push(
          `        <segment id="${segId}" state="${mapping.state}" subState="${mapping.subState}">`,
        );
        if (enSent) {
          lines.push(
            `          <source>${serializeSentenceWithMarkers(enSent, `${segId}_em`)}</source>`,
          );
        } else {
          lines.push('          <source/>');
        }
        if (jaSent) {
          lines.push(
            `          <target>${serializeSentenceWithMarkers(jaSent, `${segId}_jm`)}</target>`,
          );
        }
        lines.push('        </segment>');
      }

      lines.push('      </unit>');
    });

    lines.push('    </group>');
  });

  lines.push('  </file>');
  lines.push('</xliff>');
  lines.push('');
  return lines.join('\n');
}

function decodeXmlEntities(text) {
  return String(text || '').replace(
    /&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9A-Fa-f]+));/g,
    (_, entity, dec, hex) => {
      if (entity === 'amp') return '&';
      if (entity === 'lt') return '<';
      if (entity === 'gt') return '>';
      if (entity === 'quot') return '"';
      if (entity === 'apos') return "'";
      const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return _;
    },
  );
}

function parseAttributes(attrText) {
  const attrs = {};
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = attrRe.exec(attrText)) !== null) {
    const key = m[1];
    const localKey = key.includes(':') ? key.split(':').pop() : key;
    const val = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
    attrs[key] = val;
    if (!(localKey in attrs)) {
      attrs[localKey] = val;
    }
  }
  return attrs;
}

function parseXmlDocument(rawXml) {
  const src = String(rawXml || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!src.trim()) {
    throw new Error('XLIFF ファイルが空です');
  }
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(src)) {
    throw new Error('セキュリティ保護のため DOCTYPE / ENTITY 宣言を含む XML は読み込めません');
  }

  const rootWrapper = { name: '#root', localName: '#root', attrs: {}, children: [] };
  const stack = [rootWrapper];
  let pos = 0;

  while (pos < src.length) {
    const ltIdx = src.indexOf('<', pos);
    if (ltIdx === -1) {
      const tail = src.slice(pos);
      if (tail) {
        stack[stack.length - 1].children.push({ type: 'text', text: decodeXmlEntities(tail) });
      }
      break;
    }

    if (ltIdx > pos) {
      const textChunk = src.slice(pos, ltIdx);
      stack[stack.length - 1].children.push({ type: 'text', text: decodeXmlEntities(textChunk) });
    }

    if (src.startsWith('<!--', ltIdx)) {
      const endComment = src.indexOf('-->', ltIdx + 4);
      if (endComment === -1) throw new Error('XML コメントが閉じられていません');
      pos = endComment + 3;
      continue;
    }

    if (src.startsWith('<![CDATA[', ltIdx)) {
      const endCdata = src.indexOf(']]>', ltIdx + 9);
      if (endCdata === -1) throw new Error('CDATA セクションが閉じられていません');
      stack[stack.length - 1].children.push({
        type: 'text',
        text: src.slice(ltIdx + 9, endCdata),
      });
      pos = endCdata + 3;
      continue;
    }

    if (src.startsWith('<?', ltIdx)) {
      const endPi = src.indexOf('?>', ltIdx + 2);
      if (endPi === -1) throw new Error('XML 処理命令が閉じられていません');
      pos = endPi + 2;
      continue;
    }

    if (src.startsWith('</', ltIdx)) {
      const gtIdx = src.indexOf('>', ltIdx + 2);
      if (gtIdx === -1) throw new Error('XML 終了タグが閉じられていません');
      const tagName = src.slice(ltIdx + 2, gtIdx).trim();
      const top = stack.pop();
      if (!top || top.name !== tagName) {
        throw new Error(`XML タグの対応が不正です (</${tagName}>)`);
      }
      pos = gtIdx + 1;
      continue;
    }

    // Parse opening or self-closing tag respecting quotes inside attributes
    let gtIdx = ltIdx + 1;
    let inQuote = null;
    while (gtIdx < src.length) {
      const ch = src[gtIdx];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === '>') {
        break;
      }
      gtIdx += 1;
    }
    if (gtIdx >= src.length || src[gtIdx] !== '>') {
      throw new Error('XML 開始タグが閉じられていません');
    }

    const inside = src.slice(ltIdx + 1, gtIdx);
    const selfClosing = inside.endsWith('/');
    const body = (selfClosing ? inside.slice(0, -1) : inside).trim();
    const spaceMatch = /^([^\s/]+)([\s\S]*)$/.exec(body);
    if (!spaceMatch) {
      throw new Error('不正な XML タグが含まれています');
    }
    const tagName = spaceMatch[1];
    const localName = tagName.includes(':') ? tagName.split(':').pop() : tagName;
    const attrs = parseAttributes(spaceMatch[2]);

    const node = {
      type: 'element',
      name: tagName,
      localName,
      attrs,
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
    pos = gtIdx + 1;
  }

  if (stack.length !== 1) {
    const unclosed = stack[stack.length - 1];
    throw new Error(`XML タグ <${unclosed.name}> が閉じられていません`);
  }

  const rootElements = rootWrapper.children.filter((c) => c.type === 'element');
  if (rootElements.length !== 1) {
    throw new Error('ルート XML 要素は 1 つである必要があります');
  }
  return rootElements[0];
}

function getChildElements(node, localName = null) {
  return (node.children || []).filter(
    (c) => c.type === 'element' && (!localName || c.localName === localName),
  );
}

function extractTextAndMarkers(node) {
  let text = '';
  const markers = [];

  function walk(curr) {
    if (!curr) return;
    if (curr.type === 'text') {
      text += curr.text;
      return;
    }
    if (curr.type !== 'element') return;

    if (curr.localName === 'cp' && curr.attrs.hex) {
      const code = Number.parseInt(curr.attrs.hex, 16);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        text += String.fromCodePoint(code);
      }
      return;
    }

    const isMarkerEl =
      curr.localName === 'mrk' &&
      (curr.attrs.value === 'bitextfolio:marker' || curr.attrs.type === 'bitextfolio:marker');

    const start = text.length;
    for (const child of curr.children || []) {
      walk(child);
    }
    const end = text.length;
    if (isMarkerEl && end > start) {
      markers.push({ start, end });
    }
  }

  walk(node);
  // Trim leading/trailing whitespace that may arise from indentation while adjusting marker offsets
  const leadMatch = /^\s+/.exec(text);
  const leadLen = leadMatch ? leadMatch[0].length : 0;
  const trimmed = text.trim();
  const adjustedMarkers = markers
    .map((m) => ({
      start: Math.max(0, m.start - leadLen),
      end: Math.min(trimmed.length, m.end - leadLen),
    }))
    .filter((m) => m.end > m.start);

  return {
    text: trimmed,
    markers: normalizeMarkerRanges(adjustedMarkers, trimmed.length),
  };
}

function extractPlainText(node) {
  return extractTextAndMarkers(node).text;
}

function resolveUnitStatus(segmentMetaList, enCount, jaCount) {
  if (!segmentMetaList || segmentMetaList.length === 0) return 'unread';

  const subStates = segmentMetaList.map((s) => s.subState).filter(Boolean);
  if (subStates.includes('bitextfolio:needs_review')) return 'needs_review';
  if (subStates.includes('bitextfolio:source_changed')) return 'source_changed';

  if (subStates.length === segmentMetaList.length) {
    const mapped = subStates.map((ss) => SUBSTATE_TO_STATUS.get(ss)).filter(Boolean);
    if (mapped.length === segmentMetaList.length && new Set(mapped).size === 1) {
      return mapped[0];
    }
  }

  const states = segmentMetaList.map((s) => (s.state || '').toLowerCase());
  if (enCount > 0 && jaCount === 0) return 'unread';
  if (states.some((st) => st === 'initial' || st === '')) return 'unread';
  if (states.every((st) => st === 'final')) {
    return STATE_TO_STATUS.get('final');
  }
  return 'read';
}

function collectGroupBlocksFromFile(fileNode) {
  const blocks = [];
  let looseUnits = [];

  function flushLooseUnits() {
    if (looseUnits.length > 0) {
      blocks.push({ id: nextLocalId('blk'), units: looseUnits });
      looseUnits = [];
    }
  }

  function walkGroup(groupNode) {
    const directUnits = getChildElements(groupNode, 'unit');
    const nestedGroups = getChildElements(groupNode, 'group');
    if (directUnits.length > 0) {
      blocks.push({
        id: groupNode.attrs.id || nextLocalId('blk'),
        units: directUnits,
      });
    }
    for (const ng of nestedGroups) {
      walkGroup(ng);
    }
  }

  for (const child of fileNode.children || []) {
    if (child.type !== 'element') continue;
    if (child.localName === 'unit') {
      looseUnits.push(child);
    } else if (child.localName === 'group') {
      flushLooseUnits();
      walkGroup(child);
    }
  }
  flushLooseUnits();

  return blocks;
}

/**
 * Parses an OASIS XLIFF 2.0 / 2.1 document string into a BitextFolio DocumentProject (schemaVersion 2).
 * @param {string} xmlText
 * @param {{ defaultTitle?: string, abbreviations?: string[] }} [options]
 * @returns {{ project: object, summary: { blocksCount: number, groupsCount: number, enSentencesCount: number, jaSentencesCount: number, srcLang: string, trgLang: string } }}
 */
export function parseXliff21ToProject(xmlText, options = {}) {
  const root = parseXmlDocument(xmlText);
  if (root.localName !== 'xliff') {
    throw new Error(`ルート要素が <xliff> ではありません（検出: <${root.name}>）`);
  }
  const version = String(root.attrs.version || '').trim();
  if (!version.startsWith('2.')) {
    throw new Error(
      `XLIFF 2.0 / 2.1 形式のみ対応しています（検出バージョン: ${version || '未指定'}）`,
    );
  }

  const srcLang = root.attrs.srcLang || 'en';
  const trgLang = root.attrs.trgLang || 'ja';

  const files = getChildElements(root, 'file');
  if (files.length === 0) {
    throw new Error('<xliff> 内に <file> 要素が見つかりません');
  }

  let projectTitle = '';
  let splitInsideList = false;
  const rawBlockSpecs = [];

  for (const fileNode of files) {
    if (!projectTitle && fileNode.attrs.original) {
      projectTitle = fileNode.attrs.original;
    }
    for (const notesEl of getChildElements(fileNode, 'notes')) {
      for (const noteEl of getChildElements(notesEl, 'note')) {
        const cat = noteEl.attrs.category || '';
        const text = extractPlainText(noteEl);
        if (cat === 'bitextfolio:title' && text) {
          projectTitle = text;
        } else if (cat === 'bitextfolio:splitInsideList' && text === 'true') {
          splitInsideList = true;
        }
      }
    }
    rawBlockSpecs.push(...collectGroupBlocksFromFile(fileNode));
  }

  if (rawBlockSpecs.length === 0) {
    throw new Error('XLIFF 内に読み取り可能な <unit> 要素が見つかりません');
  }

  let totalGroups = 0;
  let totalEnSentences = 0;
  let totalJaSentences = 0;

  const blocks = rawBlockSpecs.map((spec, blkIdx) => {
    const enSentences = [];
    const jaSentences = [];
    const groups = [];

    spec.units.forEach((unitNode, uIdx) => {
      const unitId = unitNode.attrs.id || `${spec.id}_g_${uIdx + 1}_${nextLocalId('g')}`;
      const memoLines = [];
      let previousMemoNote = '';
      let tempNoOmission = false;
      let explicitConfirmed = null;

      for (const notesEl of getChildElements(unitNode, 'notes')) {
        for (const noteEl of getChildElements(notesEl, 'note')) {
          const cat = noteEl.attrs.category || '';
          const noteText = extractPlainText(noteEl);
          if (!noteText) continue;
          if (cat === 'bitextfolio:memo') {
            memoLines.push(noteText);
          } else if (cat === 'bitextfolio:previousMemoNote') {
            previousMemoNote = noteText;
          } else if (cat === 'bitextfolio:tempNoOmission') {
            tempNoOmission = noteText === 'true';
          } else if (cat === 'bitextfolio:confirmedAlignment') {
            explicitConfirmed = noteText === 'true';
          } else if (!cat.startsWith('bitextfolio:')) {
            memoLines.push(cat ? `[${cat}] ${noteText}` : noteText);
          }
        }
      }

      const enIds = [];
      const jaIds = [];
      const segmentMetaList = [];

      for (const segNode of getChildElements(unitNode, 'segment')) {
        segmentMetaList.push({
          state: segNode.attrs.state || '',
          subState: segNode.attrs.subState || '',
        });

        const srcNode = getChildElements(segNode, 'source')[0] || null;
        const trgNode = getChildElements(segNode, 'target')[0] || null;

        if (srcNode) {
          const { text, markers } = extractTextAndMarkers(srcNode);
          if (text) {
            const item = makeSentenceItem(text, 'en', undefined, markers);
            enSentences.push(item);
            enIds.push(item.id);
            totalEnSentences += 1;
          }
        }
        if (trgNode) {
          const { text, markers } = extractTextAndMarkers(trgNode);
          if (text) {
            const item = makeSentenceItem(text, 'ja', undefined, markers);
            jaSentences.push(item);
            jaIds.push(item.id);
            totalJaSentences += 1;
          }
        }
      }

      const status = resolveUnitStatus(segmentMetaList, enIds.length, jaIds.length);
      const confirmedAlignment =
        explicitConfirmed !== null
          ? explicitConfirmed
          : enIds.length === 1 && jaIds.length === 1;

      groups.push({
        id: unitId,
        enIds,
        jaIds,
        status,
        memo: memoLines.join('\n'),
        previousMemoNote,
        tempNoOmission,
        confirmedAlignment,
        clausePairs: [],
      });
      totalGroups += 1;
    });

    const isEnList = enSentences.length > 1 && enSentences.every((s) => isListLine(s.rawText));
    const isJaList = jaSentences.length > 1 && jaSentences.every((s) => isListLine(s.rawText));
    const enRaw = enSentences.map((s) => s.rawText).join(isEnList ? '\n' : ' ');
    const jaRaw = jaSentences.map((s) => s.rawText).join(isJaList ? '\n' : '');
    const hashes = buildBlockHashes(enRaw, jaRaw);

    return syncBlockMeta({
      id: spec.id,
      index: blkIdx,
      enRaw,
      jaRaw,
      enLang: enRaw ? 'en' : null,
      jaLang: jaRaw ? 'ja' : null,
      enConfidence: enRaw ? 1 : 0,
      jaConfidence: jaRaw ? 1 : 0,
      splitInsideList,
      warnings: [],
      enSentences,
      jaSentences,
      groups,
      ...hashes,
    });
  });

  const now = new Date().toISOString();
  const project = migrateProject({
    id: nextLocalId('doc'),
    title: projectTitle || options.defaultTitle || 'XLIFFインポート文書',
    createdAt: now,
    updatedAt: now,
    rawSourceText: '',
    abbreviations:
      Array.isArray(options.abbreviations) && options.abbreviations.length > 0
        ? [...options.abbreviations]
        : [...DEFAULT_ABBREVIATIONS],
    splitInsideList,
    lastFocusedGroupId: blocks[0]?.groups[0]?.id || null,
    dismissedHints: {},
    blocks,
  });

  return {
    project,
    summary: {
      blocksCount: blocks.length,
      groupsCount: totalGroups,
      enSentencesCount: totalEnSentences,
      jaSentencesCount: totalJaSentences,
      srcLang,
      trgLang,
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mergeSentenceWithNextInBlock,
  moveSentenceToGroup,
  splitSentenceInBlock,
  suggestHintedGroups,
  updateSentenceMarkersInBlock,
} from '../js/core/alignment.js';
import {
  addClausePairInGroup,
  attachSpanToClausePairInGroup,
  clearClausePairsInGroup,
  collectSentenceClauseHighlights,
  computeClauseCoverage,
  findWaitingClausePairId,
  removeClausePairInGroup,
  suggestDeterministicClauseChunks,
  toggleClausePairCheckedInGroup,
  updateClausePairNoteInGroup,
} from '../js/core/clauses.js';
import {
  addMarkerRange,
  computeMarkerCoveragePercent,
  hasMarkerOverlap,
  isRangeFullyMarked,
  removeMarkerRange,
  sliceTokensByRange,
  splitTokensByHighlights,
  splitTokensByMarkers,
} from '../js/core/markers.js';
import { pairClassifiedBlocks, splitIntoRawBlocks } from '../js/core/block-parser.js';
import {
  buildAlignmentBlock,
  insertTextIntoGroup,
  mergeWithNextBlockAndBoundarySentences,
  parseDocumentBlocks,
  SAMPLE_SOURCE_TEXT,
  updateBlockJapaneseText,
  updateSentenceTextInBlock,
} from '../js/core/document-builder.js';
import {
  buildGlossaryTypoHintId,
  checkGroupGlossary,
  collectGroupHighlightSpans,
  findEnglishGlossaryMatches,
  findEnglishGlossarySpans,
  findJapaneseFuzzyTermSpans,
  findJapaneseTermSpans,
  matchJapaneseTerm,
  parseGlossaryDelimited,
  reverseLookupJapanese,
  serializeGlossaryDelimited,
} from '../js/core/glossary.js';
import { reconcileReloadedBlocks } from '../js/core/hash-diff.js';
import { buildDuplicateJaIndex, detectGroupHints } from '../js/core/hints.js';
import { classifyLanguage } from '../js/core/lang-classifier.js';
import { stripInlineMarkup, tokenizeInlineMarkup } from '../js/core/markup.js';
import { splitEnglishSentences, splitJapaneseSentences } from '../js/core/sentence-splitter.js';
import {
  createTmRecord,
  exportTmAsTmx,
  extractTermCandidates,
  findTmMatches,
} from '../js/core/tm.js';
import {
  CURRENT_SCHEMA_VERSION,
  migrateExportPayload,
  migrateProject,
  parseAndValidateImportPayload,
  validateExportPayload,
} from '../js/core/schema.js';
import {
  computeAnchoredScrollTop,
  computeVirtualWindowRange,
} from '../js/core/virtual-window.js';
import {
  exportProjectToXliff21,
  parseXliff21ToProject,
  XLIFF_21_NAMESPACE,
} from '../js/core/xliff.js';

test('English splitter preserves abbreviations, decimals, versions, and quotes', () => {
  const input =
    'See Fig. 2 and SP 800-61r3, ver. 2.0 (e.g., Smith et al. and No. 5 vs. approx. 3.14% loss). He said "Wait." and left. Next sentence starts here!';
  const sentences = splitEnglishSentences(input);
  assert.equal(sentences.length, 3);
  assert.match(sentences[0], /^See Fig\. 2/);
  assert.equal(sentences[1], 'He said "Wait." and left.');
  assert.equal(sentences[2], 'Next sentence starts here!');
});

test('English splitter respects user-defined custom abbreviations', () => {
  const input = 'Refer to Doc. 12 for details. Then apply the patch.';
  const withoutCustom = splitEnglishSentences(input, { abbreviations: ['e.g.'] });
  assert.equal(withoutCustom.length, 3);

  const withCustom = splitEnglishSentences(input, { abbreviations: ['Doc.'] });
  assert.equal(withCustom.length, 2);
  assert.equal(withCustom[0], 'Refer to Doc. 12 for details.');
});

test('Japanese splitter keeps trailing closing brackets with the preceding sentence', () => {
  const input = '担当者は「記録を開始する。」と報告した。次の手順に移る！『本当に？』最後の文（補足。）';
  const sentences = splitJapaneseSentences(input);
  assert.deepEqual(sentences, [
    '担当者は「記録を開始する。」',
    'と報告した。',
    '次の手順に移る！',
    '『本当に？』',
    '最後の文（補足。）',
  ]);
});

test('List blocks split one item per line for bullets and numbered items', () => {
  const enList = `- First item (e.g., check logs).\n* Second item with 2.0 threshold.\n1. Third item.\n(1) Fourth item.`;
  const jaList = `・最初の項目。\n- 次の項目（2.0基準）。\n1. 三番目の項目。\n(1) 四番目の項目。`;

  assert.equal(splitEnglishSentences(enList).length, 4);
  assert.equal(splitJapaneseSentences(jaList).length, 4);
});

test('Inline markup is preserved for display tokens and stripped for comparison', () => {
  const raw = 'During incident handling, *triage* (トリアージ) is **critical** and uses `UTC`.';
  assert.equal(
    stripInlineMarkup(raw),
    'During incident handling, triage (トリアージ) is critical and uses UTC.',
  );
  const tokens = tokenizeInlineMarkup(raw);
  assert.ok(tokens.some((t) => t.type === 'em' && t.value === 'triage'));
  assert.ok(tokens.some((t) => t.type === 'strong' && t.value === 'critical'));
  assert.ok(tokens.some((t) => t.type === 'code' && t.value === 'UTC'));
});

test('Language classifier and block pairing detect anomalies and trailing EN', () => {
  const text = [
    'First English paragraph.',
    'Second English paragraph without Japanese.',
    '最初の日本語段落。',
    '続く日本語段落。',
    'Trailing English paragraph at EOF.',
  ].join('\n\n');

  const rawBlocks = splitIntoRawBlocks(text);
  assert.equal(rawBlocks.length, 5);
  assert.equal(classifyLanguage(rawBlocks[0].rawText).lang, 'en');
  assert.equal(classifyLanguage(rawBlocks[2].rawText).lang, 'ja');

  const pairs = pairClassifiedBlocks(rawBlocks);
  assert.equal(pairs.length, 4);
  assert.ok(pairs[0].warnings.includes('CONSECUTIVE_EN'));
  assert.ok(pairs[2].warnings.includes('CONSECUTIVE_JA'));
  assert.ok(pairs[3].warnings.includes('TRAILING_EN'));
});

test('Supports 2 English sentences paired with 1 Japanese sentence and manual split/merge/move', () => {
  const block = buildAlignmentBlock(
    'The system logs events in 2025. Operators review *triage* alerts daily.',
    'システムは2025年にイベントを記録し、運用担当者が日々トリアージ（triage）アラートを確認する。',
    0,
  );

  assert.equal(block.enSentences.length, 2);
  assert.equal(block.jaSentences.length, 1);
  assert.ok(block.warnings.includes('UNMATCHED_COUNT'));

  // Move 2nd EN sentence into Group 1 so 2 EN sentences pair with 1 JA sentence
  const g1 = block.groups[0].id;
  const secondEnId = block.enSentences[1].id;
  const aligned = moveSentenceToGroup(block, 'en', secondEnId, g1);

  assert.equal(aligned.groups.length, 1);
  assert.equal(aligned.groups[0].enIds.length, 2);
  assert.equal(aligned.groups[0].jaIds.length, 1);

  // Split Japanese sentence at comma into 2 sentences
  const jaId = aligned.jaSentences[0].id;
  const splitIdx = aligned.jaSentences[0].rawText.indexOf('、') + 1;
  const afterSplit = splitSentenceInBlock(aligned, 'ja', jaId, splitIdx);
  assert.equal(afterSplit.jaSentences.length, 2);

  // Merge back
  const afterMerge = mergeSentenceWithNextInBlock(afterSplit, 'ja', jaId);
  assert.equal(afterMerge.jaSentences.length, 1);

  // Hint-based DP alignment pairs 2 EN sentences with 1 JA sentence cleanly
  const hinted = suggestHintedGroups(block.enSentences, block.jaSentences, block.id);
  assert.equal(hinted.length, 1);
  assert.equal(hinted[0].enIds.length, 2);
  assert.equal(hinted[0].jaIds.length, 1);
});

test('Sample document parses cleanly and detects 4 EN vs 5 JA mismatch in block 1', () => {
  const blocks = parseDocumentBlocks(SAMPLE_SOURCE_TEXT);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].enSentences.length, 4);
  assert.equal(blocks[0].jaSentences.length, 5);
  assert.ok(blocks[0].warnings.includes('UNMATCHED_COUNT'));
  assert.equal(blocks[1].enSentences.length, 2);
  assert.equal(blocks[1].jaSentences.length, 2);
});

test('Reconcile reloaded blocks inherits unchanged blocks and flags changed ones', () => {
  const oldBlocks = parseDocumentBlocks(
    'Alpha sentence.\n\nアルファ文。\n\nBeta sentence.\n\nベータ文。',
  );
  oldBlocks[0].groups[0].status = 'verified';
  oldBlocks[0].groups[0].memo = '確認完了メモ';
  oldBlocks[1].groups[0].status = 'verified';
  oldBlocks[1].groups[0].memo = '変更前チェック済み';

  const newBlocks = parseDocumentBlocks(
    'Alpha sentence.\n\nアルファ文。\n\nBeta sentence updated.\n\nベータ文。',
  );

  const { blocks, summary } = reconcileReloadedBlocks(oldBlocks, newBlocks);
  assert.equal(summary.inheritedCount, 1);
  assert.equal(summary.changedCount, 1);
  assert.equal(blocks[0].groups[0].status, 'verified');
  assert.equal(blocks[0].groups[0].memo, '確認完了メモ');
  assert.equal(blocks[1].groups[0].status, 'source_changed');
  assert.match(blocks[1].groups[0].previousMemoNote, /変更前チェック済み/);
});

test('English-only mode creates blocks without warnings and supports incremental Japanese entry', () => {
  const enOnly = [
    'First English paragraph. Second sentence here.',
    'Second English paragraph.',
  ].join('\n\n');

  const blocks = parseDocumentBlocks(enOnly, { inputMode: 'english_only' });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].jaSentences.length, 0);
  assert.ok(!blocks[0].warnings.includes('CONSECUTIVE_EN'));
  assert.ok(!blocks[1].warnings.includes('TRAILING_EN'));

  const updated = updateBlockJapaneseText(
    blocks[0],
    '最初の英語段落です。2つ目の文はこちらです。',
  );
  assert.equal(updated.jaSentences.length, 2);
  assert.equal(updated.groups.length, 2);
  assert.ok(!updated.warnings.includes('UNMATCHED_COUNT'));
});

test('Glossary matches English inflections, manual variants, and case-sensitivity setting', () => {
  const entry = {
    enHeadword: 'log',
    enVariants: ['recorded'],
    caseSensitive: false,
  };
  assert.ok(findEnglishGlossaryMatches('Operators logged events.', entry).length > 0);
  assert.ok(findEnglishGlossaryMatches('System logging is active.', entry).length > 0);
  assert.ok(findEnglishGlossaryMatches('Security logs were checked.', entry).length > 0);
  assert.ok(findEnglishGlossaryMatches('An entry was recorded.', entry).length > 0);

  const policyEntry = { enHeadword: 'policy', enVariants: [], caseSensitive: false };
  assert.ok(findEnglishGlossaryMatches('Multiple policies apply.', policyEntry).length > 0);

  const caseEntry = { enHeadword: 'NIST', enVariants: [], caseSensitive: true };
  assert.equal(findEnglishGlossaryMatches('Refer to nist guide.', caseEntry).length, 0);
  assert.equal(findEnglishGlossaryMatches('Refer to NIST guide.', caseEntry).length, 1);
});

test('Japanese normalization absorbs width, katakana long vowel, and okurigana variants', () => {
  assert.equal(matchJapaneseTerm('引き継ぎ手順を確認する。', '引継ぎ'), true);
  assert.equal(matchJapaneseTerm('引継手順を確認する。', '引き継ぎ'), true);
  assert.equal(matchJapaneseTerm('アドバイザリーを公開する。', 'アドバイザリ'), true);
  assert.equal(matchJapaneseTerm('ＮＩＳＴ基準に準拠。', 'NIST'), true);
  assert.equal(
    matchJapaneseTerm('アドバイザリーを公開する。', 'アドバイザリ', {
      normalizeWidth: true,
      normalizeLongVowel: false,
      normalizeOkurigana: true,
    }),
    false,
  );
});

test('Glossary consistency check detects accepted, missing, and deprecated terms', () => {
  const glossary = [
    {
      id: 'g1',
      enHeadword: 'triage',
      enVariants: [],
      jaAccepted: ['トリアージ'],
      jaDeprecated: ['選別'],
      caseSensitive: false,
    },
  ];

  const okRes = checkGroupGlossary('Teams triage reports.', 'チームがトリアージを行う。', glossary);
  assert.equal(okRes.hasIssues, false);
  assert.equal(okRes.matchedOk.length, 1);

  const missingRes = checkGroupGlossary('Teams triaged reports.', 'チームが報告を分類した。', glossary);
  assert.equal(missingRes.hasIssues, true);
  assert.equal(missingRes.missingAccepted.length, 1);

  const depRes = checkGroupGlossary('Teams triage reports.', 'チームが選別を行う。', glossary);
  assert.equal(depRes.hasIssues, true);
  assert.equal(depRes.deprecatedUsed.length, 1);
});

test('Reverse lookup finds Japanese occurrences with variant tolerance and exports/imports CSV & TSV', () => {
  const blocks = parseDocumentBlocks(
    'Coordinate handover procedures.\n\n引き継ぎ手順を調整する。\n\nPublish the advisory.\n\nアドバイザリーを公開する。',
  );
  const hits = reverseLookupJapanese(blocks, '引継ぎ');
  assert.equal(hits.length, 1);
  assert.match(hits[0].enText, /handover/);

  const sample = [
    {
      id: 'g1',
      enHeadword: 'advisory',
      enVariants: ['advisories'],
      jaAccepted: ['アドバイザリ', 'アドバイザリー'],
      jaDeprecated: ['勧告書'],
      caseSensitive: false,
      notes: '標準表記',
    },
  ];
  const tsv = serializeGlossaryDelimited(sample, '\t');
  const parsedTsv = parseGlossaryDelimited(tsv, 'auto');
  assert.equal(parsedTsv.length, 1);
  assert.equal(parsedTsv[0].enHeadword, 'advisory');
  assert.deepEqual(parsedTsv[0].jaAccepted, ['アドバイザリ', 'アドバイザリー']);
  assert.deepEqual(parsedTsv[0].jaDeprecated, ['勧告書']);
});

test('Translation Memory computes n-gram similarity, flags past translation discrepancies, and exports valid TMX', () => {
  const rec1 = createTmRecord({
    enPlain: 'Teams must triage incoming security reports within 24 hours.',
    jaPlain: 'チームは受領したセキュリティ報告を24時間以内にトリアージしなければならない。',
    sourceDocId: 'doc1',
    sourceDocTitle: 'Guide A',
    groupId: 'grp1',
  });
  const rec2 = createTmRecord({
    enPlain: 'Publish the vulnerability advisory & notify vendors.',
    jaPlain: '脆弱性アドバイザリを公開し、ベンダーに通知する。',
    sourceDocId: 'doc1',
    sourceDocTitle: 'Guide A',
    groupId: 'grp2',
  });

  const matches = findTmMatches(
    'Teams must triage incoming security reports within 24 hours.',
    [rec1, rec2],
    {
      threshold: 0.45,
      excludeGroupId: 'grp_other',
      currentJaPlain: 'チームは24時間以内に受信報告を選別する必要がある。',
    },
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].isExactEn, true);
  assert.equal(matches[0].hasDiscrepancy, true);

  const sameMatches = findTmMatches(
    'Teams must triage incoming security reports within 24 hours.',
    [rec1, rec2],
    {
      threshold: 0.45,
      excludeGroupId: 'grp_other',
      currentJaPlain: 'チームは受領したセキュリティ報告を24時間以内にトリアージしなければならない。',
    },
  );
  assert.equal(sameMatches[0].hasDiscrepancy, false);

  const tmx = exportTmAsTmx([rec2]);
  assert.match(tmx, /<tmx version="1\.4">/);
  assert.match(tmx, /Publish the vulnerability advisory &amp; notify vendors\./);
});

test('Deterministic hint detector flags missing numbers/URLs/acronyms, extra JA tokens, copy-paste duplication, and supports dismissal', () => {
  const blocks = parseDocumentBlocks(
    'In 2025, NIST published https://example.org/guide with a 0.5% threshold.\n\nガイドが公開された。\n\nUnrelated second paragraph discussing recovery timelines.\n\nまったく同じコピペ文章がここに入っている。\n\nAnother completely distinct English sentence about audits.\n\nまったく同じコピペ文章がここに入っている。\n\nClean sentence with 2026 and ISO.\n\n2026年のISO基準に準拠する清潔な文。',
  );
  const dupIdx = buildDuplicateJaIndex(blocks);

  const h0 = detectGroupHints(blocks[0].groups[0], blocks[0], { duplicateJaIndex: dupIdx });
  const types0 = h0.activeHints.map((h) => h.type);
  assert.ok(types0.includes('MISSING_NUMBER'));
  assert.ok(types0.includes('MISSING_URL_OR_ID'));
  assert.ok(types0.includes('MISSING_ACRONYM'));

  // Dismiss one hint and verify it moves to dismissedList
  const firstId = h0.activeHints[0].id;
  const h0AfterDismiss = detectGroupHints(blocks[0].groups[0], blocks[0], {
    duplicateJaIndex: dupIdx,
    dismissedHints: { [firstId]: true },
  });
  assert.equal(h0AfterDismiss.dismissedList.length, 1);
  assert.equal(h0AfterDismiss.activeHints.length, h0.activeHints.length - 1);

  const h1 = detectGroupHints(blocks[1].groups[0], blocks[1], { duplicateJaIndex: dupIdx });
  assert.ok(h1.activeHints.some((h) => h.type === 'DUPLICATE_JA_TEXT'));

  // Clean block should produce 0 hints
  const h3 = detectGroupHints(blocks[3].groups[0], blocks[3], { duplicateJaIndex: dupIdx });
  assert.equal(h3.hasActiveHints, false);
});

test('Term candidate extractor identifies frequent English n-grams and co-occurring Japanese terms', () => {
  const blocks = parseDocumentBlocks(
    'Incident response requires rapid triage.\n\nインシデント対応には迅速なトリアージが必要である。\n\nProper incident response reduces recovery cost.\n\n適切なインシデント対応は復旧コストを削減する。',
  );
  const candidates = extractTermCandidates(blocks, [
    { enHeadword: 'triage', enVariants: [], jaAccepted: ['トリアージ'], jaDeprecated: [] },
  ]);
  const ir = candidates.find((c) => c.enTerm.toLowerCase() === 'incident response');
  assert.ok(ir);
  assert.equal(ir.count, 2);
  assert.equal(ir.alreadyInGlossary, false);
  assert.ok(ir.jaCandidates.some((j) => j.jaTerm.includes('インシデント対応')));
});

test('insertTextIntoGroup allows pasting Japanese directly into an unmatched group in order', () => {
  const blocks = parseDocumentBlocks(
    'First sentence.\nSecond sentence.\nThird sentence.',
    { inputMode: 'english_only' },
  );
  let blk = blocks[0];
  assert.equal(blk.groups.length, 3);
  assert.equal(blk.groups[1].jaIds.length, 0);

  // Paste into group 2 first, then group 1, then group 3
  blk = insertTextIntoGroup(blk, blk.groups[1].id, 'ja', '2番目の文です。');
  assert.equal(blk.groups[1].jaIds.length, 1);
  assert.equal(blk.jaSentences[0].rawText, '2番目の文です。');

  blk = insertTextIntoGroup(blk, blk.groups[0].id, 'ja', '1番目の文です。');
  assert.equal(blk.jaSentences[0].rawText, '1番目の文です。');
  assert.equal(blk.jaSentences[1].rawText, '2番目の文です。');

  blk = insertTextIntoGroup(blk, blk.groups[2].id, 'ja', '3番目の文です。');
  assert.equal(blk.jaSentences.length, 3);
  assert.equal(blk.jaSentences[2].rawText, '3番目の文です。');
  assert.ok(!blk.warnings.includes('UNMATCHED_COUNT'));
});

test('Sentence marker ranges normalize, subtract, split tokens, and survive sentence split/merge', () => {
  // Overlapping and adjacent intervals merge cleanly
  let ranges = addMarkerRange([], 0, 12, 50);
  ranges = addMarkerRange(ranges, 10, 25, 50);
  assert.deepEqual(ranges, [{ start: 0, end: 25 }]);
  assert.equal(hasMarkerOverlap(ranges, 20, 30), true);
  assert.equal(isRangeFullyMarked(ranges, 5, 20), true);
  assert.equal(isRangeFullyMarked(ranges, 20, 30), false);
  assert.equal(computeMarkerCoveragePercent(ranges, 50), 50);

  // Subtracting a middle range splits the interval cleanly
  ranges = removeMarkerRange(ranges, 8, 15, 50);
  assert.deepEqual(ranges, [
    { start: 0, end: 8 },
    { start: 15, end: 25 },
  ]);

  // Token splitting across inline markup
  const tokens = tokenizeInlineMarkup('Check *critical* events.');
  const segs = splitTokensByMarkers(tokens, [{ start: 0, end: 10 }]);
  assert.deepEqual(segs, [
    { type: 'text', value: 'Check ', marked: true },
    { type: 'em', value: 'crit', marked: true },
    { type: 'em', value: 'ical', marked: false },
    { type: 'text', value: ' events.', marked: false },
  ]);

  // Block-level marker add + sentence split + merge preservation
  let blk = buildAlignmentBlock(
    'First long clause continues here and ends.',
    '最初の長い節がここで続き、終わります。',
    0,
  );
  const sid = blk.enSentences[0].id;
  blk = updateSentenceMarkersInBlock(blk, 'en', sid, (prev, maxLen) =>
    addMarkerRange(prev, 0, 22, maxLen),
  );
  assert.deepEqual(blk.enSentences[0].markers, [{ start: 0, end: 22 }]);

  // Split around char 18 ("First long clause " / "continues here and ends.")
  blk = splitSentenceInBlock(blk, 'en', sid, 18);
  assert.equal(blk.enSentences.length, 2);
  assert.deepEqual(blk.enSentences[0].markers, [{ start: 0, end: 17 }]);
  assert.deepEqual(blk.enSentences[1].markers, [{ start: 0, end: 4 }]);

  // Merge back and verify contiguous marker restores
  blk = mergeSentenceWithNextInBlock(blk, 'en', sid);
  assert.equal(blk.enSentences.length, 1);
  assert.deepEqual(blk.enSentences[0].markers, [{ start: 0, end: 22 }]);
});

test('Clause-level comparison pairs track waiting pair, coverage, highlights, chunking, and inline sentence edits', () => {
  let blk = buildAlignmentBlock(
    'When teams detect an anomaly, they must isolate the host, and they should preserve logs.',
    'チームが異常を検知した場合、対象ホストを隔離し、ログを保全しなければならない。',
    0,
  );
  const gid = blk.groups[0].id;
  const enId = blk.enSentences[0].id;
  const jaId = blk.jaSentences[0].id;

  // Step 1: Capture an English clause first
  const { block: b1, pairId: p1 } = addClausePairInGroup(blk, gid, {
    enSpan: { sentenceId: enId, start: 0, end: 28, text: 'When teams detect an anomaly' },
  });
  blk = b1;
  assert.ok(p1);
  assert.equal(findWaitingClausePairId(blk.groups[0], 'ja'), p1);

  // Step 2: Attach corresponding Japanese clause
  blk = attachSpanToClausePairInGroup(blk, gid, p1, 'ja', {
    sentenceId: jaId,
    start: 0,
    end: 13,
    text: 'チームが異常を検知した場合',
  });
  assert.equal(findWaitingClausePairId(blk.groups[0], 'ja'), null);

  // Highlights start as pending, then move to checked when confirmed
  let enHighlights = collectSentenceClauseHighlights(blk.groups[0], 'en', enId);
  assert.equal(enHighlights.pending.length, 1);
  assert.equal(enHighlights.checked.length, 0);

  blk = updateClausePairNoteInGroup(blk, gid, p1, '条件節OK');
  blk = toggleClausePairCheckedInGroup(blk, gid, p1, true);
  enHighlights = collectSentenceClauseHighlights(blk.groups[0], 'en', enId);
  assert.equal(enHighlights.pending.length, 0);
  assert.equal(enHighlights.checked.length, 1);

  const cov = computeClauseCoverage(blk.groups[0], blk.enSentences, blk.jaSentences);
  assert.equal(cov.totalPairs, 1);
  assert.equal(cov.checkedPairs, 1);
  assert.ok(cov.enPercent > 20 && cov.jaPercent > 20);

  // Deterministic punctuation chunker splits long EN and JA sentences cleanly
  const enChunks = suggestDeterministicClauseChunks(blk.enSentences[0].plainText, 'en');
  const jaChunks = suggestDeterministicClauseChunks(blk.jaSentences[0].plainText, 'ja');
  assert.ok(enChunks.length >= 3);
  assert.deepEqual(
    jaChunks.map((c) => c.text),
    ['チームが異常を検知した場合、', '対象ホストを隔離し、', 'ログを保全しなければならない。'],
  );

  // splitTokensByHighlights combines marker and clause states cleanly
  const tokens = tokenizeInlineMarkup('Verify *anomaly* handling.');
  const segs = splitTokensByHighlights(tokens, {
    markers: [{ start: 0, end: 6 }],
    pending: [{ start: 7, end: 14 }],
    checked: [{ start: 15, end: 25 }],
  });
  assert.ok(segs.some((s) => s.marked && s.clauseState === 'none'));
  assert.ok(segs.some((s) => s.type === 'em' && s.clauseState === 'pending'));
  assert.ok(segs.some((s) => s.clauseState === 'checked'));

  // Inline sentence edit fixes omission without breaking alignment, status, or moved clause text
  blk.groups[0].status = 'verified';
  blk = updateSentenceTextInBlock(
    blk,
    'ja',
    jaId,
    'チームが異常を検知した場合、直ちに対象ホストを隔離し、ログを保全しなければならない。',
  );
  assert.equal(blk.groups[0].status, 'verified');
  assert.match(blk.jaRaw, /直ちに/);
  assert.equal(blk.groups[0].clausePairs[0].jaSpan.start, 0);

  // Remove and clear helpers
  blk = removeClausePairInGroup(blk, gid, p1);
  assert.equal(blk.groups[0].clausePairs.length, 0);
  blk = addClausePairInGroup(blk, gid, {
    enSpan: { sentenceId: enId, start: 0, end: 10, text: 'When teams' },
  }).block;
  blk = clearClausePairsInGroup(blk, gid);
  assert.equal(blk.groups[0].clausePairs.length, 0);

  // sliceTokensByRange maps sentence markers and inline markup into clause span offsets
  const sliceTokens = tokenizeInlineMarkup('Verify *anomaly* handling daily.');
  const sliced = sliceTokensByRange(sliceTokens, [{ start: 7, end: 12 }], 5, 23);
  assert.deepEqual(sliced, [
    { type: 'text', value: 'y ', marked: false, termState: 'none', termTitle: '' },
    { type: 'em', value: 'anoma', marked: true, termState: 'none', termTitle: '' },
    { type: 'em', value: 'ly', marked: false, termState: 'none', termTitle: '' },
    { type: 'text', value: ' handling', marked: false, termState: 'none', termTitle: '' },
  ]);
});

test('Japanese translation splitting and import handle bullets without spaces, fullwidth periods, halfwidth !/?, blank-line paragraphs, URLs, and BOM', () => {
  assert.deepEqual(
    splitJapaneseSentences('・最初の項目\n・2番目の項目\n・3番目の項目'),
    ['・最初の項目', '・2番目の項目', '・3番目の項目'],
  );
  assert.deepEqual(
    splitJapaneseSentences('（1）最初の項目\n（2）2番目の項目'),
    ['（1）最初の項目', '（2）2番目の項目'],
  );
  assert.deepEqual(
    splitJapaneseSentences('①最初の項目\n②2番目の項目'),
    ['①最初の項目', '②2番目の項目'],
  );
  assert.deepEqual(
    splitJapaneseSentences('1．最初の項目\n2．2番目の項目'),
    ['1．最初の項目', '2．2番目の項目'],
  );

  // Fullwidth periods (not decimals), safe halfwidth !/?, and multi-paragraph headings
  assert.deepEqual(
    splitJapaneseSentences('第2．0版の説明です．次の文です．'),
    ['第2．0版の説明です．', '次の文です．'],
  );
  assert.deepEqual(
    splitJapaneseSentences('本当に実行しますか? はい、実行します。Yahoo! JAPANも保持する。'),
    ['本当に実行しますか?', 'はい、実行します。', 'Yahoo! JAPANも保持する。'],
  );
  assert.deepEqual(
    splitJapaneseSentences('第1章 概要\n\nシステムは異常を検知する。通知を送信する。'),
    ['第1章 概要', 'システムは異常を検知する。', '通知を送信する。'],
  );

  // Language classifier ignores URLs and classifies short JA headings accurately
  assert.equal(
    classifyLanguage('URLは https://example.com/search?q=test&lang=ja です。次の文。').lang,
    'ja',
  );
  assert.equal(classifyLanguage('TLS/HTTP2 の設定').lang, 'ja');

  // BOM stripping on block import & preserving list newlines on group insertion
  const bomBlocks = splitIntoRawBlocks('\uFEFFFirst English item.\nSecond English item.\n\n\uFEFF・最初の項目\n・2番目の項目');
  assert.equal(bomBlocks.length, 2);
  assert.equal(bomBlocks[0].rawText.startsWith('\uFEFF'), false);
  assert.equal(bomBlocks[1].effectiveLang, 'ja');

  const enOnly = parseDocumentBlocks('First bullet.\nSecond bullet.', { inputMode: 'english_only' });
  const filled = updateBlockJapaneseText(enOnly[0], '\uFEFF・1つ目の項目\n・2つ目の項目');
  assert.equal(filled.jaSentences.length, 2);
  assert.ok(!filled.warnings.includes('UNMATCHED_COUNT'));

  const editedList = updateSentenceTextInBlock(filled, 'ja', filled.jaSentences[0].id, '・1つ目の項目（修正）');
  assert.equal(editedList.jaRaw, '・1つ目の項目（修正）\n・2つ目の項目');
});

test('Single numbered clauses split sentences automatically and splitInsideList handles multi-clause legal paragraphs', () => {
  // Single (1) paragraph with multiple sentences always splits on sentence boundaries
  assert.deepEqual(
    splitJapaneseSentences('（1）事業者は当局へ通知しなければならない。報告書には影響範囲を含めなければならない。'),
    ['（1）事業者は当局へ通知しなければならない。', '報告書には影響範囲を含めなければならない。'],
  );
  assert.deepEqual(
    splitEnglishSentences('(1) The operator shall notify the authority. The report shall include details.'),
    ['(1) The operator shall notify the authority.', 'The report shall include details.'],
  );

  // Leading item number "1." / "1．" is preserved with its sentence instead of splitting into "1." alone
  assert.deepEqual(
    splitEnglishSentences('1. First requirement applies immediately. Additional logs are required.'),
    ['1. First requirement applies immediately.', 'Additional logs are required.'],
  );
  assert.deepEqual(
    splitJapaneseSentences('1．最初の要件は直ちに適用される。追加ログが必要となる。'),
    ['1．最初の要件は直ちに適用される。', '追加ログが必要となる。'],
  );

  // Multi-clause legal block toggles cleanly between line-based items and sentence-level splitting
  const legalEn = '(1) First clause begins. First clause continues.\n(2) Second clause begins. Second clause continues.';
  const legalJa = '（1）第1項の文A。第1項の文B。\n（2）第2項の文A。第2項の文B。';
  assert.equal(splitEnglishSentences(legalEn, { splitInsideList: false }).length, 2);
  assert.equal(splitJapaneseSentences(legalJa, { splitInsideList: false }).length, 2);
  assert.deepEqual(splitEnglishSentences(legalEn, { splitInsideList: true }), [
    '(1) First clause begins.',
    'First clause continues.',
    '(2) Second clause begins.',
    'Second clause continues.',
  ]);
  assert.deepEqual(splitJapaneseSentences(legalJa, { splitInsideList: true }), [
    '（1）第1項の文A。',
    '第1項の文B。',
    '（2）第2項の文A。',
    '第2項の文B。',
  ]);

  const blk = buildAlignmentBlock(legalEn, legalJa, 0, { splitInsideList: true });
  assert.equal(blk.enSentences.length, 4);
  assert.equal(blk.jaSentences.length, 4);
  assert.equal(blk.groups.length, 4);
});

test('Unified TM/Glossary span highlighters resolve exact EN/JA offsets, overlaps, token slicing, and phrase TMX export', () => {
  // 1. English inflections & variants return exact offsets
  const enText = 'Teams triaged coordinated vulnerability disclosure advisories.';
  const triageSpans = findEnglishGlossarySpans(enText, {
    enHeadword: 'triage',
    enVariants: [],
    caseSensitive: false,
  });
  assert.deepEqual(triageSpans, [{ start: 6, end: 13, text: 'triaged' }]);

  // 2. Japanese span mapper preserves exact source offsets across width, long vowel, and okurigana normalization
  const jaText1 = '脆弱性アドバイザリーと引き継ぎ手順を確認する。';
  const advSpans = findJapaneseTermSpans(jaText1, 'アドバイザリ');
  assert.deepEqual(advSpans, [{ start: 3, end: 10, text: 'アドバイザリー' }]);
  const handSpans = findJapaneseTermSpans(jaText1, '引継手順');
  assert.deepEqual(handSpans, [{ start: 11, end: 17, text: '引き継ぎ手順' }]);

  const jaText2 = 'ＮＩＳＴの引継を確認。';
  const nistSpans = findJapaneseTermSpans(jaText2, 'NIST');
  assert.deepEqual(nistSpans, [{ start: 0, end: 4, text: 'ＮＩＳＴ' }]);
  const okuriSpans = findJapaneseTermSpans(jaText2, '引き継ぎ');
  assert.deepEqual(okuriSpans, [{ start: 5, end: 7, text: '引継' }]);

  // 3. collectGroupHighlightSpans underlines EN matches, corresponding JA matches, deprecated JA warnings, and resolves overlaps
  const entries = [
    {
      id: 'g_cvd',
      enHeadword: 'coordinated vulnerability disclosure',
      enVariants: ['CVD'],
      jaAccepted: ['協調的な脆弱性情報開示'],
      jaDeprecated: [],
      caseSensitive: false,
      notes: '正式訳',
    },
    {
      id: 'g_vuln',
      enHeadword: 'vulnerability',
      enVariants: [],
      jaAccepted: ['脆弱性'],
      jaDeprecated: [],
      caseSensitive: false,
      notes: '',
    },
    {
      id: 'g_triage',
      enHeadword: 'triage',
      enVariants: [],
      jaAccepted: ['トリアージ'],
      jaDeprecated: ['選別'],
      caseSensitive: false,
      notes: '',
    },
    {
      id: 'g_unused',
      enHeadword: 'quarantine',
      enVariants: [],
      jaAccepted: ['隔離'],
      jaDeprecated: [],
      caseSensitive: false,
      notes: '',
    },
  ];

  // Note: "隔離" appears in JA even though "quarantine" does NOT appear in EN -> should NOT be underlined as matched
  const blk = buildAlignmentBlock(
    'We follow coordinated vulnerability disclosure rules.',
    '協調的な脆弱性情報開示の方針に従い、隔離せず選別する。',
    0,
  );
  const { enSpansBySentenceId, jaSpansBySentenceId } = collectGroupHighlightSpans(
    blk.enSentences,
    blk.jaSentences,
    entries,
  );
  const enSpans = enSpansBySentenceId.get(blk.enSentences[0].id);
  const jaSpans = jaSpansBySentenceId.get(blk.jaSentences[0].id);

  // Longer "coordinated vulnerability disclosure" wins over nested "vulnerability"
  assert.equal(enSpans.length, 1);
  assert.equal(
    blk.enSentences[0].plainText.slice(enSpans[0].start, enSpans[0].end),
    'coordinated vulnerability disclosure',
  );
  assert.equal(enSpans[0].status, 'matched');

  // Longer "協調的な脆弱性情報開示" wins over nested "脆弱性"; "選別" is deprecated; "隔離" is omitted (not matched on EN)
  assert.equal(jaSpans.length, 2);
  assert.equal(
    blk.jaSentences[0].plainText.slice(jaSpans[0].start, jaSpans[0].end),
    '協調的な脆弱性情報開示',
  );
  assert.equal(jaSpans[0].status, 'matched');
  assert.equal(blk.jaSentences[0].plainText.slice(jaSpans[1].start, jaSpans[1].end), '選別');
  assert.equal(jaSpans[1].status, 'deprecated');

  // 4. splitTokensByHighlights & sliceTokensByRange preserve term underlines across inline markup
  const tokens = tokenizeInlineMarkup('Verify *triage* status.');
  const segs = splitTokensByHighlights(tokens, {
    markers: [{ start: 0, end: 13 }],
    terms: [{ start: 7, end: 13, status: 'matched', title: '登録済: triage ⇔ トリアージ' }],
  });
  const triageSeg = segs.find((s) => s.value === 'triage');
  assert.ok(triageSeg);
  assert.equal(triageSeg.type, 'em');
  assert.equal(triageSeg.marked, true);
  assert.equal(triageSeg.termState, 'matched');
  assert.match(triageSeg.termTitle, /トリアージ/);

  const sliced = sliceTokensByRange(
    tokens,
    [{ start: 0, end: 13 }],
    4,
    15,
    [{ start: 7, end: 13, status: 'matched', title: '登録済: triage ⇔ トリアージ' }],
  );
  assert.equal(sliced.map((s) => s.value).join(''), 'fy triage s');
  const slicedTerm = sliced.find((s) => s.value === 'triage');
  assert.ok(slicedTerm);
  assert.equal(slicedTerm.termState, 'matched');
  assert.equal(slicedTerm.marked, true);

  // 5. exportTmAsTmx exports unified phrase glossary entries cleanly
  const tmx = exportTmAsTmx([
    {
      id: 'g1',
      enHeadword: 'incident response & recovery',
      jaAccepted: ['インシデント対応と復旧'],
      notes: '統一表現',
    },
  ]);
  assert.match(tmx, /segtype="phrase"/);
  assert.match(tmx, /<tuv xml:lang="en"><seg>incident response &amp;amp; recovery<\/seg><\/tuv>|<tuv xml:lang="en"><seg>incident response &amp; recovery<\/seg><\/tuv>/);
  assert.match(tmx, /<tuv xml:lang="ja"><seg>インシデント対応と復旧<\/seg><\/tuv>/);
});

test('Fuzzy Japanese typo detector catches 1-char substitutions, omissions, insertions, adjacent swaps, and respects boundary guards', () => {
  // 1. 6-char word, 4th char substitution (セキュリティ -> セキュラティ)
  const subHits = findJapaneseFuzzyTermSpans('セキュラティ対策を実施する。', 'セキュリティ');
  assert.equal(subHits.length, 1);
  assert.equal(subHits[0].text, 'セキュラティ');
  assert.match(subHits[0].diffSummary, /誤記/);

  // 2. 6-char word with 1 char missing (アドバイザリ -> アドバザリー) with long vowel offset preserved
  const delHits = findJapaneseFuzzyTermSpans('脆弱性アドバザリーを公開する。', 'アドバイザリ');
  assert.equal(delHits.length, 1);
  assert.equal(delHits[0].text, 'アドバザリー');
  assert.match(delHits[0].diffSummary, /欠落/);

  // 3. 1 extra char insertion (セキュリティ -> セキュウリティ)
  const insHits = findJapaneseFuzzyTermSpans('セキュウリティ要件を確認。', 'セキュリティ');
  assert.equal(insHits.length, 1);
  assert.equal(insHits[0].text, 'セキュウリティ');
  assert.match(insHits[0].diffSummary, /余分/);

  // 4. Adjacent swap / transposition (インシデント -> インデシント)
  const swapHits = findJapaneseFuzzyTermSpans('インデシント対応を開始。', 'インシデント');
  assert.equal(swapHits.length, 1);
  assert.equal(swapHits[0].text, 'インデシント');
  assert.match(swapHits[0].diffSummary, /入れ替え/);

  // 5. Particle/punctuation boundary is trimmed cleanly (アドバイザを -> アドバイザ, not including を)
  const particleHits = findJapaneseFuzzyTermSpans('最新のアドバイザを公開する。', 'アドバイザリ');
  assert.equal(particleHits.length, 1);
  assert.equal(particleHits[0].text, 'アドバイザ');

  // 6. 9+ char phrase allows up to 2 edits (協調的な脆弱性情報開示 -> 協調的な脆性情報開始)
  const longHits = findJapaneseFuzzyTermSpans(
    '協調的な脆性情報開始の手順に従う。',
    '協調的な脆弱性情報開示',
  );
  assert.equal(longHits.length, 1);
  assert.equal(longHits[0].edits, 2);

  // 7. Exact matches are never flagged as typos
  assert.equal(findJapaneseFuzzyTermSpans('セキュリティアドバイザリーを公開する。', 'アドバイザリ').length, 0);
});

test('Fuzzy typo check honors ON/OFF toggle, 3-char minLength option, highlight spans, and dismissal state', () => {
  const glossary = [
    {
      id: 'g_adv',
      enHeadword: 'advisory',
      enVariants: [],
      jaAccepted: ['アドバイザリ'],
      jaDeprecated: [],
      caseSensitive: false,
    },
    {
      id: 'g_vuln',
      enHeadword: 'vulnerability',
      enVariants: [],
      jaAccepted: ['脆弱性'], // 3 chars
      jaDeprecated: [],
      caseSensitive: false,
    },
  ];

  // Default: fuzzyTypoCheck = true, fuzzyMinLength = 4 -> catches アドバザリー (6 chars), ignores 脆弱生 (3 chars)
  const resDefault = checkGroupGlossary(
    'Publish the vulnerability advisory.',
    '脆弱生のアドバザリーを公開する。',
    glossary,
  );
  assert.equal(resDefault.fuzzyTypos.length, 1);
  assert.equal(resDefault.fuzzyTypos[0].span.text, 'アドバザリー');
  assert.equal(resDefault.missingAccepted.length, 1); // 脆弱性 falls back to missingAccepted when minLen=4

  // Min length = 3 -> catches both
  const resMin3 = checkGroupGlossary(
    'Publish the vulnerability advisory.',
    '脆弱生のアドバザリーを公開する。',
    glossary,
    { normalizeWidth: true, normalizeLongVowel: true, normalizeOkurigana: true, fuzzyTypoCheck: true, fuzzyMinLength: 3 },
  );
  assert.equal(resMin3.fuzzyTypos.length, 2);
  assert.equal(resMin3.missingAccepted.length, 0);

  // OFF toggle disables fuzzy detection completely
  const resOff = checkGroupGlossary(
    'Publish the vulnerability advisory.',
    '脆弱生のアドバザリーを公開する。',
    glossary,
    { normalizeWidth: true, normalizeLongVowel: true, normalizeOkurigana: true, fuzzyTypoCheck: false, fuzzyMinLength: 4 },
  );
  assert.equal(resOff.fuzzyTypos.length, 0);
  assert.equal(resOff.missingAccepted.length, 2);

  // Highlight spans mark 'typo' and respect dismissedHints
  const blk = buildAlignmentBlock('Read the advisory.', '最新のアドバザリーを読む。', 0);
  const hintId = buildGlossaryTypoHintId(blk.groups[0].id, 'g_adv', 'アドバザリー', 'アドバイザリ');

  const activeHighlights = collectGroupHighlightSpans(
    blk.enSentences,
    blk.jaSentences,
    glossary,
    undefined,
    { groupId: blk.groups[0].id, dismissedHints: {} },
  );
  const jaActive = activeHighlights.jaSpansBySentenceId.get(blk.jaSentences[0].id);
  assert.equal(jaActive.length, 1);
  assert.equal(jaActive[0].status, 'typo');

  const dismissedHighlights = collectGroupHighlightSpans(
    blk.enSentences,
    blk.jaSentences,
    glossary,
    undefined,
    { groupId: blk.groups[0].id, dismissedHints: { [hintId]: true } },
  );
  assert.equal((dismissedHighlights.jaSpansBySentenceId.get(blk.jaSentences[0].id) || []).length, 0);

  // Token splitter preserves 'typo' termState
  const segs = splitTokensByHighlights(tokenizeInlineMarkup('最新のアドバザリーを読む。'), {
    terms: jaActive,
  });
  assert.ok(segs.some((s) => s.value === 'アドバザリー' && s.termState === 'typo'));
});

test('mergeWithNextBlockAndBoundarySentences merges block and boundary sentences in one step', () => {
  // 1) 'both': Block 0 and Block 1 split mid-sentence across a blank line
  const b0 = buildAlignmentBlock('The first half', '前半の和文', 0);
  b0.enSentences[0].markers = [{ start: 0, end: 3, color: 'yellow' }];
  b0.groups[0].status = 'read';
  b0.groups[0].memo = 'メモA';

  const b1 = buildAlignmentBlock('of the sentence. Next sentence.', '後半の和文。次の和文です。', 1);
  b1.enSentences[0].markers = [{ start: 0, end: 2, color: 'green' }];
  b1.groups[0].memo = 'メモB';
  b1.groups[1].status = 'verified';

  const b2 = buildAlignmentBlock('Third block.', '第3ブロック。', 2);

  const mergedBoth = mergeWithNextBlockAndBoundarySentences([b0, b1, b2], 0, [], {
    mergeLangs: 'both',
  });
  assert.equal(mergedBoth.length, 2);
  assert.equal(mergedBoth[0].index, 0);
  assert.equal(mergedBoth[1].index, 1);

  const m = mergedBoth[0];
  assert.equal(m.enRaw, 'The first half of the sentence. Next sentence.');
  assert.equal(m.jaRaw, '前半の和文後半の和文。次の和文です。');
  assert.equal(m.enSentences.length, 2);
  assert.equal(m.jaSentences.length, 2);
  assert.equal(m.enSentences[0].plainText, 'The first half of the sentence.');
  assert.equal(m.jaSentences[0].plainText, '前半の和文後半の和文。');
  assert.equal(m.enSentences[1].plainText, 'Next sentence.');
  assert.equal(m.jaSentences[1].plainText, '次の和文です。');

  // Preserves markers, status, and merges boundary memos cleanly
  assert.equal(m.enSentences[0].markers.length, 2);
  assert.equal(m.groups.length, 2);
  assert.equal(m.groups[0].status, 'read');
  assert.equal(m.groups[0].memo, 'メモA\nメモB');
  assert.equal(m.groups[1].status, 'verified');

  // 2) 'en' only with orphan bridging: EN-only tail in Block 0 + paired head in Block 1
  const eOnly0 = buildAlignmentBlock('Split start', '', 0);
  const pair1 = buildAlignmentBlock('split end.', '対応する和文。', 1);
  const mergedEnOnly = mergeWithNextBlockAndBoundarySentences([eOnly0, pair1], 0, [], {
    mergeLangs: 'en',
  });
  assert.equal(mergedEnOnly.length, 1);
  assert.equal(mergedEnOnly[0].enSentences.length, 1);
  assert.equal(mergedEnOnly[0].enSentences[0].plainText, 'Split start split end.');
  assert.equal(mergedEnOnly[0].jaSentences.length, 1);
  assert.equal(mergedEnOnly[0].groups.length, 1);
  assert.deepEqual(mergedEnOnly[0].groups[0].jaIds, [mergedEnOnly[0].jaSentences[0].id]);

  // 3) Disjoint blocks fallback (EN-only + JA-only): falls back to standard structural merge
  const enOrphan = buildAlignmentBlock('Only English.', '', 0);
  const jaOrphan = buildAlignmentBlock('', '日本語のみ。', 1);
  const fallbackMerged = mergeWithNextBlockAndBoundarySentences([enOrphan, jaOrphan], 0, [], {
    mergeLangs: 'both',
  });
  assert.equal(fallbackMerged.length, 1);
  assert.equal(fallbackMerged[0].enSentences.length, 1);
  assert.equal(fallbackMerged[0].jaSentences.length, 1);
  assert.equal(fallbackMerged[0].groups.length, 1);
});

test('virtual-window computes visible index range, spacer heights, and scroll anchoring deterministically', () => {
  const blocks = Array.from({ length: 10 }, (_, i) => ({ id: `b_${i}` }));
  const heights = new Map([
    ['b_0', 300],
    ['b_1', 300],
    ['b_2', 400],
    ['b_3', 200],
    ['b_4', 250],
  ]);

  // Empty list edge case
  assert.deepEqual(
    computeVirtualWindowRange([], heights, { viewTop: 500, clientHeight: 600 }),
    { startIdx: 0, endIdx: 0, topHeight: 0, bottomHeight: 0 },
  );

  // Scrolled near top with overscan covering first items
  const rTop = computeVirtualWindowRange(blocks, heights, {
    viewTop: 0,
    clientHeight: 500,
    defaultBlockHeight: 280,
    overscanPx: 300,
  });
  assert.equal(rTop.startIdx, 0);
  assert.equal(rTop.topHeight, 0);
  assert.ok(rTop.endIdx >= 3 && rTop.endIdx <= 5);
  assert.ok(rTop.bottomHeight > 0);

  // Scrolled to middle: items above viewTop - overscan contribute to topHeight
  // Cumulative heights: b_0(300), b_1(600), b_2(1000), b_3(1200), b_4(1450), b_5(1730), b_6(2010)...
  const rMid = computeVirtualWindowRange(blocks, heights, {
    viewTop: 1200,
    clientHeight: 400,
    defaultBlockHeight: 280,
    overscanPx: 200,
  });
  // viewTop - overscan = 1000 -> b_0(300 < 1000), b_1(600 < 1000), b_2(1000 is not < 1000) => startIdx = 2
  assert.equal(rMid.startIdx, 2);
  assert.equal(rMid.topHeight, 600);
  // viewBottom + overscan = 1800 -> b_6 starts at 1730 <= 1800, b_7 starts at 2010 > 1800 => endIdx = 7
  assert.equal(rMid.endIdx, 7);
  assert.equal(rMid.bottomHeight, 280 * 3);

  // Scroll anchoring ignores tiny jitter (< 2px) and top=0
  assert.equal(computeAnchoredScrollTop(0, 10, 50), null);
  assert.equal(computeAnchoredScrollTop(500, 100, 101.5), null);
  assert.equal(computeAnchoredScrollTop(500, 100, 140), 540);
  assert.equal(computeAnchoredScrollTop(20, 100, 50), 0);
});

test('Per-entry exactMatch disables automatic inflection matching to separate singular and plural entries', () => {
  const entries = [
    {
      id: 'g_sg',
      enHeadword: 'policy',
      enVariants: [],
      jaAccepted: ['方針'],
      jaDeprecated: [],
      caseSensitive: false,
      exactMatch: true,
    },
    {
      id: 'g_pl',
      enHeadword: 'policies',
      enVariants: [],
      jaAccepted: ['諸方針'],
      jaDeprecated: [],
      caseSensitive: false,
      exactMatch: true,
    },
  ];

  // Singular sentence matches ONLY singular entry without triggering false missing on plural entry
  const sgRes = checkGroupGlossary('Review the policy.', '方針を確認する。', entries);
  assert.equal(sgRes.hasIssues, false);
  assert.equal(sgRes.matchedOk.length, 1);
  assert.equal(sgRes.matchedOk[0].entry.id, 'g_sg');
  assert.equal(sgRes.missingAccepted.length, 0);

  // Plural sentence matches ONLY plural entry without triggering false missing on singular entry
  const plRes = checkGroupGlossary('Review the policies.', '諸方針を確認する。', entries);
  assert.equal(plRes.hasIssues, false);
  assert.equal(plRes.matchedOk.length, 1);
  assert.equal(plRes.matchedOk[0].entry.id, 'g_pl');
  assert.equal(plRes.missingAccepted.length, 0);

  // Highlight spans respect exactMatch
  const blk = buildAlignmentBlock('Review the policy.', '方針を確認する。', 0);
  const hl = collectGroupHighlightSpans(blk.enSentences, blk.jaSentences, entries);
  const enSpans = hl.enSpansBySentenceId.get(blk.enSentences[0].id) || [];
  assert.equal(enSpans.length, 1);
  assert.match(enSpans[0].title, /policy ⇔ 方針/);

  // Legacy entries without exactMatch keep automatic inflection matching
  const legacyRes = checkGroupGlossary('Review the policies.', '方針を確認する。', [
    {
      id: 'g_legacy',
      enHeadword: 'policy',
      enVariants: [],
      jaAccepted: ['方針'],
      jaDeprecated: [],
      caseSensitive: false,
    },
  ]);
  assert.equal(legacyRes.hasIssues, false);
  assert.equal(legacyRes.matchedOk.length, 1);

  // CSV/TSV round-trip preserves exactMatch, and legacy 6-column CSV defaults exactMatch to false
  const tsv = serializeGlossaryDelimited(entries, '\t');
  const parsed = parseGlossaryDelimited(tsv, 'auto');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].exactMatch, true);
  assert.equal(parsed[1].exactMatch, true);

  const legacyCsv =
    'enHeadword,jaAccepted,jaDeprecated,enVariants,caseSensitive,notes\ntriage,トリアージ,選別,triaged,false,メモ';
  const parsedLegacy = parseGlossaryDelimited(legacyCsv, ',');
  assert.equal(parsedLegacy.length, 1);
  assert.equal(parsedLegacy[0].exactMatch, false);
  assert.equal(parsedLegacy[0].notes, 'メモ');
});

test('extractTermCandidates supports up to 7-grams, >40 maxResults, minN filtering, and full-span glossary matching', () => {
  const longPhrase = 'United Nations Framework Convention on Climate Change';
  const blocks = parseDocumentBlocks(
    `${longPhrase} applies broadly.\n\n国連気候変動枠組条約は広く適用される。\n\n${longPhrase} guides reporting.\n\n国連気候変動枠組条約は報告の指針となる。`,
  );

  // Extract 4-7 grams and check 7-gram candidate
  const longOnly = extractTermCandidates(
    blocks,
    [{ enHeadword: 'convention', enVariants: [], jaAccepted: ['条約'], jaDeprecated: [] }],
    { minFreq: 2, minN: 4, maxN: 7, maxResults: 200 },
  );
  const sevenGram = longOnly.find((c) => c.enTerm === longPhrase);
  assert.ok(sevenGram);
  assert.equal(sevenGram.wordCount, 7);
  assert.equal(sevenGram.count, 2);
  // Single-word glossary entry "convention" must NOT falsely mark the 7-gram phrase as already registered
  assert.equal(sevenGram.alreadyInGlossary, false);
  assert.ok(sevenGram.jaCandidates.some((j) => j.jaTerm.includes('国連気候変動枠組条約')));

  // Registered 1-word entry itself should still be marked alreadyInGlossary: true
  const allN = extractTermCandidates(
    blocks,
    [{ enHeadword: 'convention', enVariants: [], jaAccepted: ['条約'], jaDeprecated: [] }],
    { minFreq: 2, minN: 1, maxN: 7, maxResults: 200 },
  );
  const singleRegistered = allN.find((c) => c.enTerm.toLowerCase() === 'convention');
  assert.ok(singleRegistered);
  assert.equal(singleRegistered.alreadyInGlossary, true);
  assert.ok(allN.every((c) => c.wordCount >= 1 && c.wordCount <= 7));

  // Verify >40 results can be returned
  const manyWords = Array.from({ length: 55 }, (_, i) => `termword${String(i).padStart(2, '0')}`).join(' ');
  const manyBlocks = parseDocumentBlocks(
    `${manyWords}.\n\nテスト文一。\n\n${manyWords}.\n\nテスト文二。`,
  );
  const overForty = extractTermCandidates(manyBlocks, [], {
    minFreq: 2,
    minN: 1,
    maxN: 7,
    maxResults: 200,
  });
  assert.ok(overForty.length > 40);
});

test('XLIFF 2.1 export/import preserves n:m alignment groups, states, notes, markers, <cp>, IRI original, and conditional trgLang', () => {
  let blk0 = buildAlignmentBlock(
    'Alpha & Beta <check>\u0003.',
    'アルファ＆ベータの確認。',
    0,
  );
  blk0 = updateSentenceMarkersInBlock(blk0, 'en', blk0.enSentences[0].id, (prev, max) =>
    addMarkerRange(prev, 0, 5, max),
  );
  blk0.groups[0] = {
    ...blk0.groups[0],
    status: 'verified',
    memo: '確定メモ\n2行目',
    tempNoOmission: true,
  };

  let blk1 = buildAlignmentBlock(
    'First source. Second source. Unmatched EN.',
    '結合訳文です。対応なし和文。',
    1,
  );
  // Create 2:1 group + 1:0 + 0:1
  blk1 = moveSentenceToGroup(blk1, 'en', blk1.enSentences[1].id, blk1.groups[0].id);
  blk1.groups[0] = { ...blk1.groups[0], status: 'needs_review', memo: '2対1の確認' };
  const thirdEnGroup = blk1.groups.find((g) => g.enIds.includes(blk1.enSentences[2].id));
  if (thirdEnGroup) thirdEnGroup.status = 'verified';
  const unmatchedJaGroup = blk1.groups.find((g) => g.enIds.length === 0 && g.jaIds.length === 1);
  if (unmatchedJaGroup) unmatchedJaGroup.status = 'read';

  const project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'doc_xliff_test',
    title: 'XLIFF テスト <v2.1>',
    blocks: [blk0, blk1],
  };

  const xliff = exportProjectToXliff21(project);
  assert.ok(xliff.includes(`xmlns="${XLIFF_21_NAMESPACE}"`));
  assert.ok(xliff.includes('version="2.1"'));
  assert.ok(xliff.includes('trgLang="ja"'));
  // #5: original must be IRI-safe (no raw '<' or spaces)
  assert.ok(!/original="[^"]*[< ]/.test(xliff));
  // #4: custom annotation type without comment value
  assert.ok(xliff.includes('type="bitextfolio:marker"'));
  assert.ok(!xliff.includes('value="bitextfolio:marker"'));
  // #3: invalid XML control character encoded as <cp hex="0003"/>
  assert.ok(xliff.includes('</mrk> &amp; Beta &lt;check&gt;<cp hex="0003"/>.'));
  // #2: canResegment="no" and Option B explanatory note on n:m groups (without polluting memo on round-trip)
  assert.ok(xliff.includes('canResegment="no"'));
  assert.ok(xliff.includes('category="bitextfolio:alignmentNote"'));
  assert.ok(xliff.includes('BitextFolio 2:1 alignment group'));
  // #1: verified segment WITH target uses state="final"; segment WITHOUT target MUST use state="initial"
  assert.ok(xliff.includes('state="final" subState="bitextfolio:verified"'));
  assert.ok(xliff.includes('state="initial" subState="bitextfolio:verified"'));
  assert.ok(xliff.includes('state="initial" subState="bitextfolio:needs_review"'));

  const { project: imported, summary } = parseXliff21ToProject(xliff);
  assert.equal(imported.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(imported.title, 'XLIFF テスト <v2.1>');
  assert.equal(summary.blocksCount, 2);
  assert.equal(imported.blocks[0].enSentences[0].plainText, 'Alpha & Beta <check>\u0003.');
  assert.equal(imported.blocks[0].enSentences[0].literalText, true);
  assert.deepEqual(imported.blocks[0].enSentences[0].markers, [{ start: 0, end: 5 }]);
  assert.equal(imported.blocks[0].groups[0].status, 'verified');
  assert.equal(imported.blocks[0].groups[0].memo, '確定メモ\n2行目');
  assert.equal(imported.blocks[0].groups[0].tempNoOmission, true);

  // Verify 2:1, 1:0 (still verified via subState), and 0:1 groups survived round-trip without alignmentNote leaking into memo
  const impGrp2to1 = imported.blocks[1].groups[0];
  assert.equal(impGrp2to1.enIds.length, 2);
  assert.equal(impGrp2to1.jaIds.length, 1);
  assert.equal(impGrp2to1.status, 'needs_review');
  assert.equal(impGrp2to1.memo, '2対1の確認');
  assert.ok(!summary.droppedFeatures.some((f) => f.includes('alignmentNote')));
  assert.ok(
    imported.blocks[1].groups.some(
      (g) => g.enIds.length === 1 && g.jaIds.length === 0 && g.status === 'verified',
    ),
  );
  assert.ok(
    imported.blocks[1].groups.some(
      (g) => g.enIds.length === 0 && g.jaIds.length === 1 && g.status === 'read',
    ),
  );

  // #6: English-only document without targets must omit trgLang
  const enOnlyBlocks = parseDocumentBlocks('Only source sentence.', { inputMode: 'english_only' });
  const enOnlyXliff = exportProjectToXliff21({
    schemaVersion: 2,
    id: 'doc_en_only',
    title: 'EN only',
    blocks: enOnlyBlocks,
  });
  assert.equal(enOnlyXliff.includes('trgLang='), false);
});

test('XLIFF 2.1 importer handles CAT files, target order, xml:space, multi-file unit ID collision, lang/ns checks, literalText, and lossy summary', () => {
  const catXliff = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en-US" trgLang="ja-JP">
  <file id="f1" original="cat_sample.txt">
    <notes><note category="context">File level note</note></notes>
    <unit id="1">
      <notes>
        <note category="reviewer">Check terminology</note>
      </notes>
      <segment id="s1" state="reviewed">
        <source>
          Use <pc id="1">strong</pc>
          passwords<ph id="2"/>.
        </source>
        <target order="2">後半の訳。</target>
      </segment>
      <segment id="s2" state="reviewed">
        <source xml:space="preserve">Keep  spaces.</source>
        <target order="1">前半の訳。</target>
      </segment>
      <ignorable><source> </source></ignorable>
    </unit>
  </file>
  <file id="f2" original="second.txt">
    <unit id="1">
      <segment id="s1" state="final">
        <source>Check <mrk id="m1" type="bitextfolio:marker">foo_bar_baz</mrk> and *literal*.</source>
        <target>foo_bar_baz と *文字列* を確認。</target>
      </segment>
    </unit>
  </file>
</xliff>`;

  const { project, summary } = parseXliff21ToProject(catXliff);
  assert.equal(project.title, 'cat_sample.txt');
  assert.equal(project.blocks.length, 2);
  // #10: xml:space="default" collapses indentation; xml:space="preserve" keeps double spaces
  assert.equal(project.blocks[0].enSentences[0].plainText, 'Use strong passwords.');
  assert.equal(project.blocks[0].enSentences[1].plainText, 'Keep  spaces.');
  // #7: <target order="2"> / <target order="1"> reordered JA sentences cleanly
  assert.equal(project.blocks[0].jaSentences[0].plainText, '前半の訳。');
  assert.equal(project.blocks[0].jaSentences[1].plainText, '後半の訳。');
  assert.equal(project.blocks[0].groups[0].memo, '[reviewer] Check terminology');
  // external state="reviewed" maps to 'read'; state="final" maps to 'verified' per owner confirmation
  assert.equal(project.blocks[0].groups[0].status, 'read');
  assert.equal(project.blocks[1].groups[0].status, 'verified');
  // #8: unit id="1" in f1 and f2 get distinct BitextFolio group IDs while keeping provenance
  assert.notEqual(project.blocks[0].groups[0].id, project.blocks[1].groups[0].id);
  assert.equal(project.blocks[0].groups[0].xliffFileId, 'f1');
  assert.equal(project.blocks[0].groups[0].xliffUnitId, '1');
  assert.equal(project.blocks[1].groups[0].xliffFileId, 'f2');
  assert.equal(project.blocks[1].groups[0].xliffUnitId, '1');
  // (b) literalText preserves snake_case underscores and literal asterisks without offset skew
  const litEn = project.blocks[1].enSentences[0];
  const litJa = project.blocks[1].jaSentences[0];
  assert.equal(litEn.literalText, true);
  assert.equal(litEn.plainText, 'Check foo_bar_baz and *literal*.');
  assert.deepEqual(litEn.markers, [{ start: 6, end: 17 }]);
  assert.equal(litJa.plainText, 'foo_bar_baz と *文字列* を確認。');
  // Splitting a literalText sentence preserves literalText and underscores/asterisks
  const splitLitBlk = splitSentenceInBlock(project.blocks[1], 'en', litEn.id, 18);
  assert.equal(splitLitBlk.enSentences[0].literalText, true);
  assert.equal(splitLitBlk.enSentences[0].plainText, 'Check foo_bar_baz');
  assert.equal(splitLitBlk.enSentences[1].literalText, true);
  assert.equal(splitLitBlk.enSentences[1].plainText, 'and *literal*.');
  // Glossary & hints respect literalText (no stripping of _bar_ or *文字列*)
  const gCheckLit = checkGroupGlossary(
    litEn.plainText,
    litJa.plainText,
    [{ id: 'g_snake', enHeadword: 'foo_bar_baz', jaAccepted: ['foo_bar_baz'], jaDeprecated: [] }],
    undefined,
    { literalText: true },
  );
  assert.equal(gCheckLit.matchedOk.length, 1);
  assert.equal(gCheckLit.hasIssues, false);
  const hCheckLit = detectGroupHints(project.blocks[1].groups[0], project.blocks[1]);
  assert.equal(hCheckLit.hasActiveHints, false);
  // #11: lossy summary notifies dropped inline codes, <ignorable>, and file-level notes
  assert.ok(summary.droppedFeatures.some((f) => f.includes('インラインタグ')));
  assert.ok(summary.droppedFeatures.some((f) => f.includes('<ignorable>')));
  assert.ok(summary.droppedFeatures.some((f) => f.includes('<file>/<group>')));

  // #9 & security rejections
  assert.throws(
    () => parseXliff21ToProject('<!DOCTYPE xliff><xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.1" srcLang="en"><file id="1"><unit id="u"><segment><source>a</source></segment></unit></file></xliff>'),
    /DOCTYPE/,
  );
  assert.throws(
    () => parseXliff21ToProject('<xliff version="2.1" srcLang="en"><file id="1"><unit id="u"><segment><source>a</source></segment></unit></file></xliff>'),
    /名前空間/,
  );
  assert.throws(
    () => parseXliff21ToProject('<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="1.2" srcLang="en"><file original="a"><body><trans-unit id="1"><source>a</source></trans-unit></body></file></xliff>'),
    /XLIFF 2\.0 \/ 2\.1/,
  );
  assert.throws(
    () => parseXliff21ToProject('<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.1" srcLang="ja" trgLang="en"><file id="1"><unit id="u"><segment><source>a</source></segment></unit></file></xliff>'),
    /言語方向が逆/,
  );
  assert.throws(
    () => parseXliff21ToProject('<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.1" srcLang="de" trgLang="fr"><file id="1"><unit id="u"><segment><source>a</source></segment></unit></file></xliff>'),
    /未対応の言語ペア/,
  );
});

test('JSON Schema validation and stepwise v1 -> v2 migration handle legacy fixtures and reject invalid payloads', () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const schemaJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'schemas', 'bitextfolio-export.schema.json'), 'utf8'),
  );
  assert.equal(schemaJson.properties.schemaVersion.const, CURRENT_SCHEMA_VERSION);

  // Legacy v1 export fixture missing v2 fields (plainText, markers, clausePairs, tempNoOmission, exactMatch, fuzzyTypoCheck)
  const v1Payload = {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    type: 'workspace_backup',
    settings: {
      abbreviations: ['Fig.', 'e.g.'],
      jaNormOptions: { normalizeWidth: true },
    },
    glossary: [
      {
        id: 'glo_legacy_1',
        enHeadword: 'triage',
        jaAccepted: ['トリアージ'],
      },
    ],
    projects: [
      {
        id: 'doc_v1_1',
        title: '旧形式バックアップ',
        blocks: [
          {
            id: 'blk_1',
            index: 0,
            enRaw: '*Triage* starts.',
            jaRaw: 'トリアージを開始する。',
            enSentences: [{ id: 'en_1', rawText: '*Triage* starts.' }],
            jaSentences: [{ id: 'ja_1', rawText: 'トリアージを開始する。' }],
            groups: [
              {
                id: 'grp_1',
                enIds: ['en_1'],
                jaIds: ['ja_1'],
                status: 'read',
              },
            ],
          },
        ],
      },
    ],
  };

  assert.equal(validateExportPayload(v1Payload).valid, true);
  const imported = parseAndValidateImportPayload(JSON.stringify(v1Payload));
  assert.equal(imported.schemaVersion, 2);
  assert.equal(imported.migratedFromVersion, 1);
  assert.equal(imported.migrated, true);
  assert.equal(imported.glossary[0].exactMatch, false);
  assert.equal(imported.settings.jaNormOptions.fuzzyTypoCheck, true);
  assert.equal(imported.settings.jaNormOptions.fuzzyMinLength, 4);

  const migProj = imported.projects[0];
  assert.equal(migProj.schemaVersion, 2);
  assert.equal(migProj.blocks[0].enSentences[0].plainText, 'Triage starts.');
  assert.deepEqual(migProj.blocks[0].enSentences[0].markers, []);
  assert.deepEqual(migProj.blocks[0].groups[0].clausePairs, []);
  assert.equal(migProj.blocks[0].groups[0].tempNoOmission, false);
  assert.equal(migProj.blocks[0].groups[0].status, 'read');

  // Legacy bare project without schemaVersion or wrapper
  const bareMigrated = migrateProject(v1Payload.projects[0]);
  assert.equal(bareMigrated.schemaVersion, 2);
  assert.deepEqual(bareMigrated.dismissedHints, {});
  const bareEnv = migrateExportPayload(v1Payload.projects[0]);
  assert.equal(bareEnv.payload.schemaVersion, 2);
  assert.equal(bareEnv.payload.projects.length, 1);

  // Reject invalid payloads deterministically
  assert.throws(
    () => parseAndValidateImportPayload(JSON.stringify({ schemaVersion: 99, projects: [] })),
    /未対応のスキーマバージョン/,
  );
  const badStatus = validateExportPayload({
    schemaVersion: 2,
    type: 'single_project',
    projects: [
      {
        id: 'doc_bad',
        blocks: [
          {
            id: 'b1',
            enSentences: [{ id: 'e1', rawText: 'Hi.', markers: [{ start: 2, end: 1 }] }],
            jaSentences: [],
            groups: [{ id: 'g1', enIds: ['e1'], jaIds: [], status: 'bogus_status' }],
          },
        ],
      },
    ],
  });
  assert.equal(badStatus.valid, false);
  assert.ok(badStatus.errors.some((e) => e.includes('markers[0]')));
  assert.ok(badStatus.errors.some((e) => e.includes('bogus_status')));
});


import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeSentenceWithNextInBlock,
  moveSentenceToGroup,
  splitSentenceInBlock,
  suggestHintedGroups,
  updateSentenceMarkersInBlock,
} from '../js/core/alignment.js';
import {
  addMarkerRange,
  computeMarkerCoveragePercent,
  hasMarkerOverlap,
  removeMarkerRange,
  splitTokensByMarkers,
} from '../js/core/markers.js';
import { pairClassifiedBlocks, splitIntoRawBlocks } from '../js/core/block-parser.js';
import {
  buildAlignmentBlock,
  insertTextIntoGroup,
  parseDocumentBlocks,
  SAMPLE_SOURCE_TEXT,
  updateBlockJapaneseText,
} from '../js/core/document-builder.js';
import {
  checkGroupGlossary,
  findEnglishGlossaryMatches,
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

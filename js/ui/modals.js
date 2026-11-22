/**
 * Modal controllers: Source Import/Replace with live language preview & manual override,
 * JSON Export/Import & Multi-document Manager, Abbreviation Settings, and Shortcut Cheat Sheet.
 */

import { buildEnglishOnlyPairs, pairClassifiedBlocks, splitIntoRawBlocks } from '../core/block-parser.js';
import { SAMPLE_SOURCE_TEXT } from '../core/document-builder.js';
import {
  parseGlossaryDelimited,
  reverseLookupJapanese,
  serializeGlossaryDelimited,
} from '../core/glossary.js';
import { DEFAULT_ABBREVIATIONS } from '../core/sentence-splitter.js';
import { exportTmAsTmx, extractTermCandidates } from '../core/tm.js';
import {
  buildAllProjectsExportPayload,
  buildProjectExportPayload,
  parseImportedJson,
  readFileAsUtf8,
  triggerJsonDownload,
  triggerTextDownload,
} from '../storage/json-io.js';
import { el, WARNING_LABELS } from './render-helpers.js';

export function mountModals(modalRoot, store, onJumpToGroup) {
  function renderImportModal(mode) {
    const isReplace = mode === 'replace';
    const activeProj = store.getActiveProject();
    let draftTitle = isReplace && activeProj ? activeProj.title : '';
    let draftText = '';
    let draftRawBlocks = [];
    let draftInputMode = 'alternating'; // 'alternating' | 'english_only'
    let draftSplitInsideList = isReplace && activeProj ? Boolean(activeProj.splitInsideList) : false;

    const titleInput = el('input', {
      type: 'text',
      className: 'text-input',
      placeholder: '例: 災害対応ハンドブック 第2章',
      value: draftTitle,
      onInput: (e) => {
        draftTitle = e.target.value;
      },
    });

    const modeControl = el('div', { className: 'segmented-control', role: 'group', 'aria-label': '取り込み形式' });
    const listSplitControl = el('div', {
      className: 'segmented-control',
      role: 'group',
      'aria-label': '番号・箇条書き行の文分割設定',
    });

    function renderModeControl() {
      modeControl.textContent = '';
      modeControl.appendChild(
        el('button', {
          type: 'button',
          className: `segmented-btn${draftInputMode === 'alternating' ? ' is-active' : ''}`,
          textContent: '交互対訳（英語段落 → 日本語段落）',
          onClick: () => {
            draftInputMode = 'alternating';
            renderModeControl();
            updatePreview();
          },
        }),
      );
      modeControl.appendChild(
        el('button', {
          type: 'button',
          className: `segmented-btn${draftInputMode === 'english_only' ? ' is-active' : ''}`,
          textContent: '英語原文のみ（後から段落ごとに日本語入力）',
          onClick: () => {
            draftInputMode = 'english_only';
            renderModeControl();
            updatePreview();
          },
        }),
      );
    }

    function renderListSplitControl() {
      listSplitControl.textContent = '';
      listSplitControl.appendChild(
        el('button', {
          type: 'button',
          className: `segmented-btn${!draftSplitInsideList ? ' is-active' : ''}`,
          textContent: '箇条書きとして行単位で分割（標準）',
          title: '複数の (1) や ・ があるブロックを1行1項目として扱います（単一の (1) 段落は常に文末で分割します）',
          onClick: () => {
            draftSplitInsideList = false;
            renderListSplitControl();
            updatePreview();
          },
        }),
      );
      listSplitControl.appendChild(
        el('button', {
          type: 'button',
          className: `segmented-btn${draftSplitInsideList ? ' is-active' : ''}`,
          textContent: '条文の項など行内も文末（。/.）で分割',
          title: '法律の条文の (1)(2) 項のように複数文を含む場合、各項目の中もピリオドや句点で文分割します',
          onClick: () => {
            draftSplitInsideList = true;
            renderListSplitControl();
            updatePreview();
          },
        }),
      );
    }
    renderModeControl();
    renderListSplitControl();

    const textArea = el('textarea', {
      className: 'source-textarea',
      placeholder: '空行で区切られたテキストを貼り付けてください（UTF-8）...',
      onInput: (e) => {
        draftText = e.target.value;
        draftRawBlocks = splitIntoRawBlocks(draftText);
        updatePreview();
      },
    });

    const previewBox = el('div', { className: 'preview-warnings-list' });
    const submitBtn = el('button', {
      type: 'button',
      className: 'btn btn-primary',
      textContent: isReplace ? '原文を差し替えて引き継ぐ' : '読み込んでチェック開始',
      onClick: async () => {
        if (!draftText.trim() || draftRawBlocks.length === 0) {
          store.showToast('テキストを入力するかファイルを読み込んでください', true);
          return;
        }
        if (isReplace) {
          await store.replaceActiveProjectSource({
            title: draftTitle,
            rawText: draftText,
            rawBlocks: draftRawBlocks,
            inputMode: draftInputMode,
            splitInsideList: draftSplitInsideList,
          });
        } else {
          await store.createNewProject({
            title: draftTitle || '無題の対訳ドキュメント',
            rawText: draftText,
            rawBlocks: draftRawBlocks,
            inputMode: draftInputMode,
            splitInsideList: draftSplitInsideList,
          });
        }
      },
    });

    function updatePreview() {
      previewBox.textContent = '';
      if (draftRawBlocks.length === 0) {
        previewBox.appendChild(
          el('div', {
            className: 'meta-sep',
            textContent: 'テキストを入力すると、ブロック分割と言語判定のプレビューが表示されます。',
          }),
        );
        return;
      }

      if (draftInputMode === 'english_only') {
        const pairs = buildEnglishOnlyPairs(draftRawBlocks);
        previewBox.appendChild(
          el('div', {
            textContent: `英語原文のみモード: ${pairs.length}個の英語段落を作成します（読み込み後、各ブロック内で日本語訳を入力できます）`,
          }),
        );
        draftRawBlocks.forEach((blk, idx) => {
          const snippet = blk.rawText.slice(0, 72).replace(/\s+/g, ' ');
          previewBox.appendChild(
            el('div', { className: 'toolbar-group' }, [
              el('span', { className: 'tabular-nums', textContent: `#${idx + 1} [英語]` }),
              el('span', { textContent: snippet }),
            ]),
          );
        });
        return;
      }

      const pairs = pairClassifiedBlocks(draftRawBlocks);
      const warningPairs = pairs.filter((p) => p.warnings.length > 0);
      previewBox.appendChild(
        el('div', {
          textContent: `検出ブロック数: ${draftRawBlocks.length}段落 → ペア数: ${pairs.length}組（警告: ${warningPairs.length}件）`,
        }),
      );

      const allEn = draftRawBlocks.length >= 2 && draftRawBlocks.every((b) => b.effectiveLang === 'en');
      if (allEn) {
        previewBox.appendChild(
          el('div', { className: 'toolbar-group' }, [
            el('span', {
              className: 'status-needs_review',
              textContent: 'すべて英語段落として検出されました。後から日本語を入力する場合は「英語原文のみ」モードに切り替えてください。',
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-xs',
              textContent: '英語原文のみモードに切替',
              onClick: () => {
                draftInputMode = 'english_only';
                renderModeControl();
                updatePreview();
              },
            }),
          ]),
        );
      }

      draftRawBlocks.forEach((blk, idx) => {
        const langLabel =
          blk.effectiveLang === 'en'
            ? '英語'
            : blk.effectiveLang === 'ja'
              ? '日本語'
              : '判定曖昧';
        const snippet = blk.rawText.slice(0, 64).replace(/\s+/g, ' ');
        const row = el('div', { className: 'toolbar-group' }, [
          el('span', { className: 'tabular-nums', textContent: `#${idx + 1}` }),
          el('button', {
            type: 'button',
            className: 'btn btn-xs',
            textContent: `言語: ${langLabel}（切替）`,
            onClick: () => {
              blk.effectiveLang = blk.effectiveLang === 'en' ? 'ja' : 'en';
              updatePreview();
            },
          }),
          el('span', { textContent: snippet }),
        ]);
        previewBox.appendChild(row);
      });

      if (warningPairs.length > 0) {
        warningPairs.forEach((p, wIdx) => {
          previewBox.appendChild(
            el('div', {
              className: 'status-needs_review',
              textContent: `警告 ${wIdx + 1}: ${p.warnings.map((w) => WARNING_LABELS[w] || w).join(' / ')}`,
            }),
          );
        });
      }
    }

    const fileInput = el('input', {
      type: 'file',
      accept: '.txt,.md,text/plain,text/markdown',
      onChange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const content = await readFileAsUtf8(file);
          textArea.value = content;
          draftText = content;
          if (!draftTitle) {
            draftTitle = file.name.replace(/\.(txt|md)$/i, '');
            titleInput.value = draftTitle;
          }
          draftRawBlocks = splitIntoRawBlocks(draftText);
          updatePreview();
        } catch (err) {
          store.showToast(err.message, true);
        }
      },
    });

    const dropzone = el(
      'div',
      {
        className: 'dropzone',
        onDragover: (e) => {
          e.preventDefault();
          dropzone.classList.add('is-dragover');
        },
        onDragleave: () => dropzone.classList.remove('is-dragover'),
        onDrop: async (e) => {
          e.preventDefault();
          dropzone.classList.remove('is-dragover');
          const file = e.dataTransfer?.files?.[0];
          if (!file) return;
          try {
            const content = await readFileAsUtf8(file);
            textArea.value = content;
            draftText = content;
            if (!draftTitle) {
              draftTitle = file.name.replace(/\.(txt|md)$/i, '');
              titleInput.value = draftTitle;
            }
            draftRawBlocks = splitIntoRawBlocks(draftText);
            updatePreview();
          } catch (err) {
            store.showToast(err.message, true);
          }
        },
      },
      [
        el('div', { textContent: '.txt / .md ファイルをここへドラッグ＆ドロップ、または選択（UTF-8）' }),
        fileInput,
      ],
    );

    updatePreview();

    return el('div', { className: 'modal-dialog', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { className: 'modal-header' }, [
        el('h2', {
          textContent: isReplace
            ? '原文を差し替えて再読込（ハッシュ一致で進捗引継）'
            : '新規対訳テキストの読み込み',
        }),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          textContent: '閉じる',
          onClick: () => store.closeModal(),
        }),
      ]),
      el('div', { className: 'modal-body' }, [
        el('div', { className: 'form-field' }, [
          el('label', { className: 'form-label', textContent: 'ドキュメント名' }),
          titleInput,
        ]),
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: '取り込み形式' }),
          modeControl,
        ]),
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: '番号・箇条書き行（(1) / 1. / ・ 等）の扱い' }),
          listSplitControl,
        ]),
        dropzone,
        el('div', { className: 'form-field' }, [
          el('div', { className: 'toolbar-group' }, [
            el('label', { className: 'form-label', textContent: '対訳テキスト' }),
            el('button', {
              type: 'button',
              className: 'btn btn-xs',
              textContent: 'サンプル文を挿入',
              onClick: () => {
                textArea.value = SAMPLE_SOURCE_TEXT;
                draftText = SAMPLE_SOURCE_TEXT;
                if (!draftTitle) {
                  draftTitle = 'サンプル対訳（インシデント対応・脆弱性調整）';
                  titleInput.value = draftTitle;
                }
                draftRawBlocks = splitIntoRawBlocks(draftText);
                updatePreview();
              },
            }),
          ]),
          textArea,
        ]),
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: '段落判定プレビュー（手動で言語ラベル切替可）' }),
          previewBox,
        ]),
      ]),
      el('div', { className: 'modal-footer' }, [
        el('button', {
          type: 'button',
          className: 'btn',
          textContent: 'キャンセル',
          onClick: () => store.closeModal(),
        }),
        submitBtn,
      ]),
    ]);
  }

  function renderJsonModal() {
    const activeProj = store.getActiveProject();
    const jsonFileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      onChange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await readFileAsUtf8(file);
          const imported = parseImportedJson(text);
          await store.importProjectsFromJson(imported);
        } catch (err) {
          store.showToast(err.message || 'インポートに失敗しました', true);
        }
      },
    });

    const projectRows = store.state.projects.map((proj) => {
      const renameInput = el('input', {
        type: 'text',
        className: 'text-input',
        value: proj.title,
        'aria-label': 'ドキュメント名変更',
      });
      return el('div', { className: 'toolbar-group' }, [
        renameInput,
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          textContent: '名前保存',
          onClick: () => store.renameProject(proj.id, renameInput.value),
        }),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          textContent: '開く',
          onClick: async () => {
            await store.selectProject(proj.id);
            store.closeModal();
          },
        }),
        el('button', {
          type: 'button',
          className: 'btn btn-xs btn-danger',
          textContent: '削除',
          onClick: () => store.removeProject(proj.id),
        }),
      ]);
    });

    return el('div', { className: 'modal-dialog', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { className: 'modal-header' }, [
        el('h2', { textContent: 'JSONバックアップ・復元 / 保存済み文書管理' }),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          textContent: '閉じる',
          onClick: () => store.closeModal(),
        }),
      ]),
      el('div', { className: 'modal-body' }, [
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: 'エクスポート（ブラウザ外へのバックアップ）' }),
          el('div', { className: 'toolbar-group' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-primary btn-sm',
              disabled: !activeProj,
              textContent: '現在の文書をJSON保存',
              onClick: () => {
                if (!activeProj) return;
                const safeName = activeProj.title.replace(/[\\/:*?"<>|]/g, '_');
                triggerJsonDownload(`${safeName}.review.json`, buildProjectExportPayload(activeProj));
              },
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              disabled: store.state.projects.length === 0,
              textContent: '全ドキュメント一括JSON保存',
              onClick: () => {
                triggerJsonDownload(
                  `bilingual-review-backup-${new Date().toISOString().slice(0, 10)}.json`,
                  buildAllProjectsExportPayload(
                    store.state.projects,
                    {
                      abbreviations: store.state.abbreviations,
                      jaNormOptions: store.state.jaNormOptions,
                    },
                    store.state.glossary,
                    [],
                  ),
                );
              },
            }),
          ]),
        ]),
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: 'JSONファイルから復元・追加インポート' }),
          jsonFileInput,
        ]),
        el('div', { className: 'form-field' }, [
          el('span', {
            className: 'form-label',
            textContent: `ブラウザ内（IndexedDB）に保存済みの文書 (${store.state.projects.length}件)`,
          }),
          el('div', { className: 'preview-warnings-list' }, projectRows),
        ]),
      ]),
      el('div', { className: 'modal-footer' }, [
        el('button', {
          type: 'button',
          className: 'btn',
          textContent: '閉じる',
          onClick: () => store.closeModal(),
        }),
      ]),
    ]);
  }

  function renderSettingsModal() {
    const abbrArea = el('textarea', {
      className: 'source-textarea',
      value: store.state.abbreviations.join('\n'),
      'aria-label': '英語略語リスト（1行1項目）',
    });

    return el('div', { className: 'modal-dialog', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { className: 'modal-header' }, [
        el('h2', { textContent: '英語文分割 略語リスト設定' }),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          textContent: '閉じる',
          onClick: () => store.closeModal(),
        }),
      ]),
      el('div', { className: 'modal-body' }, [
        el('p', {
          textContent:
            'ピリオドを含んでも文末として分割しない英語略語を1行につき1つ登録します（例: e.g., i.e., et al., Fig., No., vs., approx.）。',
        }),
        abbrArea,
        el('div', { className: 'toolbar-group' }, [
          el('button', {
            type: 'button',
            className: 'btn btn-sm',
            textContent: '初期値に戻す',
            onClick: () => {
              abbrArea.value = DEFAULT_ABBREVIATIONS.join('\n');
            },
          }),
        ]),
        (() => {
          const activeProj = store.getActiveProject();
          const dismissedCount = Object.keys(activeProj?.dismissedHints || {}).length;
          return el('div', { className: 'form-field' }, [
            el('span', { className: 'form-label', textContent: '漏れ・混入ヒントの非表示設定' }),
            el('div', { className: 'toolbar-group' }, [
              el('span', {
                className: 'meta-sep',
                textContent: `現在のドキュメントで非表示中のヒント: ${dismissedCount}件`,
              }),
              el('button', {
                type: 'button',
                className: 'btn btn-sm',
                disabled: dismissedCount === 0,
                textContent: '非表示ヒントをすべて復元',
                onClick: () => store.restoreAllHints(),
              }),
            ]),
          ]);
        })(),
      ]),
      el('div', { className: 'modal-footer' }, [
        el('button', {
          type: 'button',
          className: 'btn',
          textContent: 'キャンセル',
          onClick: () => store.closeModal(),
        }),
        el('button', {
          type: 'button',
          className: 'btn',
          textContent: '保存のみ',
          onClick: () => store.saveAbbreviations(abbrArea.value.split(/\r?\n/), false),
        }),
        el('button', {
          type: 'button',
          className: 'btn btn-primary',
          textContent: '保存して現在の文書を再分割',
          onClick: () => store.saveAbbreviations(abbrArea.value.split(/\r?\n/), true),
        }),
      ]),
    ]);
  }

  function renderShortcutsModal() {
    const buttonGuideRows = [
      [
        '文を分割',
        '1文として区切られた箇所を、任意の文字位置で2文に分けます（例：コロンや読点で訳文が2文に分かれている箇所を調整するとき）。',
      ],
      [
        '次文と結合↓',
        'この文と直後の文をつなげて1文に戻します（例：略語や小数点などで文分割が誤って途中で切れてしまったとき）。',
      ],
      [
        '次ブロック＋次文結合↓',
        'ブロック末尾の文で、次のブロックと結合すると同時に、ブロック境界で分断されたその言語の文同士を1文につなげます。',
      ],
      [
        '次ブロック＋境界文結合',
        'ブロックヘッダから次のブロックと結合し、境界で分断された末尾文と先頭文（英・和の両側）を1クリックで1文にまとめます。',
      ],
      [
        '↑上のペアへ',
        'この文を1つ上の対訳枠へ移動してまとめます（例：英語1文に対して日本語が2文あるとき、2文目を上の枠へ上げる）。※ドラッグ＆ドロップでも移動できます。',
      ],
      [
        '↓下のペアへ',
        'この文を1つ下の対訳枠へ移動します（例：同じ枠に複数文を入れすぎたときや、1文ずれて対応しているのを下に送るとき）。',
      ],
      [
        '対応なし枠へ',
        '同じ枠にある他方の文と切り離し、この文だけの独立した枠を作ります（例：訳文側にだけある補足文や、原文側で省略された文を「対応なし」として記録したいとき）。',
      ],
      [
        '文節対比（一時チェック）',
        '1文が長文のとき、文構造を壊さずに英語と日本語の対応する文節どうしを隣り合わせに並べて見比べる一時ワークベンチを開きます。Cキーまたはドラッグ選択から順次確認でき、対比カード内でも H / Shift+H / 右クリック /「文節マーカ」でマーカ操作が可能です。',
      ],
      [
        '文を修正',
        '訳漏れや訳しすぎが見つかったとき、その1文のテキストだけをインライン修正します（他の文の対応関係・確認状態・マーカは保持されます）。',
      ],
      [
        '本文ドラッグ＆右クリック',
        '英文または和文をドラッグして範囲選択し、右クリックすると、選択範囲へのマーカ付与／解除、「文節対比」ペアの作成・セット、「訳漏れなし（一時記録）」の切替、翻訳メモリ・用語集への単語・語句登録ができます。',
      ],
    ];

    const rows = [
      ['c', '選択範囲を文節対比の新規ペア作成／待機中ペアの対訳にセット'],
      ['h', '選択中の文字列にマーカを付ける（既マーカ範囲なら解除）'],
      ['Shift + h', '文頭〜選択範囲の末尾までをマーカする'],
      ['j', '次の文グループへ移動'],
      ['k', '前の文グループへ移動'],
      ['↑ / ↓', '画面を上下にスクロール'],
      ['v / Enter', '選択中グループを「確認済」にする'],
      ['r', '選択中グループを「読了」にする'],
      ['t', '選択中グループの「訳漏れなし（一時記録）」を切り替え'],
      ['f', '選択中グループを「要確認」にしてメモを開く'],
      ['m', '選択中グループのメモ欄を開く／フォーカス'],
      ['Esc', 'モーダル・文分割エディタ・文修正エディタを閉じる'],
      ['?', 'この操作ガイドを開く'],
    ];

    return el('div', { className: 'modal-dialog', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { className: 'modal-header' }, [
        el('h2', { textContent: '操作ガイド・キーボードショートカット' }),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          textContent: '閉じる',
          onClick: () => store.closeModal(),
        }),
      ]),
      el('div', { className: 'modal-body' }, [
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: '文の対応調整ボタンの使い分け' }),
          el(
            'table',
            { className: 'shortcut-table' },
            buttonGuideRows.map(([name, desc]) =>
              el('tr', {}, [
                el('td', {}, [el('strong', { textContent: name })]),
                el('td', { textContent: desc }),
              ]),
            ),
          ),
        ]),
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: 'キーボードショートカット' }),
          el(
            'table',
            { className: 'shortcut-table' },
            rows.map(([key, desc]) =>
              el('tr', {}, [
                el('td', {}, [el('span', { className: 'kbd', textContent: key })]),
                el('td', { textContent: desc }),
              ]),
            ),
          ),
        ]),
      ]),
      el('div', { className: 'modal-footer' }, [
        el('button', {
          type: 'button',
          className: 'btn btn-primary',
          textContent: '閉じる',
          onClick: () => store.closeModal(),
        }),
      ]),
    ]);
  }

  function renderGlossaryModal() {
    const activeTab = store.state.glossaryTab || 'list';
    const activeProj = store.getActiveProject();
    let editingId = null;

    const tabBar = el('div', { className: 'segmented-control', role: 'tablist' }, [
      el('button', {
        type: 'button',
        className: `segmented-btn${activeTab === 'list' ? ' is-active' : ''}`,
        textContent: `登録一覧・追加 (${store.state.glossary.length})`,
        onClick: () => store.openModal('glossary', 'list'),
      }),
      el('button', {
        type: 'button',
        className: `segmented-btn${activeTab === 'candidates' ? ' is-active' : ''}`,
        textContent: '用語候補抽出（共起分析）',
        onClick: () => store.openModal('glossary', 'candidates'),
      }),
      el('button', {
        type: 'button',
        className: `segmented-btn${activeTab === 'lookup' ? ' is-active' : ''}`,
        textContent: '日→英 逆引き検索',
        onClick: () => store.openModal('glossary', 'lookup'),
      }),
      el('button', {
        type: 'button',
        className: `segmented-btn${activeTab === 'csv' ? ' is-active' : ''}`,
        textContent: 'CSV / TSV / TMX 入出力',
        onClick: () => store.openModal('glossary', 'csv'),
      }),
    ]);

    const bodyContent = el('div', { className: 'modal-body' }, [tabBar]);

    if (activeTab === 'list') {
      const enInput = el('input', {
        type: 'text',
        className: 'text-input',
        placeholder: '例: triage / incident handling',
      });
      const variantsInput = el('input', {
        type: 'text',
        className: 'text-input',
        placeholder: '例: triaged | triaging（複数形や-ing/-edは自動対応、不規則形のみ追加）',
      });
      const jaAccInput = el('input', {
        type: 'text',
        className: 'text-input',
        placeholder: '例: トリアージ | 優先度判定（| や読点で複数可）',
      });
      const jaDepInput = el('input', {
        type: 'text',
        className: 'text-input',
        placeholder: '例: 選別（非推奨の訳語があれば入力）',
      });
      const notesInput = el('input', {
        type: 'text',
        className: 'text-input',
        placeholder: '備考・使い分けメモ...',
      });
      const caseCheck = el('input', { type: 'checkbox' });
      const exactMatchCheck = el('input', { type: 'checkbox' });
      const saveBtnLabel = el('span', { textContent: 'TM・用語集に登録' });

      const splitMulti = (v) =>
        String(v || '')
          .split(/[|;；、,]/)
          .map((s) => s.trim())
          .filter(Boolean);

      const resetForm = () => {
        editingId = null;
        enInput.value = '';
        variantsInput.value = '';
        jaAccInput.value = '';
        jaDepInput.value = '';
        notesInput.value = '';
        caseCheck.checked = false;
        exactMatchCheck.checked = false;
        saveBtnLabel.textContent = 'TM・用語集に登録';
      };

      const normWidthCheck = el('input', {
        type: 'checkbox',
        checked: store.state.jaNormOptions.normalizeWidth,
        onChange: (e) => store.setJaNormOptions({ normalizeWidth: e.target.checked }),
      });
      const normVowelCheck = el('input', {
        type: 'checkbox',
        checked: store.state.jaNormOptions.normalizeLongVowel,
        onChange: (e) => store.setJaNormOptions({ normalizeLongVowel: e.target.checked }),
      });
      const normOkuriCheck = el('input', {
        type: 'checkbox',
        checked: store.state.jaNormOptions.normalizeOkurigana,
        onChange: (e) => store.setJaNormOptions({ normalizeOkurigana: e.target.checked }),
      });
      const fuzzyTypoEnabled = store.state.jaNormOptions.fuzzyTypoCheck !== false;
      const fuzzyTypoCheck = el('input', {
        type: 'checkbox',
        checked: fuzzyTypoEnabled,
        onChange: (e) => store.setJaNormOptions({ fuzzyTypoCheck: e.target.checked }),
      });
      const fuzzyMinLen3Check = el('input', {
        type: 'checkbox',
        checked: Number(store.state.jaNormOptions.fuzzyMinLength) === 3,
        disabled: !fuzzyTypoEnabled,
        onChange: (e) =>
          store.setJaNormOptions({ fuzzyMinLength: e.target.checked ? 3 : 4 }),
      });

      bodyContent.appendChild(
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: '日本語照合・破線ハイライト・誤記チェック設定' }),
          el('div', { className: 'checkbox-row' }, [
            el('label', { className: 'checkbox-label' }, [
              normWidthCheck,
              document.createTextNode('全角・半角を正規化'),
            ]),
            el('label', { className: 'checkbox-label' }, [
              normVowelCheck,
              document.createTextNode('カタカナ長音「ー」ゆれを吸収（アドバイザリ/ー）'),
            ]),
            el('label', { className: 'checkbox-label' }, [
              normOkuriCheck,
              document.createTextNode('送り仮名ゆれを吸収（引き継ぎ/引継ぎ等）'),
            ]),
          ]),
          el('div', { className: 'checkbox-row' }, [
            el('label', { className: 'checkbox-label' }, [
              fuzzyTypoCheck,
              document.createTextNode('誤記・脱字・衍字チェック（1〜2文字差異を波線警告）'),
            ]),
            el('label', { className: 'checkbox-label' }, [
              fuzzyMinLen3Check,
              document.createTextNode('3文字の短い用語も対象にする（標準は4文字以上）'),
            ]),
          ]),
        ]),
      );

      if (store.state.tmRecords.length > 0) {
        bodyContent.appendChild(
          el('div', { className: 'toolbar-group' }, [
            el('span', {
              className: 'meta-sep',
              textContent: `旧仕様の文単位TM記録が ${store.state.tmRecords.length} 件残っています（現在は単語・語句単位で運用しています）`,
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-xs btn-danger',
              textContent: '旧文単位TMを削除',
              onClick: () => store.clearTm(),
            }),
          ]),
        );
      }

      bodyContent.appendChild(
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: '単語・語句の新規登録・編集（登録語句は本文の英語・対応日本語に破線下線で表示されます）' }),
          el('div', { className: 'glossary-form-grid' }, [
            el('div', { className: 'form-field' }, [
              el('label', { className: 'form-label', textContent: '英語語句 *' }),
              enInput,
            ]),
            el('div', { className: 'form-field' }, [
              el('label', { className: 'form-label', textContent: '手動活用形（任意）' }),
              variantsInput,
            ]),
            el('div', { className: 'form-field' }, [
              el('label', { className: 'form-label', textContent: '対応訳語・許容訳語（日本語）' }),
              jaAccInput,
            ]),
            el('div', { className: 'form-field' }, [
              el('label', { className: 'form-label', textContent: '非推奨訳語（日本語・任意）' }),
              jaDepInput,
            ]),
          ]),
          el('div', { className: 'glossary-form-grid' }, [
            el('div', { className: 'form-field' }, [
              el('label', { className: 'form-label', textContent: '備考' }),
              notesInput,
            ]),
            el('div', { className: 'toolbar-group' }, [
              el('label', { className: 'checkbox-label' }, [
                caseCheck,
                document.createTextNode('大文字・小文字を区別する'),
              ]),
              el(
                'label',
                {
                  className: 'checkbox-label',
                  title:
                    'ONにすると複数形や-ed/-ing等の自動語幹展開を行わず、登録した英語表記に完全一致する箇所のみに反応します',
                },
                [
                  exactMatchCheck,
                  document.createTextNode('単複・活用を区別する（厳密一致）'),
                ],
              ),
            ]),
          ]),
          el('div', { className: 'toolbar-group' }, [
            el(
              'button',
              {
                type: 'button',
                className: 'btn btn-primary btn-sm',
                onClick: async () => {
                  await store.saveGlossaryItem({
                    id: editingId,
                    enHeadword: enInput.value,
                    enVariants: splitMulti(variantsInput.value),
                    jaAccepted: splitMulti(jaAccInput.value),
                    jaDeprecated: splitMulti(jaDepInput.value),
                    caseSensitive: caseCheck.checked,
                    exactMatch: exactMatchCheck.checked,
                    notes: notesInput.value,
                  });
                  resetForm();
                },
              },
              [saveBtnLabel],
            ),
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              textContent: '入力クリア',
              onClick: () => resetForm(),
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              textContent: 'サンプル語句を追加',
              onClick: () => store.seedSampleGlossary(),
            }),
            store.state.glossary.length > 0
              ? el('button', {
                  type: 'button',
                  className: 'btn btn-sm btn-danger',
                  textContent: '全削除',
                  onClick: () => store.clearGlossary(),
                })
              : null,
          ]),
        ]),
      );

      const listContainer = el('div', { className: 'preview-warnings-list glossary-list-box' });
      const filterInput = el('input', {
        type: 'search',
        className: 'text-input',
        placeholder: '登録語句を検索（英語・日本語・備考）...',
        'aria-label': '登録語句検索',
        onInput: () => renderEntriesTable(),
      });

      function renderEntriesTable() {
        listContainer.textContent = '';
        const q = filterInput.value.trim().toLowerCase();
        const filtered = store.state.glossary.filter((entry) => {
          if (!q) return true;
          return (
            (entry.enHeadword || '').toLowerCase().includes(q) ||
            (entry.enVariants || []).some((v) => v.toLowerCase().includes(q)) ||
            (entry.jaAccepted || []).some((j) => j.toLowerCase().includes(q)) ||
            (entry.jaDeprecated || []).some((j) => j.toLowerCase().includes(q)) ||
            (entry.notes || '').toLowerCase().includes(q)
          );
        });

        if (filtered.length === 0) {
          listContainer.appendChild(
            el('div', {
              textContent:
                store.state.glossary.length === 0
                  ? '登録された語句はありません。上のフォーム・CSV・本文の右クリックから追加できます。'
                  : '検索条件に一致する語句がありません。',
            }),
          );
          return;
        }
        const table = el('table', { className: 'shortcut-table' });
        table.appendChild(
          el('tr', {}, [
            el('th', { textContent: '英語語句' }),
            el('th', { textContent: '対応訳語（許容）' }),
            el('th', { textContent: '非推奨訳語' }),
            el('th', { textContent: '備考 / 操作' }),
          ]),
        );
        for (const entry of filtered) {
          table.appendChild(
            el('tr', {}, [
              el('td', {}, [
                el('strong', { textContent: entry.enHeadword }),
                entry.enVariants?.length
                  ? el('div', {
                      className: 'meta-sep',
                      textContent: `活用: ${entry.enVariants.join(', ')}`,
                    })
                  : null,
                entry.caseSensitive
                  ? el('div', { className: 'meta-sep', textContent: '大小文字区別あり' })
                  : null,
                entry.exactMatch
                  ? el('div', { className: 'meta-sep', textContent: '単複・活用区別（厳密一致）' })
                  : null,
              ]),
              el('td', { textContent: (entry.jaAccepted || []).join(' / ') || '—' }),
              el('td', {
                className: entry.jaDeprecated?.length ? 'status-needs_review' : '',
                textContent: (entry.jaDeprecated || []).join(' / ') || '—',
              }),
              el('td', {}, [
                entry.notes ? el('div', { textContent: entry.notes }) : null,
                el('div', { className: 'toolbar-group' }, [
                  el('button', {
                    type: 'button',
                    className: 'btn btn-xs',
                    textContent: '編集',
                    onClick: () => {
                      editingId = entry.id;
                      enInput.value = entry.enHeadword || '';
                      variantsInput.value = (entry.enVariants || []).join(' | ');
                      jaAccInput.value = (entry.jaAccepted || []).join(' | ');
                      jaDepInput.value = (entry.jaDeprecated || []).join(' | ');
                      notesInput.value = entry.notes || '';
                      caseCheck.checked = Boolean(entry.caseSensitive);
                      exactMatchCheck.checked = Boolean(entry.exactMatch);
                      saveBtnLabel.textContent = '変更を保存';
                    },
                  }),
                  el('button', {
                    type: 'button',
                    className: 'btn btn-xs btn-danger',
                    textContent: '削除',
                    onClick: () => store.removeGlossaryItem(entry.id),
                  }),
                ]),
              ]),
            ]),
          );
        }
        listContainer.appendChild(table);
      }

      renderEntriesTable();
      bodyContent.appendChild(filterInput);
      bodyContent.appendChild(listContainer);
    } else if (activeTab === 'candidates') {
      let minFreq = 2;
      let minN = 1;
      let maxResults = 200;
      const resultsBox = el('div', { className: 'preview-warnings-list glossary-list-box' });
      const freqControl = el('div', { className: 'segmented-control', role: 'group', 'aria-label': '最小出現回数' });
      const ngramControl = el('div', { className: 'segmented-control', role: 'group', 'aria-label': '語数範囲' });
      const limitControl = el('div', { className: 'segmented-control', role: 'group', 'aria-label': '最大表示件数' });
      const countSummaryEl = el('span', { className: 'meta-sep tabular-nums' });

      function renderCandidateControls() {
        freqControl.textContent = '';
        for (const freq of [2, 1]) {
          freqControl.appendChild(
            el('button', {
              type: 'button',
              className: `segmented-btn${minFreq === freq ? ' is-active' : ''}`,
              textContent: `${freq}回以上出現`,
              onClick: () => {
                minFreq = freq;
                renderCandidateControls();
                renderCandidates();
              },
            }),
          );
        }

        ngramControl.textContent = '';
        for (const [nVal, label] of [
          [1, '1〜7語'],
          [2, '2〜7語'],
          [4, '4〜7語'],
        ]) {
          ngramControl.appendChild(
            el('button', {
              type: 'button',
              className: `segmented-btn${minN === nVal ? ' is-active' : ''}`,
              textContent: label,
              onClick: () => {
                minN = nVal;
                renderCandidateControls();
                renderCandidates();
              },
            }),
          );
        }

        limitControl.textContent = '';
        for (const limit of [40, 200, 500]) {
          limitControl.appendChild(
            el('button', {
              type: 'button',
              className: `segmented-btn${maxResults === limit ? ' is-active' : ''}`,
              textContent: `${limit}件`,
              onClick: () => {
                maxResults = limit;
                renderCandidateControls();
                renderCandidates();
              },
            }),
          );
        }
      }

      function renderCandidates() {
        resultsBox.textContent = '';
        if (!activeProj) {
          countSummaryEl.textContent = '';
          resultsBox.appendChild(el('div', { textContent: '開いているドキュメントがありません。' }));
          return;
        }
        const candidates = extractTermCandidates(activeProj.blocks, store.state.glossary, {
          minFreq,
          minN,
          maxN: 7,
          maxResults,
        });
        countSummaryEl.textContent = `表示中: ${candidates.length}件（上限 ${maxResults}件・${minN}〜7語）`;
        if (candidates.length === 0) {
          resultsBox.appendChild(
            el('div', {
              textContent:
                '条件に一致する用語候補が見つかりません。短い文書の場合は「1回以上出現」や「1〜7語」をお試しください。',
            }),
          );
          return;
        }
        const table = el('table', { className: 'shortcut-table' });
        table.appendChild(
          el('tr', {}, [
            el('th', { textContent: '英語候補（語数・頻度）' }),
            el('th', { textContent: '同一枠内の共起日本語候補' }),
            el('th', { textContent: '操作' }),
          ]),
        );
        for (const cand of candidates) {
          const defaultJa = cand.jaCandidates[0]?.jaTerm || '';
          const jaSelectOrInput = el('input', {
            type: 'text',
            className: 'text-input',
            value: defaultJa,
            placeholder: '対応訳語を入力...',
            'aria-label': `${cand.enTerm} の訳語候補`,
          });
          const jaBadges = cand.jaCandidates
            .map((j) => `${j.jaTerm}(${j.count})`)
            .join(' · ');

          table.appendChild(
            el('tr', {}, [
              el('td', {}, [
                el('strong', { textContent: cand.enTerm }),
                el('div', {
                  className: 'meta-sep tabular-nums',
                  textContent: `${cand.wordCount}語 · 出現 ${cand.count}グループ`,
                }),
              ]),
              el('td', {}, [
                jaBadges
                  ? el('div', { className: 'meta-sep', textContent: jaBadges })
                  : el('div', { className: 'meta-sep', textContent: '日本語候補なし' }),
                !cand.alreadyInGlossary ? jaSelectOrInput : null,
              ]),
              el('td', {}, [
                cand.alreadyInGlossary
                  ? el('span', { className: 'status-verified', textContent: '✓ 登録済' })
                  : el('button', {
                      type: 'button',
                      className: 'btn btn-xs btn-primary',
                      textContent: 'TM・用語集に登録',
                      onClick: async () => {
                        const chosenJa = jaSelectOrInput.value.trim();
                        await store.saveGlossaryItem({
                          enHeadword: cand.enTerm,
                          enVariants: [],
                          jaAccepted: chosenJa ? [chosenJa] : [],
                          jaDeprecated: [],
                          caseSensitive: /^[A-Z0-9-]+$/.test(cand.enTerm),
                          notes: '用語候補抽出より登録',
                        });
                      },
                    }),
              ]),
            ]),
          );
        }
        resultsBox.appendChild(table);
      }

      renderCandidateControls();
      renderCandidates();

      bodyContent.appendChild(
        el('div', { className: 'form-field' }, [
          el('span', {
            className: 'form-label',
            textContent: '決定的n-gram（1〜7語）・共起分析による用語候補の抽出（現在開いている文書）',
          }),
          el('div', { className: 'toolbar-group' }, [
            freqControl,
            ngramControl,
            limitControl,
            countSummaryEl,
          ]),
        ]),
      );
      bodyContent.appendChild(resultsBox);
    } else if (activeTab === 'lookup') {
      const lookupResultsBox = el('div', { className: 'preview-warnings-list glossary-list-box' });
      const lookupInput = el('input', {
        type: 'search',
        className: 'text-input',
        placeholder: '日本語語句を入力（例: トリアージ、引継ぎ、アドバイザリー）...',
        'aria-label': '日英逆引き検索',
        onInput: () => runLookup(),
      });

      function runLookup() {
        lookupResultsBox.textContent = '';
        if (!activeProj) {
          lookupResultsBox.appendChild(
            el('div', { textContent: '開いているドキュメントがありません。' }),
          );
          return;
        }
        const q = lookupInput.value.trim();
        if (!q) {
          lookupResultsBox.appendChild(
            el('div', {
              textContent:
                '日本語語句を入力すると、現在のドキュメント内で該当語句を含む箇所と対応する英語文を一覧表示します（表記ゆれ吸収オプションも適用されます）。',
            }),
          );
          return;
        }
        const hits = reverseLookupJapanese(
          activeProj.blocks,
          q,
          store.state.jaNormOptions,
          store.state.glossary,
        );
        lookupResultsBox.appendChild(
          el('div', {
            className: 'form-label',
            textContent: `検索結果: ${hits.length}件`,
          }),
        );
        for (const hit of hits) {
          lookupResultsBox.appendChild(
            el('div', { className: 'block-section' }, [
              el('div', { className: 'block-header' }, [
                el('span', {
                  className: 'tabular-nums',
                  textContent: `ブロック #${String(hit.blockIndex + 1).padStart(2, '0')}`,
                }),
                hit.matchedGlossary.length > 0
                  ? el('span', {
                      className: 'meta-sep',
                      textContent: `登録語句: ${hit.matchedGlossary.join(', ')}`,
                    })
                  : null,
                el('button', {
                  type: 'button',
                  className: 'btn btn-xs btn-primary',
                  textContent: '該当箇所へ移動',
                  onClick: () => onJumpToGroup && onJumpToGroup(hit.blockId, hit.groupId),
                }),
              ]),
              el('div', { className: 'ja-block-editor' }, [
                el('div', { textContent: `JA: ${hit.jaText}` }),
                el('div', { className: 'meta-sep', textContent: `EN: ${hit.enText || '(対応なし)'}` }),
              ]),
            ]),
          );
        }
      }

      runLookup();
      bodyContent.appendChild(
        el('div', { className: 'form-field' }, [
          el('label', { className: 'form-label', textContent: '日本語 → 英語 逆引き検索' }),
          lookupInput,
        ]),
      );
      bodyContent.appendChild(lookupResultsBox);
    } else if (activeTab === 'csv') {
      const pasteArea = el('textarea', {
        className: 'source-textarea',
        placeholder:
          'enHeadword,jaAccepted,jaDeprecated,enVariants,caseSensitive,exactMatch,notes\ntriage,トリアージ,選別,triaged | triaging,false,false,カタカナ統一',
      });
      const replaceCheck = el('input', { type: 'checkbox' });
      const fileInput = el('input', {
        type: 'file',
        accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain',
        onChange: async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            pasteArea.value = await readFileAsUtf8(file);
          } catch (err) {
            store.showToast(err.message, true);
          }
        },
      });

      bodyContent.appendChild(
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: 'エクスポート（UTF-8 CSV / TSV / TMX 1.4）' }),
          el('div', { className: 'toolbar-group' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-primary btn-sm',
              disabled: store.state.glossary.length === 0,
              textContent: 'CSVダウンロード',
              onClick: () =>
                triggerTextDownload(
                  'glossary-tm.csv',
                  serializeGlossaryDelimited(store.state.glossary, ','),
                  'text/csv;charset=utf-8',
                ),
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              disabled: store.state.glossary.length === 0,
              textContent: 'TSVダウンロード',
              onClick: () =>
                triggerTextDownload(
                  'glossary-tm.tsv',
                  serializeGlossaryDelimited(store.state.glossary, '\t'),
                  'text/tab-separated-values;charset=utf-8',
                ),
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              disabled: store.state.glossary.length === 0,
              textContent: 'TMX 1.4 ダウンロード',
              onClick: () =>
                triggerTextDownload(
                  `translation-memory-${new Date().toISOString().slice(0, 10)}.tmx`,
                  exportTmAsTmx(store.state.glossary),
                  'application/xml;charset=utf-8',
                ),
            }),
          ]),
        ]),
      );

      bodyContent.appendChild(
        el('div', { className: 'form-field' }, [
          el('span', { className: 'form-label', textContent: 'CSV / TSV インポート（区切り自動判定）' }),
          fileInput,
          pasteArea,
          el('label', { className: 'checkbox-label' }, [
            replaceCheck,
            document.createTextNode('既存の登録を置き換える（未チェック時は追加）'),
          ]),
          el('div', { className: 'toolbar-group' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-primary btn-sm',
              textContent: 'CSV / TSVを取り込む',
              onClick: async () => {
                const entries = parseGlossaryDelimited(pasteArea.value, 'auto');
                if (entries.length === 0) {
                  store.showToast('取り込める語句行が見つかりませんでした', true);
                  return;
                }
                await store.importGlossaryList(entries, replaceCheck.checked);
              },
            }),
          ]),
        ]),
      );
    }

    return el('div', { className: 'modal-dialog is-wide', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { className: 'modal-header' }, [
        el('h2', { textContent: '翻訳メモリ (TM) ・用語集・統一チェック' }),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          textContent: '閉じる',
          onClick: () => store.closeModal(),
        }),
      ]),
      bodyContent,
      el('div', { className: 'modal-footer' }, [
        el('button', {
          type: 'button',
          className: 'btn',
          textContent: '閉じる',
          onClick: () => store.closeModal(),
        }),
      ]),
    ]);
  }

  function renderModal(state) {
    modalRoot.textContent = '';
    if (!state.activeModal) return;

    const backdrop = el('div', {
      className: 'modal-backdrop',
      onClick: (e) => {
        if (e.target === backdrop) store.closeModal();
      },
    });

    if (state.activeModal === 'import') {
      backdrop.appendChild(renderImportModal(state.importModalMode));
    } else if (state.activeModal === 'json') {
      backdrop.appendChild(renderJsonModal());
    } else if (state.activeModal === 'settings') {
      backdrop.appendChild(renderSettingsModal());
    } else if (state.activeModal === 'shortcuts') {
      backdrop.appendChild(renderShortcutsModal());
    } else if (state.activeModal === 'glossary' || state.activeModal === 'tm') {
      backdrop.appendChild(renderGlossaryModal());
    }

    modalRoot.appendChild(backdrop);
  }

  return { renderModal };
}

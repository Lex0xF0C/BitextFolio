/**
 * UI panel for OASIS XLIFF 2.1 bilingual export/import inside the data interchange modal.
 * Uses CSP-safe DOM helpers only.
 */

import { exportProjectToXliff21 } from '../core/xliff.js';
import { readFileAsUtf8, triggerTextDownload } from '../storage/json-io.js';
import { el } from './render-helpers.js';

export function renderXliffInterchangeSection(activeProj, store) {
  const xliffFileInput = el('input', {
    type: 'file',
    accept: '.xlf,.xliff,.xml,application/xliff+xml,text/xml,application/xml',
    'aria-label': 'XLIFF 2.1 ファイルを選択',
    onChange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await readFileAsUtf8(file);
        await store.importProjectFromXliff(text, file.name);
      } catch (err) {
        store.showToast(err.message || 'XLIFF 2.1 の読み込みに失敗しました', true);
      }
    },
  });

  return el('div', { className: 'form-field' }, [
    el('span', {
      className: 'form-label',
      textContent: 'XLIFF 2.1 標準データ交換（他CATツール・外部レビュー連携）',
    }),
    el('div', {
      className: 'meta-sep',
      textContent:
        '文グループ（n:m対応）を <unit>/<segment>、ステータスを state/subState、メモを <notes>、マーカを <mrk> として入出力します。',
    }),
    el('div', { className: 'toolbar-group' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        disabled: !activeProj,
        textContent: '現在の文書を XLIFF 2.1 保存 (.xlf)',
        onClick: () => {
          if (!activeProj) return;
          try {
            const safeName = activeProj.title.replace(/[\\/:*?"<>|]/g, '_');
            const xml = exportProjectToXliff21(activeProj);
            triggerTextDownload(`${safeName}.xlf`, xml, 'application/xliff+xml;charset=utf-8');
          } catch (err) {
            store.showToast(err.message || 'XLIFF 2.1 エクスポートに失敗しました', true);
          }
        },
      }),
    ]),
    el('div', { className: 'form-field' }, [
      el('span', { className: 'meta-sep', textContent: 'XLIFF 2.1 (.xlf / .xliff) をインポート:' }),
      xliffFileInput,
    ]),
  ]);
}

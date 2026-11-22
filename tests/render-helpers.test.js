import test from 'node:test';
import assert from 'node:assert/strict';

import { el } from '../js/ui/render-helpers.js';

function withMockDocument(fn) {
  const prevDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      const attrs = new Map();
      const listeners = new Map();
      const children = [];
      const node = {
        tagName: String(tag).toUpperCase(),
        className: '',
        textContent: '',
        dataset: {},
        children,
        setAttribute(k, v) {
          attrs.set(k, String(v));
        },
        getAttribute(k) {
          return attrs.has(k) ? attrs.get(k) : null;
        },
        addEventListener(type, cb) {
          listeners.set(type, cb);
        },
        appendChild(child) {
          children.push(child);
          return child;
        },
      };
      if (['TEXTAREA', 'INPUT', 'SELECT', 'OPTION'].includes(node.tagName)) {
        node.value = '';
      }
      return node;
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text) };
    },
  };
  try {
    return fn();
  } finally {
    if (prevDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = prevDocument;
    }
  }
}

test('el() assigns .value property directly for textarea, input, and select elements', () => {
  withMockDocument(() => {
    const ta = el('textarea', {
      className: 'memo-textarea',
      value: '既存のレビューメモ\n2行目',
      placeholder: 'メモ',
    });
    assert.equal(ta.value, '既存のレビューメモ\n2行目');
    assert.equal(ta.getAttribute('value'), null);
    assert.equal(ta.getAttribute('placeholder'), 'メモ');

    const emptyTa = el('textarea', { value: '' });
    assert.equal(emptyTa.value, '');

    const rangeInput = el('input', { type: 'range', min: 1, max: 250, value: 180 });
    assert.equal(rangeInput.value, '180');
    assert.equal(rangeInput.getAttribute('min'), '1');
    assert.equal(rangeInput.getAttribute('max'), '250');

    const sel = el('select', { value: 'b' }, [
      el('option', { value: 'a', textContent: 'A' }),
      el('option', { value: 'b', textContent: 'B' }),
    ]);
    assert.equal(sel.value, 'b');
    assert.equal(sel.children[1].value, 'b');
  });
});

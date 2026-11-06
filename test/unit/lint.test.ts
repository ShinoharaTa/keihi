// 簡易 lint（docs/mvp-plan-v0.1.md T1-1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSource } from '../../tools/dev/lint.ts';

test('innerHTML・dangerouslySetInnerHTML・eval・new Function を検出する', () => {
  const src = [
    'el.innerHTML = s;',
    'el.outerHTML = s;',
    '<div dangerouslySetInnerHTML={{ __html: s }} />',
    'eval(code);',
    'const f = new Function("x", body);',
  ].join('\n');
  assert.deepEqual(
    lintSource('x.ts', src).map((f) => [f.line, f.rule]),
    [[1, 'innerHTML'], [2, 'innerHTML'], [3, 'dangerouslySetInnerHTML'], [4, 'eval'], [5, 'new Function']],
  );
});

test('似た名前は検出しない', () => {
  const src = ['el.textContent = s;', 'retrieval(x);', 'obj.evaluate(x);', 'innerHTMLish'].join('\n');
  assert.deepEqual(lintSource('x.ts', src), []);
});

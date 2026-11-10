// 簡易 lint（docs/mvp-plan-v0.1.md T1-1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkCssBraces, lintSource } from '../../tools/dev/lint.ts';

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

test('pwa/src/style.css の { と } が対応している（コメント・文字列の中は数えない。1 つ消すと落ちる）', () => {
  const css = readFileSync(new URL('../../pwa/src/style.css', import.meta.url), 'utf8');
  assert.equal(checkCssBraces('style.css', css), null);
  // 閉じ括弧を 1 つ消したコピー（#84 の @media の閉じ忘れ）と、先頭に余分な } を足したコピーは落ちる。
  const last = css.lastIndexOf('}');
  assert.equal(checkCssBraces('style.css', css.slice(0, last) + css.slice(last + 1))?.rule, 'css-braces');
  assert.equal(checkCssBraces('style.css', '}\n' + css)?.line, 1);
  // コメントと文字列（エスケープを含む）の中の括弧は数えない。
  const src = String.raw`/* { */ a { content: '}'; } b::after { content: "{\""; }` + '\n@media (x) { c { d: e } }';
  assert.equal(checkCssBraces('x.css', src), null);
  assert.equal(checkCssBraces('x.css', 'a {\n  b: c;\n')?.line, 1);
});

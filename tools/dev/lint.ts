// 簡易 lint（docs/mvp-plan-v0.1.md T1-1）。src/ と pwa/ の .ts/.tsx/.js から
// innerHTML・outerHTML・dangerouslySetInnerHTML・eval・new Function の使用を検出して失敗する。
// 字句解析はしない（コメントや文字列中の出現も検出する。保守側に倒す）。
// .css は { と } の対応だけを見る（checkCssBraces）。
//
//   node tools/dev/lint.ts            # 既定: src pwa
//   node tools/dev/lint.ts dir1 dir2
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const RULES: { name: string; re: RegExp }[] = [
  { name: 'innerHTML', re: /\b(?:inner|outer)HTML\b/ },
  { name: 'dangerouslySetInnerHTML', re: /dangerouslySetInnerHTML/ },
  { name: 'eval', re: /(?<![\w$.])eval\s*\(/ },
  { name: 'new Function', re: /\bnew\s+Function\s*\(/ },
];

const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

export type Finding = { file: string; line: number; rule: string; text: string };

export function lintSource(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  for (const [i, text] of src.split(/\r?\n/).entries()) {
    for (const r of RULES) if (r.re.test(text)) out.push({ file, line: i + 1, rule: r.name, text: text.trim() });
  }
  return out;
}

// CSS の { と } の対応（#84: 衝突の解消で @media の閉じ括弧が落ちた）。コメント（/* … */）と
// 文字列（'…' "…"、\ のエスケープを含む）の中は数えない。問題が無ければ null、あれば 1 件だけ返す。
export function checkCssBraces(file: string, src: string): Finding | null {
  let line = 1;
  const open: number[] = []; // 開いている { の行
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') line++;
    else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let j = i; j < stop; j++) if (src[j] === '\n') line++;
      i = stop - 1;
    } else if (c === "'" || c === '"') {
      for (i++; i < src.length && src[i] !== c && src[i] !== '\n'; i++) if (src[i] === '\\') i++;
      if (src[i] === '\n') line++;
    } else if (c === '{') open.push(line);
    else if (c === '}' && open.pop() === undefined) return { file, line, rule: 'css-braces', text: '対応する { が無い }' };
  }
  if (open.length) return { file, line: open[open.length - 1], rule: 'css-braces', text: `閉じていない { が ${open.length} 個（行は最後に開いたもの）` };
  return null;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p);
    } else if (e.isFile() && EXT.has(path.extname(e.name))) yield p;
  }
}

export async function lintDirs(dirs: string[]): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const d of dirs) {
    for await (const f of walk(d)) {
      const src = await readFile(f, 'utf8');
      if (path.extname(f) !== '.css') out.push(...lintSource(f, src));
      else {
        const b = checkCssBraces(f, src);
        if (b) out.push(b);
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  const findings = await lintDirs(dirs.length ? dirs : ['src', 'pwa']);
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule === 'css-braces' ? `括弧の対応: ${f.text}` : `${f.rule} は使わない: ${f.text}`}`);
  if (findings.length) {
    console.error(`lint: ${findings.length} 件`);
    process.exitCode = 1;
  } else console.log('lint: ok');
}

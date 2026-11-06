// 簡易 lint（docs/mvp-plan-v0.1.md T1-1）。src/ と pwa/ の .ts/.tsx/.js から
// innerHTML・outerHTML・dangerouslySetInnerHTML・eval・new Function の使用を検出して失敗する。
// 字句解析はしない（コメントや文字列中の出現も検出する。保守側に倒す）。
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

const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

export type Finding = { file: string; line: number; rule: string; text: string };

export function lintSource(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  for (const [i, text] of src.split(/\r?\n/).entries()) {
    for (const r of RULES) if (r.re.test(text)) out.push({ file, line: i + 1, rule: r.name, text: text.trim() });
  }
  return out;
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
  for (const d of dirs) for await (const f of walk(d)) out.push(...lintSource(f, await readFile(f, 'utf8')));
  return out;
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  const findings = await lintDirs(dirs.length ? dirs : ['src', 'pwa']);
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule} は使わない: ${f.text}`);
  if (findings.length) {
    console.error(`lint: ${findings.length} 件`);
    process.exitCode = 1;
  } else console.log('lint: ok');
}

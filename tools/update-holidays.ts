// 内閣府の「国民の祝日」CSV から src/calendar/holidays.json を作る（docs/mvp-plan-v0.1.md T1-7）。年 1 回、手で実行する。
// 出典: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html（CSV: https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv、Shift_JIS）
//
//   node tools/update-holidays.ts                       # 取得して書き出す
//   node tools/update-holidays.ts --csv ./syukujitsu.csv  # 手元の CSV から
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

export const SOURCE_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
export const OUT = 'src/calendar/holidays.json';

export type HolidaysFile = { source: string; fetched_on: string; first_year: number; last_year: number; holidays: Record<string, string> };

export function parseHolidayCsv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [i, line0] of text.split(/\r?\n/).entries()) {
    const line = line0.trim();
    if (!line || i === 0) continue;
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),(.+)$/.exec(line);
    if (!m) throw new Error(`CSV ${i + 1} 行目を解釈できない`);
    out[`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`] = m[4].trim();
  }
  if (Object.keys(out).length < 100) throw new Error('祝日の件数が少なすぎる（形式が変わった可能性）');
  return out;
}

export function buildHolidaysFile(holidays: Record<string, string>, fetchedOn: string): HolidaysFile {
  const dates = Object.keys(holidays).sort();
  const sorted: Record<string, string> = {};
  for (const d of dates) sorted[d] = holidays[d];
  return {
    source: SOURCE_URL,
    fetched_on: fetchedOn,
    first_year: Number(dates[0].slice(0, 4)),
    last_year: Number(dates[dates.length - 1].slice(0, 4)),
    holidays: sorted,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { csv: { type: 'string' }, out: { type: 'string', default: OUT } } });
  let bytes: Uint8Array;
  if (values.csv) bytes = await readFile(values.csv);
  else {
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`取得に失敗: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  const text = new TextDecoder('shift_jis').decode(bytes);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const file = buildHolidaysFile(parseHolidayCsv(text), today);
  await writeFile(values.out, JSON.stringify(file, null, 2) + '\n');
  console.log(`${values.out}: ${Object.keys(file.holidays).length} 件（${file.first_year}〜${file.last_year} 年）`);
}

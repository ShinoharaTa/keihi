// 保持期限（docs/mvp-plan-v3.md T005、docs/ops/retention.md §3）。keihi は削除しない。期限は見えるようにするだけ。
// - 起算日は [retention] start の規則。next_year_0316 = 受領日（documents.received_on）の年分の翌年 3/16。
// - 保持期限 = 起算日 + (years + extra_years) 年 の前日。例: 2027-05-10 受領 → 起算 2028-03-16 → 2036-03-15。
// - 受領日の年だけで決まる（3/15 受領も 3/16 受領も同じ年分なら同じ期限。12/31 と翌年 1/1 で 1 年ずれる）。
import { addDays } from './calendar/businessDays.ts';
import type { Config } from './config.ts';

export type RetentionDoc = { received_on: string };

export function retainUntil(doc: RetentionDoc, config: Pick<Config, 'retention'>): string {
  const { years, extraYears, start } = config.retention;
  if (start !== 'next_year_0316') throw new Error(`retention.start が不明: ${String(start)}`);
  // addDays で日付の形式と存在を確かめる（不正なら投げる）。
  const year = Number(addDays(doc.received_on, 0).slice(0, 4));
  return addDays(`${year + 1 + years + extraYears}-03-16`, -1);
}

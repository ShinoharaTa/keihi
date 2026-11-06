// PayPay の取引履歴の CSV（docs/mvp-plan-v3.md T105）。PayPay アプリ → 取引履歴 → CSV で書き出したもの。
// 列: 取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号
// - 取引日は `2026/11/04 21:47:26`。金額は `"2,200"` のようにカンマ入り、空は `-`。
// - 出金金額があれば expense、入金金額があれば income。両方 `-`（または両方ある）行は errors。
// - 取引方法が PayPayポイント の行（投資・ポイント、残高の獲得）は現金ではないので skip: 'points'（明細に入れず、件数だけ数える）。
// - ポイントと残高の併用払い（取引方法が `PayPayポイント (1,000円), PayPay残高 (2,440円)` の形）は、残高から出た分（PayPay残高 (n円)）を
//   amount にする。形が併用払い（`(n円)` を含む）なのに残高の額が取れなければ errors（mixed_method）。
// - 外部 ID は取引番号（文字列のまま。`#` 付きや先頭 0 の無いものもある）。ポイントの行と支払いの行が同じ番号を持つことがあるが、
//   ポイントの行は skip なので衝突しない。skip でない行どうしで同じ番号が出たら 2 行目を errors（duplicate_in_file）。
import type { CsvRowKind, ParsedRow, ParseError, ParseResult, Parser } from './index.ts';
import { splitCsv } from './text.ts';

export const PAYPAY_HEADER = [
  '取引日', '出金金額（円）', '入金金額（円）', '海外出金金額', '通貨', '変換レート（円）', '利用国', '取引内容', '取引先', '取引方法', '支払い区分', '利用者', '取引番号',
] as const;

const COL = { date: 0, out: 1, in: 2, content: 7, counterparty: 8, method: 9, id: 12 } as const;
const POINTS_METHOD = 'PayPayポイント';
const EMPTY = '-';
const MIXED_RE = /\(\d[\d,]*円\)/;
const BALANCE_PART_RE = /PayPay残高 \((\d[\d,]*)円\)/;

const KIND_OF: Record<string, CsvRowKind> = {
  支払い: 'payment',
  送った金額: 'transfer',
  受け取った金額: 'receive',
  チャージ: 'charge',
  請求書払い: 'bill',
  投資: 'invest',
  'ポイント、残高の獲得': 'points',
};

const DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?: \d{1,2}:\d{2}(?::\d{2})?)?$/;

function parseDate(s: string): string | null {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null;
}

// `-` か空は null。カンマを外した正の整数でなければ NaN。
function parseAmount(s: string): number | null {
  const v = s.trim();
  if (v === '' || v === EMPTY) return null;
  const n = v.replace(/,/g, '');
  return /^\d+$/.test(n) && Number(n) > 0 && Number.isSafeInteger(Number(n)) ? Number(n) : NaN;
}

const text = (s: string | undefined) => {
  const v = (s ?? '').trim();
  return v === EMPTY ? '' : v;
};

export const paypayParser: Parser = {
  id: 'paypay',
  label: 'PayPay',
  detect(headText) {
    return headText.replace(/^﻿/, '').startsWith(PAYPAY_HEADER.slice(0, 3).join(','));
  },
  parse(input): ParseResult {
    const recs = splitCsv(input.replace(/^﻿/, ''));
    const rows: ParsedRow[] = [];
    const errors: ParseError[] = [];
    const seen = new Set<string>();
    for (const r of recs.slice(1)) {
      const f = r.fields;
      const bad = (reason: string) => errors.push({ line: r.line, reason });
      if (f.length !== PAYPAY_HEADER.length) {
        bad('invalid_columns');
        continue;
      }
      const txnDate = parseDate(f[COL.date]!);
      if (!txnDate) {
        bad('invalid_date');
        continue;
      }
      const out = parseAmount(f[COL.out]!);
      const inc = parseAmount(f[COL.in]!);
      if (Number.isNaN(out) || Number.isNaN(inc)) {
        bad('invalid_amount');
        continue;
      }
      if ((out === null) === (inc === null)) {
        bad(out === null ? 'no_amount' : 'both_amounts');
        continue;
      }
      const externalId = f[COL.id]!.trim();
      if (externalId === '' || externalId === EMPTY) {
        bad('missing_external_id');
        continue;
      }
      const method = text(f[COL.method]);
      let amount = (out ?? inc)!;
      if (MIXED_RE.test(method)) {
        const m = BALANCE_PART_RE.exec(method);
        const v = m ? Number(m[1]!.replace(/,/g, '')) : NaN;
        if (!Number.isSafeInteger(v) || v <= 0) {
          bad('mixed_method');
          continue;
        }
        amount = v;
      }
      const content = text(f[COL.content]);
      const counterparty = text(f[COL.counterparty]);
      const row: ParsedRow = {
        line: r.line,
        raw: r.raw,
        externalId,
        txnDate,
        amount,
        side: out !== null ? 'expense' : 'income',
        description: [content, counterparty].filter(Boolean).join(' '),
        ...(counterparty ? { counterparty } : {}),
        ...(KIND_OF[content] ? { kind: KIND_OF[content] } : {}),
      };
      if (method === POINTS_METHOD) {
        rows.push({ ...row, skip: 'points' });
        continue;
      }
      if (seen.has(externalId)) {
        bad('duplicate_in_file');
        continue;
      }
      seen.add(externalId);
      rows.push(row);
    }
    return { rows, errors };
  },
};

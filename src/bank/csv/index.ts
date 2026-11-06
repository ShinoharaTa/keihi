// 明細の CSV のパーサーの枠（docs/mvp-plan-v3.md T105）。取り込み（DB に書く）は import.ts。
// - 文字コード: BOM で判定する（UTF-8 / UTF-16LE / UTF-16BE）。BOM が無ければ UTF-8 として読み、置換文字（U+FFFD）が出たら Shift_JIS で読む。
// - CSV の分解: 引用符・引用符の中のカンマ・改行（CRLF / LF）・"" のエスケープに対応する小さな自前の実装（依存を足さない）。
// - 文字コードと分解は text.ts（パーサーから循環 import にならないよう分けている）。
// - パーサーは PARSERS に並べ、ヘッダの行（先頭の 1 行）で選ぶ（detectParser）。
import { paypayParser } from './paypay.ts';

export { decodeCsv, headLine, splitCsv, type CsvRecord } from './text.ts';

export type CsvRowKind = 'charge' | 'transfer' | 'payment' | 'receive' | 'bill' | 'points' | 'invest';

export type ParsedRow = {
  line: number; // ファイルの中の行番号（1 始まり。ヘッダが 1 行目）
  externalId: string;
  txnDate: string; // YYYY-MM-DD
  amount: number; // 正の整数の円
  side: 'income' | 'expense';
  description: string;
  counterparty?: string;
  kind?: CsvRowKind;
  skip?: string; // 明細に入れない理由（例: points）
  raw?: string; // 行の元の文字列（取り込みで sha256 にして bank_txn_sources.raw_sha256 に入れる）
};

export type ParseError = { line: number; reason: string };
export type ParseResult = { rows: ParsedRow[]; errors: ParseError[] };

export type Parser = {
  id: string;
  label: string;
  detect(headText: string): boolean;
  parse(text: string): ParseResult;
};

export const PARSERS: readonly Parser[] = [paypayParser];

export function detectParser(headText: string): Parser | null {
  return PARSERS.find((p) => p.detect(headText)) ?? null;
}

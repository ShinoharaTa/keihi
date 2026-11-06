// CSV の文字コードの判定と行・列への分解（src/bank/csv/index.ts の枠が使う。パーサーからも読む）。
// バイト列を文字列にする。BOM は外す。
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'shift_jis' } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('�')) return { text: utf8, encoding: 'utf-8' };
  return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
}

// 先頭の 1 行（引用符の中の改行は考えない。ヘッダに改行は無い前提）。
export function headLine(text: string): string {
  const i = text.search(/\r?\n/);
  return i < 0 ? text : text.slice(0, i);
}

export type CsvRecord = { line: number; fields: string[]; raw: string }; // raw: 行の元の文字列（行末の改行は含まない）

// CSV を行に分ける。line は行の始まりの行番号（1 始まり）。空の行は返さない。
// 引用符が閉じないまま終わったら、そこまでを最後の行として返す（パーサーが列の数で errors にする）。
export function splitCsv(text: string): CsvRecord[] {
  const out: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let any = false; // この行に 1 文字でもあったか
  let from = 0; // 行の始まりの位置
  const endRecord = (to: number) => {
    fields.push(field);
    if (any) out.push({ line: start, fields, raw: text.slice(from, to) });
    fields = [];
    field = '';
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      any = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
      any = true;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      // CRLF は次の LF で行を閉じる
    } else if (ch === '\n') {
      endRecord(i > 0 && text[i - 1] === '\r' ? i - 1 : i);
      line++;
      start = line;
      from = i + 1;
    } else {
      field += ch;
      any = true;
    }
  }
  endRecord(text.length);
  return out;
}

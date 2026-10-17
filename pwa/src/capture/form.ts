// 撮影・取り込みの入力（docs/mvp-plan-v0.1.md T1-12）。純関数だけを置く（node:test で単体テストする）。
// - 種類（R1）は既定値を置かず、必ず選ばせる。scan はサイズのプリセットも必須（src/web/routes/ingest.ts と同じ）。
// - 受領日の既定は端末の今日。未来日は送らない。
// - HEIC は F14 の結果待ちなので未対応として送らない。
export type Kind = 'scan' | 'e_transaction';
export type Source = 'pwa' | 'share';

export type Fields = {
  kind: Kind | null;
  sizePreset: string | null;
  receivedOn: string; // YYYY-MM-DD
  noAi: boolean;
  force: boolean;
  source: Source;
};

export const KINDS: { value: Kind; label: string }[] = [
  { value: 'scan', label: '紙（撮影・スキャン）' },
  { value: 'e_transaction', label: '電子（PDF・データ）' },
];

// src/ingest/validate.ts の SIZE_PRESETS と同じキー。
export const SIZE_PRESETS: { value: string; label: string }[] = [
  { value: 'receipt58', label: 'レシート 58mm' },
  { value: 'receipt80', label: 'レシート 80mm' },
  { value: 'a5', label: 'A5' },
  { value: 'b5', label: 'B5' },
  { value: 'a4', label: 'A4' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

const pad = (n: number) => String(n).padStart(2, '0');

// 端末のローカル時刻での今日（YYYY-MM-DD）。
export function todayLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isHeic(name: string, type: string): boolean {
  return HEIC_TYPES.has(type.toLowerCase()) || /\.hei[cf]$/i.test(name);
}

export function emptyFields(today: string, source: Source): Fields {
  return { kind: null, sizePreset: null, receivedOn: today, noAi: false, force: false, source };
}

export function validDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

// 送信ボタンを押せるか。
export function canSend(f: Fields, today: string): boolean {
  if (f.kind === null) return false;
  if (f.kind === 'scan' && (f.sizePreset === null || !SIZE_PRESETS.some((p) => p.value === f.sizePreset))) return false;
  return validDate(f.receivedOn) && f.receivedOn <= today;
}

// サーバーの reason を利用者向けの文に直す。知らないものはそのまま出す。
const REASONS: Record<string, string> = {
  network: '通信できない（オンラインに戻ったら再送する）',
  unauthenticated: '認証できない（Tailscale を確認）',
  forbidden: 'このユーザーは許可されていない',
  invalid_origin: '送信元が許可されていない',
  too_large: 'ファイルが大きすぎる',
  unsupported_media_type: '対応していない形式（JPEG・PNG・PDF のみ）',
  kind_required: '種類を選んでいない',
  size_preset_required: 'サイズを選んでいない',
  invalid_received_on: '受領日が正しくない',
  received_on_in_future: '受領日が未来になっている',
  invalid_image: '画像を読めない',
  resolution_too_low: '解像度が足りない（近づいて撮り直すか、受け付けて紙原本を保管）',
  grayscale_or_low_bit_depth: 'カラーではない（撮り直すか、受け付けて紙原本を保管）',
  scan_requires_image: '紙の書類は画像で送る（PDF は受け付けて紙原本を保管するときだけ）',
  file_required: 'ファイルが無い',
};

export function reasonText(reason: string | null): string {
  if (reason === null) return '';
  return REASONS[reason] ?? reason;
}

// 要対応タブの表示（docs/mvp-plan.md T4-5）。GET /api/attention の項目と、retry / dismiss の文言。
export type AttentionAction = 'retry' | 'dismiss';
export type AttentionItem = {
  document_id: string;
  received_on: string;
  deadline_on: string;
  reason: string;
  kind: 'upload' | 'extract' | 'meta' | 'deal' | null;
  attention_at: string | null;
  actions: AttentionAction[];
};

export const ATTENTION_URL = '/api/attention';
export const resolveUrl = (documentId: string) => `/api/documents/${encodeURIComponent(documentId)}/attention/resolve`;

const REASONS: Record<string, string> = {
  upload_rejected: 'freee に証憑を送れませんでした',
  freee_reauth_required: 'freee の再認可が要ります',
  upload_deadline_near: '期限が近いのに freee へ未送信です',
  upload_retries_exhausted: 'freee への証憑の送信を諦めました',
  ai_request_rejected: '読み取り（AI）が受け付けられませんでした',
  ai_schema_invalid: '読み取り（AI）の結果が壊れていました',
  extract_retries_exhausted: '読み取り（AI）を諦めました',
  meta_deadline_passed: '検索項目を入れる期限を過ぎました',
  meta_update_rejected: 'freee に検索項目を入れられませんでした',
  meta_retries_exhausted: 'freee への検索項目の送信を諦めました',
  send_rejected: 'freee に取引を作れませんでした',
  send_retries_exhausted: 'freee への取引の送信を諦めました',
  build_failed: '確定の内容から取引を作れませんでした',
  review_changed_after_send: '送った後に確定の内容が変わりました',
  duplicate_deals: 'freee に同じ取引が複数あります',
  deal_missing: 'freee の取引が消えています',
  receipt_detached: 'freee の取引から証憑が外れています',
  amount_changed: 'freee 側で金額が変わっています',
  account_changed: 'freee 側で科目が変わっています',
  remote_download_failed: 'freee の証憑を取り出せませんでした',
  remote_sha256_mismatch: 'freee の証憑が原本と一致しません',
  remote_download_empty: 'freee の証憑が空でした',
  local_object_corrupt: '手元の原本が壊れています',
};

export function reasonText(reason: string): string {
  return REASONS[reason] ?? `要対応（${reason}）`;
}

export const ACTION_LABELS: Record<AttentionAction, string> = { retry: 'もう一度試す', dismiss: '対応済みにする' };

export function resolveMessage(action: AttentionAction, status: number): string {
  if (status === 200) return action === 'retry' ? 'もう一度試します。' : '対応済みにしました。';
  if (status === 0) return '通信できませんでした。もう一度押してください。';
  if (status === 409) return 'すでに対応済みか、自動では直せません。一覧を読み直しました。';
  return `できませんでした（HTTP ${status}）`;
}

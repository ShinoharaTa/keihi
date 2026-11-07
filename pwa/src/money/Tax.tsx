// 税・保険の見積もり（docs/cashflow.md §14、src/web/routes/tax.ts）。予定の先頭のカード（TaxCard）と設定画面（Tax）。
// カード: プロファイルが無ければ「設定する」だけ。あれば「2026 年分 所得 ○○万円 / 最終計算 11/7」と「設定を開く」「再計算」（POST /api/tax/recalculate）。
// 設定画面（1 画面・縦スクロール）: 青色の区分・消費税の方式（表示だけ）・国保・個人事業税・国民年金・配偶者と扶養・iDeCo 等・納税口座・年ごとの所得。
// 保存は変えた年の PUT /api/tax/years/:year → PUT /api/tax/profile の順（どちらも再計算を返す）。結果の件数と警告を画面の上に 1 行で出す。
// 年ごとの所得は年を縦に並べる（スマホで横にはみ出さないように）。入力を変えている間は onLock(true) で「戻る」を止める。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, putJson } from '../api.ts';
import { Switch } from './Accounts.tsx';
import {
  ACTUAL_FIELDS,
  BIZ_TAX_RATE,
  BLUE_RETURN_LABELS,
  BLUE_RETURNS,
  CONSUMPTION_LABELS,
  ESTIMATE_FIELDS,
  failText,
  PENSION_LABELS,
  PENSION_MODES,
  runText,
  taxCardLine,
  taxProfileBody,
  taxProfileDraft,
  taxYearBodies,
  taxYearDrafts,
  type Account,
  type RunSummary,
  type TaxProfileDraft,
  type TaxProfileResponse,
  type TaxSummary,
  type TaxYearDraft,
} from './model.ts';
import { ScreenHead } from './Money.tsx';

export function TaxCard({ tax, today, busy, onOpen, onRecalc }: { tax: TaxSummary; today: string; busy: boolean; onOpen: () => void; onRecalc: () => void }) {
  const unset = tax.missing.includes('profile');
  return (
    <section class="m-card m-pad12 m-gap6" aria-labelledby="m-tax">
      <h2 id="m-tax" class="m-h2">
        税・保険の見積もり
      </h2>
      {unset ? (
        <>
          <p class="m-sub13">所得と前年の確定値から、税金と保険料の予定を自動で入れます。</p>
          <button type="button" class="m-btn m-btn-primary m-btn-start" onClick={onOpen}>
            設定する
          </button>
        </>
      ) : (
        <>
          <p class="m-sub13">{taxCardLine(tax, today)}</p>
          <div class="m-grid2">
            <button type="button" class="m-btn" onClick={onOpen}>
              設定を開く
            </button>
            <button type="button" class="m-btn m-btn-accent" disabled={busy} onClick={onRecalc}>
              再計算
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Num({ id, label, value, placeholder, onInput }: { id: string; label: string; value: string; placeholder?: string; onInput: (v: string) => void }) {
  return (
    <label class="m-field-wrap" for={id}>
      <span class="m-label">{label}</span>
      <input id={id} class="m-field" inputMode="numeric" placeholder={placeholder} value={value} onInput={(e) => onInput(e.currentTarget.value)} />
    </label>
  );
}

export function TaxForm({
  data,
  draft,
  years,
  accounts,
  busy,
  error,
  dirty,
  onDraft,
  onYears,
  onSave,
  onReset,
}: {
  data: TaxProfileResponse;
  draft: TaxProfileDraft;
  years: TaxYearDraft[];
  accounts: Account[];
  busy: boolean;
  // 入力のまずい所（保存を押せない理由）。良ければ null。
  error: string | null;
  dirty: boolean;
  onDraft: (d: TaxProfileDraft) => void;
  onYears: (y: TaxYearDraft[]) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const set = <K extends keyof TaxProfileDraft>(k: K, v: TaxProfileDraft[K]) => onDraft({ ...draft, [k]: v });
  const setYear = (i: number, k: string, v: string) => onYears(years.map((y, j) => (j === i ? { ...y, values: { ...y.values, [k]: v } } : y)));
  const mode = data.profile?.consumption_mode ?? 'unset';
  return (
    <>
      <section class="m-card m-form" aria-labelledby="m-tax-basic">
        <h2 id="m-tax-basic" class="m-h2">
          申告と控除
        </h2>
        <fieldset class="m-fs m-fs-sm">
          <legend>青色申告特別控除</legend>
          <div class="m-seg m-seg-4">
            {BLUE_RETURNS.map((b) => (
              <button type="button" key={b} aria-pressed={draft.blue_return === b} onClick={() => set('blue_return', b)}>
                {BLUE_RETURN_LABELS[b]}
              </button>
            ))}
          </div>
        </fieldset>
        <dl class="m-dl m-dl-sm">
          <dt>消費税の方式</dt>
          <dd>{CONSUMPTION_LABELS[mode] ?? mode}</dd>
        </dl>
        <p class="m-sub">消費税の計算は次の版で対応します（今は見通しに入りません）。</p>
        <Switch label="配偶者控除" checked={draft.spouse} onChange={(v) => set('spouse', v)} />
        <div class="m-form-2">
          <Num id="m-tax-deps" label="扶養の人数" value={draft.dependents} onInput={(v) => set('dependents', v)} />
          <Num id="m-tax-other" label="iDeCo 等の年額（円）" value={draft.other_deductions} onInput={(v) => set('other_deductions', v)} />
        </div>
      </section>

      <section class="m-card m-form" aria-labelledby="m-tax-ins">
        <h2 id="m-tax-ins" class="m-h2">
          国保・年金・事業税
        </h2>
        <label class="m-field-wrap" for="m-tax-nhi">
          <span class="m-label">国民健康保険の料率</span>
          <select id="m-tax-nhi" class="m-field" value={draft.nhi_preset} onChange={(e) => set('nhi_preset', e.currentTarget.value)}>
            {data.profile && data.profile.nhi_preset === null && <option value="">（独自の料率）</option>}
            {data.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div class="m-form-2">
          <Num id="m-tax-members" label="加入人数" value={draft.nhi_members} onInput={(v) => set('nhi_members', v)} />
          <Num id="m-tax-4064" label="うち 40〜64 歳" value={draft.nhi_members_40_64} onInput={(v) => set('nhi_members_40_64', v)} />
        </div>
        <fieldset class="m-fs m-fs-sm">
          <legend>国民年金の納め方</legend>
          <div class="m-seg m-seg-4">
            {PENSION_MODES.map((p) => (
              <button type="button" key={p} aria-pressed={draft.pension_mode === p} onClick={() => set('pension_mode', p)}>
                {PENSION_LABELS[p]}
              </button>
            ))}
          </div>
          <span class="m-sub">6 か月・1 年・2 年は前納です。</span>
        </fieldset>
        <Switch label="付加保険料" sub="月 400 円" checked={draft.pension_addon} onChange={(v) => set('pension_addon', v)} />
        <Switch
          label="個人事業税の納税通知が来ている"
          sub="来ていれば税率 5% で入れます"
          checked={draft.biz_tax_rate !== null}
          onChange={(v) => set('biz_tax_rate', v ? BIZ_TAX_RATE : null)}
        />
        <label class="m-field-wrap" for="m-tax-acct">
          <span class="m-label">納税口座</span>
          <select id="m-tax-acct" class="m-field" value={draft.payment_account_id} onChange={(e) => set('payment_account_id', e.currentTarget.value)}>
            <option value="">決めない</option>
            {accounts
              .filter((a) => a.active || a.id === draft.payment_account_id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      </section>

      <section class="m-card m-form" aria-labelledby="m-tax-years">
        <h2 id="m-tax-years" class="m-h2">
          年ごとの所得
        </h2>
        <p class="m-sub">前年は申告書の確定値、今年からは見込み。空欄の年は前の年の値を繰り越します。</p>
        {years.map((y, i) => (
          <fieldset key={y.year} class="m-fs m-fs-sm">
            <legend>
              {y.year} 年（{y.kind === 'actual' ? '確定' : '見込み'}）
            </legend>
            <div class="m-form-2">
              {(y.kind === 'actual' ? ACTUAL_FIELDS : ESTIMATE_FIELDS).map((f) => (
                <Num key={f.k} id={`m-tax-${y.year}-${f.k}`} label={f.label} value={y.values[f.k] ?? ''} placeholder={y.placeholders?.[f.k]} onInput={(v) => setYear(i, f.k, v)} />
              ))}
            </div>
          </fieldset>
        ))}
      </section>

      {error && <p class="m-msg">{error}</p>}
      <div class="m-grid2">
        <button type="button" class="m-btn m-btn-primary" disabled={busy || error !== null} onClick={onSave}>
          保存して再計算
        </button>
        <button type="button" class="m-btn" disabled={busy || !dirty} onClick={onReset}>
          やめる
        </button>
      </div>
    </>
  );
}

export function Tax({
  today,
  accounts,
  locked,
  onLock,
  onBack,
}: {
  today: string;
  accounts: Account[];
  locked: boolean;
  onLock: (locked: boolean) => void;
  onBack: () => void;
}) {
  const [data, setData] = useState<TaxProfileResponse | null>(null);
  const [draft, setDraft] = useState<TaxProfileDraft>(() => taxProfileDraft(null));
  const [years, setYears] = useState<TaxYearDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // 読み直す。reset なら下書きもサーバーの値に戻す（保存の途中で失敗したときは下書きを残す）。
  const load = useCallback(
    async (reset: boolean) => {
      const r = await getJson<TaxProfileResponse>('/api/tax/profile');
      if (!r.ok) {
        setMsg(failText(r.status, r.body));
        return;
      }
      setData(r.data);
      if (!reset) return;
      setDraft(taxProfileDraft(r.data.profile));
      setYears(taxYearDrafts(r.data.years, today));
    },
    [today],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const body = taxProfileBody(draft);
  const yearBodies = data ? taxYearBodies(years, data.years) : [];
  const error = typeof body === 'string' ? body : typeof yearBodies === 'string' ? yearBodies : null;
  const dirty =
    data !== null &&
    (JSON.stringify(draft) !== JSON.stringify(taxProfileDraft(data.profile)) || JSON.stringify(years) !== JSON.stringify(taxYearDrafts(data.years, today)));
  useEffect(() => {
    onLock(dirty);
    return () => onLock(false);
  }, [dirty]);

  const save = async () => {
    if (typeof body === 'string' || typeof yearBodies === 'string') return;
    setBusy(true);
    const runs: RunSummary[] = [];
    // 年を先に、プロファイルを最後に（プロファイルの再計算が最後の入力で台帳を揃える）。
    const reqs = [...yearBodies.map((y) => ({ url: `/api/tax/years/${y.year}`, body: y.body })), { url: '/api/tax/profile', body }];
    for (const q of reqs) {
      const r = await putJson(q.url, q.body);
      if (r.status !== 200) {
        setMsg(failText(r.status, r.body));
        setBusy(false);
        if (runs.length > 0) await load(false);
        return;
      }
      runs.push((r.body as { run: RunSummary }).run);
    }
    setMsg(runText(runs, '保存しました。'));
    await load(true);
    setBusy(false);
  };

  return (
    <>
      <ScreenHead title="税・保険の見積もり" sub="概算（±1〜2 割）" backLabel="予定に戻る" locked={locked} onBack={onBack} />
      <div class="m-main">
        {msg && (
          <p class="m-msg" role="status">
            {msg}
          </p>
        )}
        {data ? (
          <TaxForm
            data={data}
            draft={draft}
            years={years}
            accounts={accounts}
            busy={busy}
            error={error}
            dirty={dirty}
            onDraft={setDraft}
            onYears={setYears}
            onSave={() => void save()}
            onReset={() => {
              setDraft(taxProfileDraft(data.profile));
              setYears(taxYearDrafts(data.years, today));
            }}
          />
        ) : (
          !msg && <p class="m-empty">読み込み中…</p>
        )}
      </div>
    </>
  );
}

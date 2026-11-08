// 税の試算（docs/cashflow.md §14.5、POST /api/tax/simulate）。仮の売上・経費で 1 年分の税・社保と手取りを見る。何も保存しない。
// 入口は予定の先頭のカード（TaxCard）と税・保険の見積もりの画面の頭。「戻る」で呼んだ画面に戻る。
// 開くと本文なしで 1 回呼び、応答の inputs で空の欄を埋める。入力が変わったら 300ms 待って送り、古い応答は捨てる（連番で比べる）。
// 計算はすべてサーバー。ここは表示だけ（負担の表・方式の比較・警告）。保存ボタンも onLock も無い。
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { postJson } from '../api.ts';
import {
  CONSUMPTION_LABELS,
  CONSUMPTION_MODES,
  ctaxReasonText,
  ctaxRowLabel,
  emptySimForm,
  failText,
  bestRow,
  marginalText,
  seedSimForm,
  SIM_DEBOUNCE_MS,
  SIM_NOTE,
  SIM_STEP_MAN,
  simAmountRows,
  simCompareRows,
  simMan,
  simNotices,
  simPct,
  SIMPLIFIED_CLASS_LABELS,
  simYears,
  stepMan,
  taxSimBody,
  type ConsumptionMode,
  type TaxSimForm,
  type TaxSimResponse,
} from './model.ts';
import { ScreenHead } from './Money.tsx';

function ManField({ id, label, value, placeholder, step, onInput }: { id: string; label: string; value: string; placeholder?: string; step?: boolean; onInput: (v: string) => void }) {
  const input = <input id={id} class="m-field" inputMode="numeric" placeholder={placeholder} value={value} onInput={(e) => onInput(e.currentTarget.value)} />;
  return (
    <div class="m-field-wrap">
      <label class="m-label" for={id}>
        {label}
      </label>
      {step ? (
        <div class="m-sim-step">
          <button type="button" class="m-btn" onClick={() => onInput(stepMan(value, -SIM_STEP_MAN))}>
            −{SIM_STEP_MAN} 万
          </button>
          {input}
          <button type="button" class="m-btn" onClick={() => onInput(stepMan(value, SIM_STEP_MAN))}>
            +{SIM_STEP_MAN} 万
          </button>
        </div>
      ) : (
        input
      )}
    </div>
  );
}

export function SimForm({
  today,
  form,
  includesTax,
  more,
  onForm,
  onMore,
}: {
  today: string;
  form: TaxSimForm;
  // 売上・経費の税込/税抜（プロファイル）。応答がまだ無ければ null。
  includesTax: boolean | null;
  // 「詳しく」（本則の課税仕入・掛金）を開いているか。
  more: boolean;
  onForm: (f: TaxSimForm) => void;
  onMore: (open: boolean) => void;
}) {
  const set = <K extends keyof TaxSimForm>(k: K, v: TaxSimForm[K]) => onForm({ ...form, [k]: v });
  const tax = includesTax === null ? '' : includesTax ? '・税込' : '・税抜';
  const years = simYears(today);
  return (
    <section class="m-card m-form" aria-labelledby="m-sim-in">
      <h2 id="m-sim-in" class="m-h2">
        条件
      </h2>
      <label class="m-field-wrap" for="m-sim-year">
        <span class="m-label">年</span>
        <select id="m-sim-year" class="m-field" value={form.year || String(years[1])} onChange={(e) => set('year', e.currentTarget.value)}>
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y} 年
            </option>
          ))}
        </select>
      </label>
      <ManField id="m-sim-rev" label={`売上（万円${tax}）`} value={form.revenue} step onInput={(v) => set('revenue', v)} />
      <ManField id="m-sim-exp" label={`経費（万円${tax}）`} value={form.expenses} step onInput={(v) => set('expenses', v)} />
      <label class="m-field-wrap" for="m-sim-mode">
        <span class="m-label">消費税の方式</span>
        <select id="m-sim-mode" class="m-field" value={form.mode} onChange={(e) => set('mode', e.currentTarget.value as ConsumptionMode)}>
          {form.mode === '' && <option value="">設定のまま</option>}
          {form.mode === 'unset' && <option value="unset">{CONSUMPTION_LABELS.unset}</option>}
          {CONSUMPTION_MODES.map((c) => (
            <option key={c} value={c}>
              {CONSUMPTION_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      {form.mode === 'simplified' && (
        <label class="m-field-wrap" for="m-sim-class">
          <span class="m-label">事業区分</span>
          <select id="m-sim-class" class="m-field" value={form.cls} onChange={(e) => set('cls', e.currentTarget.value)}>
            {form.cls === '' && <option value="">選んでください</option>}
            {SIMPLIFIED_CLASS_LABELS.map((c) => (
              <option key={c.v} value={String(c.v)}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" class="m-link" aria-expanded={more} aria-controls="m-sim-more" onClick={() => onMore(!more)}>
        詳しく
      </button>
      {more && (
        <div id="m-sim-more" class="m-form-2">
          <ManField id="m-sim-pur" label={`本則の課税仕入（万円${tax}）`} value={form.purchases} placeholder="経費と同じ" onInput={(v) => set('purchases', v)} />
          <ManField id="m-sim-ideco" label="iDeCo（万円/年）" value={form.ideco} placeholder="0" onInput={(v) => set('ideco', v)} />
          <ManField id="m-sim-kyosai" label="小規模企業共済（万円/年）" value={form.kyosai} placeholder="0" onInput={(v) => set('kyosai', v)} />
        </div>
      )}
    </section>
  );
}

export function TaxSimResult({ res, inputClass, profileClass }: { res: TaxSimResponse; inputClass: number | null; profileClass: number | null }) {
  const notices = simNotices(res);
  const saving = res.deductions.ideco + res.deductions.kyosai > 0;
  const rows = simCompareRows(res.ctax_compare, inputClass, profileClass);
  const best = bestRow(rows);
  return (
    <>
      {notices.length > 0 && (
        <div class="m-note m-col m-gap2" role="status">
          {notices.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      )}
      <section class="m-card m-pad12 m-gap8" aria-labelledby="m-sim-burden">
        <h2 id="m-sim-burden" class="m-h2">
          {res.year} 年の売上での負担
        </h2>
        <dl class="m-dl">
          {simAmountRows(res.amounts).map((r) => (
            <Fragment key={r.kind}>
              <dt>{r.label}</dt>
              <dd>{simMan(r.amount)}</dd>
            </Fragment>
          ))}
        </dl>
        <div class="m-total">
          <span>合計</span>
          <b>{simMan(res.total)}</b>
        </div>
        <div class="m-total">
          <span>手取り</span>
          <b>{simMan(res.take_home)}</b>
        </div>
        <dl class="m-dl m-dl-sm">
          <dt>実効負担率</dt>
          <dd>{simPct(res.effective_rate)}</dd>
          {saving && (
            <>
              <dt>掛金で</dt>
              <dd>−{simMan(res.deductions.saving)}</dd>
              <dt>自由に使える額</dt>
              <dd>{simMan(res.free_cash)}</dd>
            </>
          )}
        </dl>
        <p class="m-sub13">{marginalText(res.marginal)}</p>
      </section>
      <section class="m-card m-pad12 m-gap8" aria-labelledby="m-sim-ctax">
        <h2 id="m-sim-ctax" class="m-h2">
          消費税の方式の比較
        </h2>
        <dl class="m-dl3">
          <dt class="m-sub">方式</dt>
          <dd class="m-sub">消費税</dd>
          <dd class="m-sub">手取り</dd>
          {rows.map((r) => (
            <Fragment key={`${r.mode}-${r.simplified_class}`}>
              <dt class={r.available ? undefined : 'm-sim-off'}>
                {ctaxRowLabel(r)}
                {r === best && <span class="m-badge b-income m-sim-best">最安</span>}
              </dt>
              {r.available && r.tax !== null && r.take_home !== null ? (
                <>
                  <dd>{simMan(r.tax)}</dd>
                  <dd>{simMan(r.take_home)}</dd>
                </>
              ) : (
                <dd class="m-sim-off m-sim-span">{r.reason ? ctaxReasonText(r.reason) : '—'}</dd>
              )}
            </Fragment>
          ))}
        </dl>
      </section>
      <p class="m-sub13 m-px4">{SIM_NOTE}</p>
    </>
  );
}

export function TaxSim({ today, backLabel, onBack }: { today: string; backLabel: string; onBack: () => void }) {
  const [form, setForm] = useState<TaxSimForm>(emptySimForm);
  const [res, setRes] = useState<TaxSimResponse | null>(null);
  const [msg, setMsg] = useState('');
  const [more, setMore] = useState(false);
  // 比較表の簡易の区分の既定に使う、プロファイルの区分（最初に読めた応答の inputs）。
  const [profileClass, setProfileClass] = useState<number | null>(null);
  const seq = useRef(0);
  const seeded = useRef(false);
  // 埋めた直後の本文（同じ条件をもう一度送らない）。
  const skip = useRef<string | null>(null);

  const body = taxSimBody(form);
  const key = typeof body === 'string' ? body : JSON.stringify(body);
  useEffect(() => {
    const n = ++seq.current;
    if (typeof body === 'string') {
      setMsg(body);
      return;
    }
    if (key === skip.current) {
      skip.current = null;
      return;
    }
    const t = setTimeout(
      () =>
        void (async () => {
          const r = await postJson('/api/tax/simulate', body);
          if (n !== seq.current) return;
          if (r.status !== 200) {
            setMsg(failText(r.status, r.body));
            return;
          }
          const data = r.body as TaxSimResponse;
          setMsg('');
          setRes(data);
          if (!seeded.current) {
            seeded.current = true;
            setProfileClass(data.inputs.simplified_class);
            const next = seedSimForm(form, data);
            const nb = taxSimBody(next);
            const nk = typeof nb === 'string' ? null : JSON.stringify(nb);
            skip.current = nk !== key ? nk : null;
            setForm(next);
            if (next.purchases !== '' || next.ideco !== '' || next.kyosai !== '') setMore(true);
          }
        })(),
      n === 1 ? 0 : SIM_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [key]);

  return (
    <>
      <ScreenHead title="税の試算" sub="1 年分の概算" backLabel={backLabel} onBack={onBack} />
      <div class="m-main">
        {msg && (
          <p class="m-msg" role="status">
            {msg}
          </p>
        )}
        <SimForm today={today} form={form} includesTax={res ? res.inputs.revenue_includes_tax : null} more={more} onForm={setForm} onMore={setMore} />
        {res ? <TaxSimResult res={res} inputClass={form.cls === '' ? null : Number(form.cls)} profileClass={profileClass} /> : !msg && <p class="m-empty">計算中…</p>}
      </div>
    </>
  );
}

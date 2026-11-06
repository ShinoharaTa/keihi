// 月次（GET /api/summary/monthly?from&to、直近 6 か月）。月ごとのカード（収入・支出・差額）と、選んだ月の内訳の表。
// 内訳: 口座別（資金繰りの対象外の口座は区切りの下）・カテゴリ別・事業/私用別・除いた分（振替・引落・チャージ）。グラフは出さない（P4）。
// 表は 4 列まで・幅は固定の割合で、スマホの縦向きで横にはみ出さない。
import { useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { categoryLabel, failText, KIND_LABELS, monthlyUrl, splitByCashflow, TAG_LABELS, yen, type Amounts, type Categories, type MonthlySummary } from './model.ts';

type Row = { key: string; label: string; net?: number } & Amounts;

function AmountTable({ caption, rows, divider }: { caption: string; rows: Row[]; divider?: { label: string; rows: Row[] } }) {
  const line = (r: Row) => (
    <tr key={r.key}>
      <th scope="row">{r.label}</th>
      <td class="num in">{yen(r.income)}</td>
      <td class="num out">{yen(r.expense)}</td>
      <td class={(r.net ?? r.income - r.expense) < 0 ? 'num out' : 'num'}>{yen(r.net ?? r.income - r.expense)}</td>
    </tr>
  );
  return (
    <table class="tbl">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col">収入</th>
          <th scope="col">支出</th>
          <th scope="col">差額</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(line)}
        {divider && divider.rows.length > 0 && (
          <tr class="tbl-divider">
            <th scope="rowgroup" colSpan={4}>
              {divider.label}
            </th>
          </tr>
        )}
        {divider?.rows.map(line)}
      </tbody>
    </table>
  );
}

export function MonthlyView({ months, selected, cats, onSelect }: { months: MonthlySummary[]; selected: string; cats: Categories | null; onSelect: (m: string) => void }) {
  const cur = months.find((m) => m.month === selected) ?? null;
  const acc = cur ? splitByCashflow(cur.by_account) : null;
  const accRow = (r: MonthlySummary['by_account'][number]): Row => ({ key: r.account_id, label: r.active ? r.name : `${r.name}（無効）`, income: r.income, expense: r.expense, net: r.net });
  return (
    <>
      <ul class="months" aria-label="月">
        {[...months].reverse().map((m) => (
          <li key={m.month}>
            <button type="button" class={m.month === selected ? 'month month-on' : 'month'} aria-pressed={m.month === selected} onClick={() => onSelect(m.month)}>
              <span class="month-name">{m.month}</span>
              <span class="num in">+{yen(m.total.income)}</span>
              <span class="num out">−{yen(m.total.expense)}</span>
              <span class={m.total.net < 0 ? 'num out month-net' : 'num month-net'}>{yen(m.total.net)}</span>
            </button>
          </li>
        ))}
      </ul>
      {cur && acc && (
        <>
          <AmountTable caption={`${cur.month} 口座別`} rows={acc.inside.map(accRow)} divider={{ label: '資金繰り対象外', rows: acc.outside.map(accRow) }} />
          <AmountTable
            caption="カテゴリ別"
            rows={cur.by_category.map((r) => ({ key: r.category ?? 'none', label: categoryLabel(cats, r.category), income: r.income, expense: r.expense }))}
          />
          <AmountTable caption="事業 / 私用" rows={cur.by_tag.map((r) => ({ key: r.tag, label: TAG_LABELS[r.tag], income: r.income, expense: r.expense }))} />
          {cur.excluded.length > 0 && (
            <table class="tbl">
              <caption>集計から除いた分</caption>
              <thead>
                <tr>
                  <th scope="col" />
                  <th scope="col">件数</th>
                  <th scope="col">入金</th>
                  <th scope="col">出金</th>
                </tr>
              </thead>
              <tbody>
                {cur.excluded.map((r) => (
                  <tr key={r.kind}>
                    <th scope="row">{KIND_LABELS[r.kind]}</th>
                    <td class="num">{r.count}</td>
                    <td class="num">{yen(r.income)}</td>
                    <td class="num">{yen(r.expense)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

export function Monthly({ today, cats }: { today: string; cats: Categories | null }) {
  const [months, setMonths] = useState<MonthlySummary[] | null>(null);
  const [selected, setSelected] = useState(today.slice(0, 7));
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void (async () => {
      const r = await getJson<{ months: MonthlySummary[] }>(monthlyUrl(today));
      if (r.ok) setMonths(r.data.months);
      else setMsg(failText(r.status));
    })();
  }, [today]);

  return (
    <>
      {msg && <p class="msg">{msg}</p>}
      {months && <MonthlyView months={months} selected={selected} cats={cats} onSelect={setSelected} />}
    </>
  );
}

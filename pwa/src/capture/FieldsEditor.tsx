// 種類・サイズ・受領日・no_ai・force の入力。撮影画面と送信待ち（draft / rejected）の両方で使う。
import { KINDS, SIZE_PRESETS, type Fields } from './form.ts';

type Props = { fields: Fields; today: string; onChange: (f: Fields) => void };

export function FieldsEditor({ fields, today, onChange }: Props) {
  const set = (patch: Partial<Fields>) => onChange({ ...fields, ...patch });
  return (
    <div class="fields">
      <div class="label">種類（必須）</div>
      <div class="seg" role="group" aria-label="種類">
        {KINDS.map((k) => (
          <button
            type="button"
            key={k.value}
            class={fields.kind === k.value ? 'seg-on' : ''}
            aria-pressed={fields.kind === k.value}
            onClick={() => set({ kind: k.value, sizePreset: k.value === 'scan' ? fields.sizePreset : null })}
          >
            {k.label}
          </button>
        ))}
      </div>
      {fields.kind === 'scan' && (
        <>
          <div class="label">書類の大きさ（必須）</div>
          <div class="seg seg-wrap" role="group" aria-label="書類の大きさ">
            {SIZE_PRESETS.map((p) => (
              <button
                type="button"
                key={p.value}
                class={fields.sizePreset === p.value ? 'seg-on' : ''}
                aria-pressed={fields.sizePreset === p.value}
                onClick={() => set({ sizePreset: p.value })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
      <label class="label" for="received-on">
        受領日
      </label>
      <input
        id="received-on"
        class="date"
        type="date"
        max={today}
        value={fields.receivedOn}
        onInput={(e) => set({ receivedOn: (e.currentTarget as HTMLInputElement).value })}
      />
      <label class="toggle">
        <input type="checkbox" checked={fields.noAi} onChange={(e) => set({ noAi: (e.currentTarget as HTMLInputElement).checked })} />
        <span>AI に送らない（手で入力する）</span>
      </label>
      <label class="toggle">
        <input type="checkbox" checked={fields.force} onChange={(e) => set({ force: (e.currentTarget as HTMLInputElement).checked })} />
        <span>要件を満たさなくても受け付ける（紙の原本を保管する）</span>
      </label>
    </div>
  );
}

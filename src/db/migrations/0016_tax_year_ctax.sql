-- 消費税の方式を年ごとに上書きする（docs/cashflow.md §14.1、issue #93）。NULL の年は tax_profile の方式を使う（後の年に繰り越さない）。
-- 例: profile = 簡易課税 第 5 種（今後ずっと使う方式）、2026 年の行 = special20（2 割特例は 2026 年分まで）。
-- 年の行では 'unset' を持たない。simplified のときだけ区分（1〜6）が要り、それ以外は区分 NULL。
-- consumption_mode の CHECK は simplified_class を見るので、simplified_class を先に足す。
-- NULL の比較は NULL（CHECK は通る）になるので、IN・= の前に IS NOT NULL / IS で (NULL, 区分あり) を落とす。
ALTER TABLE tax_years ADD COLUMN simplified_class INTEGER CHECK (simplified_class IS NULL OR (typeof(simplified_class) = 'integer' AND simplified_class BETWEEN 1 AND 6));
ALTER TABLE tax_years ADD COLUMN consumption_mode TEXT CHECK (
  (consumption_mode IS NULL AND simplified_class IS NULL) OR
  (consumption_mode IS NOT NULL AND consumption_mode IN ('exempt', 'special20', 'standard') AND simplified_class IS NULL) OR
  (consumption_mode IS 'simplified' AND simplified_class IS NOT NULL)
);

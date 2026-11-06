// 営業日と入力期限（docs/mvp-plan-v0.1.md T1-7、R6）。期待値は 2026〜2027 年の暦と内閣府の祝日で手計算したもの。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths,
  deadline,
  holidayName,
  isBusinessDay,
  subtractBusinessDays,
  todayInTokyo,
  type CalendarOptions,
  type DeadlineMode,
} from '../../src/calendar/businessDays.ts';
import { buildHolidaysFile, parseHolidayCsv } from '../../tools/update-holidays.ts';

type Case = [received: string, mode: DeadlineMode, opts: CalendarOptions, expected: string, note: string];
const YE: CalendarOptions = { yearEndHolidays: true };
const ND: CalendarOptions = { countFrom: 'next_day' };

const CASES: Case[] = [
  ['2026-10-16', 'early', {}, '2026-10-26', '金曜受領は当日が 1 日目'],
  ['2026-10-17', 'early', {}, '2026-10-27', '土曜受領は月曜が 1 日目'],
  ['2026-10-18', 'early', {}, '2026-10-27', '日曜受領'],
  ['2026-10-09', 'early', {}, '2026-10-20', 'スポーツの日をまたぐ'],
  ['2026-10-12', 'early', {}, '2026-10-21', '祝日に受領'],
  ['2026-04-28', 'early', {}, '2026-05-12', 'ゴールデンウィーク（5/6 休日を含む）'],
  ['2026-09-18', 'early', {}, '2026-10-01', '9/21〜23 の連休と月末をまたぐ'],
  ['2026-01-30', 'early', {}, '2026-02-09', '月末をまたぐ'],
  ['2026-02-10', 'early', {}, '2026-02-19', '建国記念の日をまたぐ'],
  ['2027-03-19', 'early', {}, '2027-03-30', '春分の日の振替休日をまたぐ'],
  ['2026-12-25', 'early', {}, '2027-01-05', '年末年始を営業日扱い（既定）。元日だけ休み'],
  ['2026-12-25', 'early', YE, '2027-01-08', '年末年始（12/29〜1/3）を休業日に含める'],
  ['2026-12-28', 'early', {}, '2027-01-06', '年末に受領（既定）'],
  ['2026-12-28', 'early', YE, '2027-01-12', '年末年始 + 成人の日'],
  ['2026-12-31', 'early', {}, '2027-01-12', '大晦日に受領、元日・成人の日をまたぐ'],
  ['2026-10-16', 'early', ND, '2026-10-27', 'next_day: 翌日から数える'],
  ['2026-10-17', 'early', ND, '2026-10-27', 'next_day: 土曜受領'],
  ['2026-12-25', 'early', ND, '2027-01-06', 'next_day: 年末をまたぐ'],
  ['2026-10-16', 'cycle', {}, '2026-12-24', 'cycle: 12/16 起点'],
  ['2026-10-16', 'cycle', ND, '2026-12-25', 'cycle + next_day'],
  ['2026-12-31', 'cycle', {}, '2027-03-09', 'cycle: 応当日が無い → 2/28（日曜）'],
  ['2026-12-30', 'cycle', {}, '2027-03-09', 'cycle: 2/30 も 2/28 に寄せる'],
  ['2026-10-31', 'cycle', {}, '2027-01-12', 'cycle: 起点 12/31、元日・成人の日をまたぐ'],
  ['2026-10-31', 'cycle', YE, '2027-01-13', 'cycle: 起点が年末年始の休業日'],
  ['2026-08-31', 'cycle', {}, '2026-11-11', 'cycle: 起点 10/31（土）、文化の日をまたぐ'],
];

describe('deadline（表駆動）', () => {
  for (const [received, mode, opts, expected, note] of CASES) {
    test(`${received} ${mode} ${JSON.stringify(opts)} → ${expected}（${note}）`, () => {
      const d = deadline(received, mode, opts);
      assert.equal(d.deadlineOn, expected);
      assert.deepEqual(d.warnings, []);
    });
  }

  test('祝日データの無い年にかかると警告', () => {
    assert.deepEqual(deadline('2027-12-28', 'early').warnings, ['holidays_missing:2028']);
    assert.deepEqual(deadline('2029-06-01', 'early').warnings, ['holidays_missing:2029']);
  });

  test('不正な入力は拒否', () => {
    assert.throws(() => deadline('2026-02-30', 'early'), /存在しない日付/);
    assert.throws(() => deadline('2026/10/16', 'early'), /YYYY-MM-DD/);
    assert.throws(() => deadline('2026-10-16', '7bd' as DeadlineMode), /early か cycle/);
  });
});

test('営業日の判定', () => {
  assert.equal(isBusinessDay('2026-10-16'), true);
  assert.equal(isBusinessDay('2026-10-17'), false);
  assert.equal(isBusinessDay('2026-11-03'), false);
  assert.equal(isBusinessDay('2026-12-29'), true);
  assert.equal(isBusinessDay('2026-12-29', YE), false);
  assert.equal(isBusinessDay('2027-01-04', YE), true);
  assert.equal(holidayName('2026-09-22'), '休日');
});

test('月の加算と、前の営業日', () => {
  assert.equal(addMonths('2027-12-31', 2), '2028-02-29');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-15', 2), '2027-01-15');
  assert.equal(subtractBusinessDays('2026-10-26', 2), '2026-10-22');
  assert.equal(subtractBusinessDays('2027-01-05', 2), '2026-12-31');
  assert.equal(subtractBusinessDays('2027-01-05', 2, YE), '2026-12-28');
});

test('Asia/Tokyo の今日', () => {
  assert.equal(todayInTokyo(new Date('2026-10-16T14:59:59Z')), '2026-10-16');
  assert.equal(todayInTokyo(new Date('2026-10-16T15:00:00Z')), '2026-10-17');
});

test('update-holidays の CSV 解釈', () => {
  const rows = ['国民の祝日・休日月日,国民の祝日・休日名称'];
  for (let m = 1; m <= 12; m++) for (let d = 1; d <= 10; d++) rows.push(`2030/${m}/${d},祝日${m}-${d}`);
  rows.push('2031/1/1,元日');
  const f = buildHolidaysFile(parseHolidayCsv(rows.join('\r\n')), '2026-10-17');
  assert.equal(f.first_year, 2030);
  assert.equal(f.last_year, 2031);
  assert.equal(f.holidays['2031-01-01'], '元日');
  assert.throws(() => parseHolidayCsv('h\n2030-1-1,x'), /解釈できない/);
});

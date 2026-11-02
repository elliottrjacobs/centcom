import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, dateKey, offsetDate, parseDate } from './calendar';
test('calendar preserves local dates and crosses leap years and daylight savings', () => {
  for (const key of ['2024-02-29','2026-03-08','2026-11-01','2026-12-31']) assert.equal(dateKey(parseDate(key)), key);
  assert.equal(dateKey(offsetDate(parseDate('2024-02-28'), 1)), '2024-02-29');
  assert.equal(dateKey(offsetDate(parseDate('2026-03-08'), 1)), '2026-03-09');
  assert.equal(dateKey(offsetDate(parseDate('2026-12-31'), 1)), '2027-01-01');
  const days = calendarDays(parseDate('2026-10-15'));
  assert.equal(days.length, 42);
  assert.equal(days[0]!.getDay(), 0);
  assert.equal(new Set(days.map(dateKey)).size, 42);
  assert.equal(days.filter(d=>d.getMonth()===9).length, 31);
});

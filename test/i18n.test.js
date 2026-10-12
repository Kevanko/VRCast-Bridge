import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/m/en.js', import.meta.url), 'utf8'), sandbox);
const { exact, patterns } = sandbox.window.VRCAST_EN;
const holes = s => (s.match(/\{\}/g) || []).length;

test('английский словарь: перевод без кириллицы, подстановки совпадают, длинные шаблоны первыми', () => {
  assert.ok(Object.keys(exact).length > 700, 'словарь не пустой');
  for (const [ru, en] of Object.entries(exact)) {
    // Названия тем в кавычках («Минимализм») остаются как в программе.
    assert.ok(!/[А-Яа-яЁё]/.test(en.replace(/«[^»]*»/g, '')), `без кириллицы: ${ru} → ${en}`);
  }
  for (const [ru, en] of patterns) assert.equal(holes(ru), holes(en), `подстановки: ${ru} → ${en}`);
  const len = p => p[0].replace(/\{\}/g, '').length;
  for (let i = 1; i < patterns.length; i++) assert.ok(len(patterns[i - 1]) >= len(patterns[i]), `порядок: ${patterns[i][0]}`);
  assert.equal(exact['В эфире'], 'Live');
});

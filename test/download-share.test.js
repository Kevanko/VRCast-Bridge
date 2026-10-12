import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadShare } from '../src/download-share.js';

test('доля скачанного: видео, затем звук заново с нуля; прочие строки не считаются', () => {
  const share = downloadShare();
  assert.equal(share('[youtube] abc: Downloading webpage'), null);
  assert.equal(share('[download]  50.0% of   10.00MiB at  2.00MiB/s ETA 00:02'), 0.45);
  assert.equal(share('[download] 100% of   10.00MiB in 00:00:05'), 0.9);
  assert.equal(share('[download]   0.0% of    1.00MiB'), 0.9, 'звук начался с нуля — полоса не откатывается');
  assert.equal(share('[download] 100% of    1.00MiB'), 0.99);
});

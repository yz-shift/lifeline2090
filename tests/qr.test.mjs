// The poster's QR encoder. Its matrices were checked module for module against python-qrcode and decoded with
// zxing-cpp while it was written; here the structure is pinned so that a regression shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix } from '../src/ui/qr.js';

test('qr: version by length, finder patterns, timing, dark module', () => {
  assert.equal(qrMatrix('HELLO').version, 1);
  assert.equal(qrMatrix('https://yz-shift.github.io/lifeline2090/').version, 3);
  assert.equal(qrMatrix('z'.repeat(200)).version, 10);
  assert.equal(qrMatrix('z'.repeat(400)), null);
  const q = qrMatrix('https://yz-shift.github.io/lifeline2090/');
  assert.equal(q.size, 29);
  for (const [ox, oy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.ok(q.dark(ox + i, oy) && q.dark(ox + i, oy + 6) && q.dark(ox, oy + i) && q.dark(ox + 6, oy + i));
      if (i >= 1 && i <= 5) assert.ok(!q.dark(ox + i, oy + 1) && !q.dark(ox + 1, oy + i));
    }
  }
  for (let i = 8; i < q.size - 8; i++) assert.equal(q.dark(i, 6), i % 2 === 0);
  assert.ok(q.dark(8, q.size - 8));
});

test('qr: the same text gives the same matrix; a forced mask is used', () => {
  const bits = (q) => Array.from({ length: q.size * q.size }, (_, i) => +q.dark(i % q.size, Math.floor(i / q.size))).join('');
  assert.equal(bits(qrMatrix('人生长河')), bits(qrMatrix('人生长河')));
  assert.equal(qrMatrix('HELLO', { mask: 5 }).mask, 5);
});

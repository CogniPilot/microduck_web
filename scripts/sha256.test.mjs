import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {sha256Portable, sha256Hex} from '../site/sha256.js';

const reference = bytes => createHash('sha256').update(bytes).digest('hex');

test('the portable SHA-256 equals the reference at every padding boundary and on random data', () => {
  for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65536 + 7]) {
    const bytes = randomBytes(length);
    assert.equal(sha256Portable(bytes), reference(bytes), 'length ' + length);
    assert.equal(sha256Portable(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length)), reference(bytes), 'ArrayBuffer of length ' + length);
  }
  assert.equal(sha256Portable(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('without Web Crypto (a plain-http page) the digest is computed, not refused', async () => {
  const bytes = randomBytes(4096), saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {value: {}, configurable: true});
  try { assert.equal(await sha256Hex(bytes), reference(bytes)); }
  finally { Object.defineProperty(globalThis, 'crypto', saved); }
  assert.equal(await sha256Hex(bytes), reference(bytes));
});

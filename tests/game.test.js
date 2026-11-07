import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWord, wordError, consensus, createRoomCode, remainingSeconds } from '../src/game.js';

test('trims words and rejects empty or overlong submissions', () => {
  assert.equal(normalizeWord('  山 海  '), '山 海');
  assert.equal(wordError('   '), '请输入一个词语');
  assert.equal(wordError('山'.repeat(21)), '词语最多 20 个字');
  assert.equal(wordError(' 山 '), '');
});

test('counts the largest matching group and detects consensus', () => {
  assert.deepEqual(consensus(['山', '海', '山']), {
    leader: '山', count: 2, total: 3, percent: 67, matched: false,
  });
  assert.deepEqual(consensus(['海', '海']), {
    leader: '海', count: 2, total: 2, percent: 100, matched: true,
  });
});

test('creates six-character room codes without ambiguous characters', () => {
  const code = createRoomCode(new Uint8Array([0, 1, 2, 3, 4, 5]));
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(code.length, 6);
});

test('countdown rounds up and stops at zero', () => {
  assert.equal(remainingSeconds(1_000, 15, 15_001), 1);
  assert.equal(remainingSeconds(1_000, 15, 16_000), 0);
});

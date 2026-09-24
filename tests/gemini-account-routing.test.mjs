import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseGeminiAccount } from '../lib/gemini-account-routing.ts';

test('product jobs use an idle account even when their legacy default is busy or deleted', () => {
  for (const pin of ['busy-account', 'deleted-account', null, 'idle-b']) {
    assert.equal(chooseGeminiAccount('standard', pin, new Set(['idle-a', 'idle-b'])), 'idle-a');
  }
});
test('each advertised idle account receives at most one job per batch', () => {
  const idle = new Set(['a', 'b']);
  const assigned = [];
  for (let i = 0; i < 3; i++) {
    const id = chooseGeminiAccount('standard', 'a', idle);
    if (id) { assigned.push(id); idle.delete(id); }
  }
  assert.deepEqual(assigned, ['a', 'b']);
});
test('no idle account means keep waiting, not force a busy account', () => {
  assert.equal(chooseGeminiAccount('standard', 'busy', new Set()), null);
});
test('specialist tool explicit account selections remain respected', () => {
  for (const kind of ['reference-remix', 'script-pipeline']) {
    assert.equal(chooseGeminiAccount(kind, 'b', new Set(['a', 'b'])), 'b');
    assert.equal(chooseGeminiAccount(kind, 'busy', new Set(['a'])), null);
  }
});

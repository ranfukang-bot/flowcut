import test from 'node:test';
import assert from 'node:assert/strict';
import * as statuses from '../lib/task-statuses.ts';

const statusGroups = ['VIDEO_DONE_STATUSES', 'VIDEO_FAILED_STATUSES', 'VIDEO_RUNNING_STATUSES', 'PROMPT_ONLY_STATUSES',
  'PROMPT_ROUND_STATUSES', 'VARIANT_ROUND_STATUSES', 'GEMINI_STATUSES', 'GROUP_DONE_STATUSES'];

test('every task status used in a group has a Chinese name, so a new status cannot show up as raw English', () => {
  for (const group of statusGroups) {
    assert.ok(statuses[group].length > 0, group);
    for (const status of statuses[group]) assert.match(statuses.TASK_STATUS_LABELS[status] || '', /[一-鿿]/, `${group}: ${status}`);
  }
});

test('Gemini statuses are exactly the first round plus the variant round', () => {
  assert.deepEqual([...statuses.GEMINI_STATUSES], [...statuses.PROMPT_ROUND_STATUSES, ...statuses.VARIANT_ROUND_STATUSES]);
});

test('SQL lists are built only from the fixed constants, in order', () => {
  assert.equal(statuses.sqlList(statuses.VIDEO_DONE_STATUSES), "'video_ready','scheduled'");
  assert.equal(statuses.sqlList([...statuses.APPROVED_REVIEW_STATUSES, ...statuses.CONCAT_REVIEW_STATUSES]), "'approved','replaced','merging','merged'");
});

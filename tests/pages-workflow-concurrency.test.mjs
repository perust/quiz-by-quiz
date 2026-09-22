import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

test('deployment eligibility always rejects a stale workflow SHA', async () => {
  const { isCurrentPagesHead } = await import('../tools/check-pages-head.mjs');

  assert.equal(isCurrentPagesHead(NEW_SHA, NEW_SHA), true);
  assert.equal(isCurrentPagesHead(OLD_SHA, NEW_SHA), false);

  for (const completionOrder of [[OLD_SHA, NEW_SHA], [NEW_SHA, OLD_SHA]]) {
    assert.deepEqual(
      completionOrder.filter((candidate) => isCurrentPagesHead(candidate, NEW_SHA)),
      [NEW_SHA],
    );
  }

  const script = fileURLToPath(new URL('../tools/check-pages-head.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [script, NEW_SHA, NEW_SHA]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [script, OLD_SHA, NEW_SHA]).status, 0);
});

test('serialized main schedules never publish an older revision after a newer one', async () => {
  const { isCurrentPagesHead } = await import('../tools/check-pages-head.mjs');
  const publish = (history, candidate, headAtGate) => {
    if (isCurrentPagesHead(candidate, headAtGate)) history.push(candidate);
  };

  const oldThenNew = [];
  publish(oldThenNew, OLD_SHA, OLD_SHA);
  publish(oldThenNew, NEW_SHA, NEW_SHA);
  assert.deepEqual(oldThenNew, [OLD_SHA, NEW_SHA]);

  const newBeforeQueuedOld = [];
  publish(newBeforeQueuedOld, NEW_SHA, NEW_SHA);
  publish(newBeforeQueuedOld, OLD_SHA, NEW_SHA);
  assert.deepEqual(newBeforeQueuedOld, [NEW_SHA]);

  const rerunOldAfterNew = [NEW_SHA];
  publish(rerunOldAfterNew, OLD_SHA, NEW_SHA);
  assert.deepEqual(rerunOldAfterNew, [NEW_SHA]);

  // A main push arriving after A's gate cannot publish B concurrently: the
  // workflow-wide, non-cancelling pages-main group lets A finish before B.
  assert.deepEqual(oldThenNew, [OLD_SHA, NEW_SHA]);
});

test('workflow isolates PRs and checks authoritative main immediately before publish', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/pages.yml', import.meta.url),
    'utf8',
  );
  const jobsIndex = workflow.indexOf('\njobs:');
  assert.notEqual(jobsIndex, -1);

  const workflowHeader = workflow.slice(0, jobsIndex);
  const deployStart = workflow.indexOf('\n  deploy:');
  const deployJob = workflow.slice(deployStart);

  assert.match(workflowHeader, /\nconcurrency:\s*\n/);
  assert.match(workflowHeader, /github\.event_name == 'pull_request'/);
  assert.match(workflowHeader, /format\('pages-pr-\{0\}', github\.event\.pull_request\.number\)/);
  assert.match(workflowHeader, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflowHeader, /'pages-main'/);
  assert.match(
    workflowHeader,
    /cancel-in-progress:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/,
  );
  assert.doesNotMatch(
    workflowHeader,
    /cancel-in-progress:[\s\S]*?github\.ref == 'refs\/heads\/main'/,
  );
  assert.doesNotMatch(deployJob, /\n    concurrency:\s*\n/);

  const uploadIndex = deployJob.indexOf('uses: actions/upload-pages-artifact@v3');
  const fetchIndex = deployJob.indexOf('git fetch --no-tags origin');
  const gateIndex = deployJob.indexOf('node tools/check-pages-head.mjs "$GITHUB_SHA" "$head_sha"');
  const publishIndex = deployJob.indexOf('uses: actions/deploy-pages@v4');
  assert.ok(uploadIndex >= 0 && uploadIndex < fetchIndex);
  assert.ok(fetchIndex < gateIndex && gateIndex < publishIndex);
  assert.doesNotMatch(deployJob.slice(gateIndex, publishIndex), /\n\s+- uses:/);
});

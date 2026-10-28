// .github/workflows/uptime.yml — 15분마다 공개 서비스를 읽기만 해서 보는 점검의 계약.
// 경보 이슈를 하나로 지키는 판단은 deploy/oracle/uptime.py(tests/test_uptime.py)에 있고, 여기서는
// workflow가 그것을 부르는 모양 — 주기·권한·겹치지 않기·취소된 실행은 알리지 않기·job 실패로 메일
// 보내기 — 을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/uptime.yml', import.meta.url), 'utf8');
const jobsIndex = workflow.indexOf('\njobs:');
const header = workflow.slice(0, jobsIndex);
const jobs = workflow.slice(jobsIndex);

/** `- name: <이름>`으로 시작하는 step 하나의 글. 다음 step 앞까지다. */
function step(name) {
  const start = jobs.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `step «${name}» is missing`);
  const next = jobs.indexOf('\n      - ', start + 1);
  return jobs.slice(start, next === -1 ? undefined : next);
}

test('uptime runs every 15 minutes and on demand, nothing else', () => {
  assert.notEqual(jobsIndex, -1);
  const on = header.slice(header.indexOf('\non:'), header.indexOf('\npermissions:'));
  // 15분 간격이되 정각을 피한다 — GitHub 은 정각 부근의 예약을 늦추거나 건너뛴다. '*/15' 는 7시간 넘게 돌지 않았다
  const cron = on.match(/\n {2}schedule:\n(?: {4}#[^\n]*\n)* {4}- cron: '([^']+)'\n/)?.[1];
  assert.ok(cron, 'schedule 에 cron 이 하나 있다');
  const [minutes, ...rest] = cron.split(' ');
  assert.deepEqual(rest, ['*', '*', '*', '*'], cron);
  const marks = minutes.split(',').map(Number);
  assert.equal(marks.length, 4, cron);
  assert.ok(marks.every((minute) => Number.isInteger(minute) && minute > 0 && minute < 60), `정각(0분)이 없다: ${cron}`);
  assert.deepEqual(
    marks.map((minute, index) => (marks[(index + 1) % 4] - minute + 60) % 60),
    [15, 15, 15, 15],
    `15분 간격: ${cron}`,
  );
  assert.match(on, /\n {2}workflow_dispatch:\n/);
  // push·pull_request로 돌면 PR마다 경보가 열릴 수 있다
  assert.doesNotMatch(on, /push:|pull_request/);
});

test('uptime holds only the permissions it needs', () => {
  const permissions = header.slice(header.indexOf('\npermissions:'), header.indexOf('\nconcurrency:'));
  const granted = [...permissions.matchAll(/\n {2}([a-z-]+): ([a-z]+)/g)].map((match) => [
    match[1],
    match[2],
  ]);
  assert.deepEqual(granted, [
    ['contents', 'read'],
    ['issues', 'write'],
  ]);
  // job 단위로 권한을 넓히지 않는다
  assert.doesNotMatch(jobs, /\n {4}permissions:/);
});

test('runs never pile up and a running check is not cancelled', () => {
  const concurrency = header.slice(header.indexOf('\nconcurrency:'));
  assert.match(concurrency, /\n {2}group: uptime\n/);
  assert.match(concurrency, /\n {2}cancel-in-progress: false\n/);
  const timeout = jobs.match(/\n {4}timeout-minutes: (\d+)\n/);
  assert.ok(timeout, 'the job needs a timeout');
  assert.ok(Number(timeout[1]) <= 10, 'the timeout stays small');
});

test('a stuck probe fails its own step before the job limit cancels the run', () => {
  // job 한도에 걸리면 실행이 취소되고 취소는 알리지 않는다. 그래서 점검 step이 먼저 제 한도에 걸려
  // 실패해야 멈춘 점검도 경보가 된다(설계상 가장 긴 점검이 그 한도 안인지는 tests/test_uptime.py가 본다).
  const job = Number(jobs.match(/\n {4}timeout-minutes: (\d+)\n/)[1]);
  const probe = step('공개 API·Pages 점검').match(/\n {8}timeout-minutes: (\d+)\n/);
  assert.ok(probe, 'the probe step needs its own timeout');
  assert.ok(
    Number(probe[1]) < job,
    'the probe limit leaves the alert steps time inside the job limit',
  );
});

test('a cancelled run neither opens, comments on nor closes an alert, nor fails the alert path', () => {
  // always()는 취소된 실행에서도 돈다. 그때 점검은 상태를 남기지 못해 «missing»이 실패로 읽히고
  // 공개 경보가 열렸다. 취소가 아니면(통과·실패·점검 step 한도) 돈다.
  const condition = (name) => step(name).match(/\n {8}if: (.*)\n/)?.[1];
  assert.equal(condition('운영 경보 이슈 열기·덧붙이기·닫기'), '${{ !cancelled() }}');
  assert.equal(
    condition('점검이 실패했으면 job을 실패로 끝낸다'),
    "${{ !cancelled() && steps.probe.outputs.status != '0' }}",
  );
  // 조건이 있는 step은 이 둘뿐이다 — 어느 step에도 always()를 되살리지 않는다
  const conditions = [...jobs.matchAll(/\n {8}if: (.*)\n/g)].map((match) => match[1]);
  assert.equal(conditions.length, 2);
  assert.ok(conditions.every((value) => !value.includes('always()')));
});

test('the probe records its status without failing the job early', () => {
  const probe = step('공개 API·Pages 점검');
  assert.match(probe, /\n {8}id: probe\n/);
  assert.match(
    probe,
    /python3 deploy\/oracle\/uptime\.py check --report "\$RUNNER_TEMP\/uptime-report\.txt" \|\| status=\$\?/,
  );
  assert.match(probe, /echo "status=\$status" >> "\$GITHUB_OUTPUT"/);
  // 쓰기 점검(smoke.py)은 부르지 않는다 — 방·세션을 만들지 않는다
  assert.doesNotMatch(workflow, /smoke\.py/);
});

test('the alert step runs with the token and keeps one issue through uptime.py', () => {
  const notify = step('운영 경보 이슈 열기·덧붙이기·닫기');
  assert.match(notify, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(notify, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(notify, /PROBE_STATUS: \$\{\{ steps\.probe\.outputs\.status \}\}/);
  assert.match(
    notify,
    /RUN_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/,
  );
  assert.match(notify, /python3 deploy\/oracle\/uptime\.py notify/);
  // 비었으면(점검 step이 제 한도에 끊겼다) 실패로 다룬다(uptime.py는 0만 통과로 본다)
  assert.match(notify, /--status "\$\{PROBE_STATUS:-missing\}"/);
  assert.match(notify, /--run-url "\$RUN_URL"/);
  // step 출력이나 이슈 글을 run 스크립트에 직접 끼워 넣지 않는다
  const script = notify.slice(notify.indexOf('run: |'));
  assert.doesNotMatch(script, /\$\{\{/);
});

test('a failed check fails the job so GitHub e-mails the owner', () => {
  const fail = step('점검이 실패했으면 job을 실패로 끝낸다');
  // 조건은 위 «취소된 실행» 테스트가 잠근다 — 점검이 0이 아닐 때만이다
  assert.match(fail, /steps\.probe\.outputs\.status != '0'/);
  assert.match(fail, /\n {10}exit 1\n?/);
  const order = [
    jobs.indexOf('- name: 공개 API·Pages 점검'),
    jobs.indexOf('- name: 운영 경보 이슈 열기·덧붙이기·닫기'),
    jobs.indexOf('- name: 점검이 실패했으면 job을 실패로 끝낸다'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // 그 밖의 step은 job을 실패시키지 않으려고 오류를 삼키지 않는다
  assert.doesNotMatch(jobs, /continue-on-error/);
});

test('the alert label and the uptime script agree', async () => {
  const script = await readFile(new URL('../deploy/oracle/uptime.py', import.meta.url), 'utf8');
  assert.match(script, /^ALERT_LABEL = "운영 경보"$/m);
  // 열린 경보를 먼저 찾고, 없을 때만 새로 연다
  const notify = script.slice(script.indexOf('def notify('));
  const listed = notify.indexOf('open_alert_numbers(run)');
  const created = notify.indexOf('"issue", "create"');
  const commented = notify.indexOf('"issue", "comment", str(numbers[0])');
  assert.ok(listed >= 0 && listed < commented && commented < created);
  // 기대하는 판은 main의 pages.yml에서 읽는다(sparse checkout도 그 파일을 담는다)
  assert.match(workflow, /sparse-checkout: \|\n {12}deploy\/oracle\/uptime\.py\n {12}\.github\/workflows\/pages\.yml\n/);
});

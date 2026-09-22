import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function checkedSha(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    throw new Error(`${label} is not a full Git object id`);
  }
  return normalized;
}

/** Only the workflow for the authoritative current main revision may publish. */
export function isCurrentPagesHead(candidateSha, headSha) {
  return checkedSha(candidateSha, 'candidate SHA') === checkedSha(headSha, 'main HEAD SHA');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [candidateSha, headSha, ...extra] = process.argv.slice(2);
    if (extra.length > 0 || candidateSha === undefined || headSha === undefined) {
      throw new Error('usage: node tools/check-pages-head.mjs CANDIDATE_SHA MAIN_HEAD_SHA');
    }
    if (!isCurrentPagesHead(candidateSha, headSha)) {
      console.error(`::error::Refusing stale Pages deployment: candidate ${candidateSha} is not current main ${headSha}`);
      process.exitCode = 1;
    } else {
      console.log(`pages_revision_gate=passed;sha=${candidateSha}`);
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

// «이 문제 이상해요» 신고 링크 (FR-5.8, 소유자 결정)
//
// 풀이의 문제마다 GitHub 새 이슈 화면(`issues/new?template=…&title=…&body=…`)을 새 창으로 연다.
// 주소는 URLSearchParams 로만 만든다 — 손으로 이어 붙이면 질문 속 `&`·`#`·`+` 가 칸을 가른다.
//
// **개인 정보를 싣지 않는다.** 아래 함수들은 문제만 받는다. 닉네임·플레이어 ID·점수·방 코드·내가 고른 답이
// 들어갈 자리가 처음부터 없다 — 초대 링크에 비밀번호 자리가 없는 것과 같은 방식이다.
//
// **온라인 문제는 번호와 분야뿐이다.** 온라인 은행은 정답을 공개하지 않는 비공개 은행이라
// (deploy/oracle/ONLINE_QUESTION_BANK.md) `onlineQuestionReportUrl` 은 `{ id, category }` 만 받는다.
// 공개 이슈에 질문·보기·정답을 옮기면 그 판의 답이 저장소에 쌓인다. 관리자가 번호로 비공개 은행에서 찾는다.
//
// 이 파일은 DOM 을 모르는 순수 함수가 대부분이고, 링크 요소를 만드는 것은 맨 아래 함수 하나뿐이다
// (불러오는 것만으로는 document 를 건드리지 않는다). 본문의 칸은 `.github/ISSUE_TEMPLATE/question-report.md`
// 와 같다 — 한쪽을 바꾸면 다른 쪽도 고친다.

import {
  CATEGORIES,
  QUESTION_REPORT_TEMPLATE,
  QUESTION_REPORT_URL_MAX_LENGTH,
  REPOSITORY_URL,
} from '../constants.js';
import type { CategoryId } from '../types.js';

/** 공개 은행(data/*.json)의 문제. 로컬 판의 오답 풀이에서 온다 */
export interface LocalQuestionReport {
  id: string;
  category: CategoryId;
  question: string;
  /** 화면에 나온 순서의 보기. JSON 의 순서와 다를 수 있다 */
  choices: readonly string[];
  /** 은행에 저장된 정답 보기의 글 */
  answer: string;
}

/**
 * 온라인(비공개 은행) 문제. **번호와 분야만** 받는다 — 질문·보기·정답이 들어갈 자리가 없다.
 */
export interface OnlineQuestionReport {
  id: string;
  category: CategoryId;
}

/** 링크에 보이는 글자. 접근 가능한 이름도 이 말로 시작한다(보이는 이름과 들리는 이름이 같은 말로 시작해야 음성 입력이 찾는다) */
export const QUESTION_REPORT_TEXT = '이 문제 이상해요';

/** 너무 긴 번호는 자른다. 온라인 번호는 서버가 정하고 길이를 묻지 않으므로 주소 한도를 지키려고 둔다 */
const ID_MAX_LENGTH = 80;

/** 접근 가능한 이름에 넣는 질문 앞부분의 길이(글자) */
const LABEL_QUESTION_LENGTH = 20;

/** 주소가 한도를 넘어 질문·보기를 잘랐을 때 그 자리에 남기는 말 */
export const QUESTION_REPORT_TRIMMED = '…(주소가 길어 여기까지만 담았어요. 문제 번호로 찾아볼게요.)';

/** 온라인 신고 본문의 안내. 무엇을 싣지 않았고 왜인지 말한다 */
export const ONLINE_REPORT_NOTICE =
  '문제 번호만 보내요. 온라인 문제는 정답을 공개하지 않는 은행이라 질문·보기·정답은 싣지 않았어요. 관리자가 번호로 찾아볼게요.';

/** 글자 단위(코드 포인트)로 자른다. 이모지 같은 서로게이트 쌍을 반으로 가르지 않는다 */
function clip(text: string, max: number): string {
  const points = Array.from(text.trim());
  return points.length > max ? `${points.slice(0, max).join('')}…` : points.join('');
}

function categoryLine(category: CategoryId): string {
  const name = CATEGORIES.find(({ id }) => id === category)?.name ?? category;
  return `- 분야: ${name} (${category})`;
}

/** 제목은 번호 하나다. 질문을 넣으면 온라인 문제의 내용이 제목으로 새고, 목록에서 번호로 찾기도 어렵다 */
function reportTitle(id: string): string {
  return `[문제 신고] ${clip(id, ID_MAX_LENGTH)}`;
}

/** 본문 맨 끝의 빈 칸. 신고하는 사람이 채운다 */
function whatIsWrong(publicBank: boolean): string[] {
  return [
    '## 무엇이 이상한가요?',
    '',
    publicBank
      ? '<!-- 예: 정답이 틀렸어요 · 정답이 둘 이상이에요 · 해설이 사실과 달라요 · 맞춤법. 근거(출처 링크)가 있으면 함께 적어 주세요. -->'
      : '<!-- 온라인 문제의 질문·보기·정답은 옮겨 적지 말고 무엇이 이상한지만 적어 주세요. -->',
    '',
  ];
}

function issueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ template: QUESTION_REPORT_TEMPLATE, title, body });
  return `${REPOSITORY_URL}/issues/new?${params.toString()}`;
}

/**
 * 머리(번호·분야) + 가운데(질문·보기·정답) + 꼬리(«무엇이 이상한가요?») 로 주소를 만든다.
 * 한도를 넘으면 **가운데만** 앞에서부터 남길 수 있는 만큼 남긴다 — 번호와 빈 칸은 언제나 남는다.
 * 남기는 글자 수가 늘면 주소도 늘기만 하므로(인코딩은 글자마다 한 자 이상) 이분 탐색으로 찾는다.
 */
function fittedUrl(title: string, head: string[], middle: string, tail: string[]): string {
  const build = (text: string): string => issueUrl(title, [...head, text, ...tail].join('\n'));
  const full = build(middle);
  if (full.length <= QUESTION_REPORT_URL_MAX_LENGTH) return full;

  const points = Array.from(middle);
  const keep = (count: number): string => build(`${points.slice(0, count).join('')}\n${QUESTION_REPORT_TRIMMED}`);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (keep(mid).length <= QUESTION_REPORT_URL_MAX_LENGTH) low = mid;
    else high = mid - 1;
  }
  return keep(low);
}

/** 로컬(공개 은행) 문제의 신고 주소. 공개 `data/` 의 문제라 질문·보기·저장된 정답까지 싣는다 */
export function localQuestionReportUrl({ id, category, question, choices, answer }: LocalQuestionReport): string {
  const head = [
    '<!-- 게임 풀이의 «이 문제 이상해요»에서 열었어요. 이슈는 누구나 볼 수 있으니 개인 정보는 적지 말아 주세요. -->',
    '## 어떤 문제인가요?',
    '',
    `- 문제 번호: ${clip(id, ID_MAX_LENGTH)}`,
    categoryLine(category),
    `- 문제 은행: 공개 (data/${category}.json)`,
    '',
  ];
  const middle = [
    '### 질문',
    '',
    question.trim(),
    '',
    '### 보기 (화면에 나온 순서)',
    '',
    ...choices.map((choice) => `- ${choice.trim()}`),
    '',
    '### 저장된 정답',
    '',
    answer.trim(),
  ].join('\n');
  return fittedUrl(reportTitle(id), head, middle, ['', ...whatIsWrong(true)]);
}

/**
 * 온라인(비공개 은행) 문제의 신고 주소. **번호와 분야뿐이다** — 받는 값에 질문·보기·정답이 없고,
 * 본문이 «문제 번호만 보내요»라고 말한다. 관리자는 번호로 비공개 은행에서 찾는다.
 */
export function onlineQuestionReportUrl({ id, category }: OnlineQuestionReport): string {
  const head = [
    '<!-- 게임 «문제 다시 보기»의 «이 문제 이상해요»에서 열었어요. 이슈는 누구나 볼 수 있으니 개인 정보는 적지 말아 주세요. -->',
    '## 어떤 문제인가요?',
    '',
    `- 문제 번호: ${clip(id, ID_MAX_LENGTH)}`,
    categoryLine(category),
    '- 문제 은행: 온라인 (비공개)',
    '',
  ];
  return fittedUrl(reportTitle(id), head, ONLINE_REPORT_NOTICE, ['', ...whatIsWrong(false)]);
}

/**
 * 링크의 접근 가능한 이름. 보이는 글자로 시작해 무엇에 대한 신고인지와 «GitHub에서 새 창»을 함께 말한다 —
 * 풀이 목록에서 Tab 으로 다니면 «이 문제 이상해요»만 여러 번 들려 어느 문제인지 알 수 없다.
 * @param subject «「질문 앞부분」» 이나 «3번 문제» 처럼 어느 문제인지
 */
export function questionReportLabel(subject: string): string {
  return `${QUESTION_REPORT_TEXT} · ${subject} 신고하기 — GitHub에서 새 창`;
}

/** 로컬 풀이의 이름에 쓰는 «「질문 앞부분」». 로컬 풀이에는 문항 번호가 보이지 않아 질문으로 가리킨다 */
export function questionReportSubject(question: string): string {
  return `「${clip(question, LABEL_QUESTION_LENGTH)}」`;
}

/**
 * 풀이 끝에 붙는 한 줄(`p.review__report`)과 그 안의 링크. 새 창으로 열고(`target="_blank"`),
 * 연 쪽 페이지를 건드리지 못하게 하며 어디서 왔는지도 보내지 않는다(`rel="noopener noreferrer"`).
 * 진짜 `<a href>` 라 워커가 밟고 Enter·선택으로 누를 수 있다(`walker.ts` 의 pickable).
 */
export function createQuestionReportLink(href: string, label: string): HTMLParagraphElement {
  const row = document.createElement('p');
  row.className = 'review__report';
  const link = document.createElement('a');
  link.className = 'review__report-link';
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', label);
  link.textContent = QUESTION_REPORT_TEXT;
  row.append(link);
  return row;
}

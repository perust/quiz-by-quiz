// CSS 계산값 스냅숏 — 두 판의 CSS 가 «어느 요소·어느 환경·어느 속성에서도 같은 값»을 내는지 견준다.
//
//   node tools/css-snapshot.mjs                 지금 CSS 를 HEAD 의 CSS 와 견준다
//   node tools/css-snapshot.mjs --base <ref>    다른 git 판과 견준다 (예: main, HEAD~1)
//   node tools/css-snapshot.mjs --verbose       다른 칸을 모두 보인다
//   node tools/css-snapshot.mjs --no-pairs      두 선택자를 함께 맞는 증인을 빼고 빨리 본다(최종 확인에는 쓰지 않는다)
//   node tools/css-snapshot.mjs --no-engines    구형 엔진 판을 건너뛴다(최종 확인에는 쓰지 않는다)
//
// 규칙을 옮기거나 지우는 정리(U49: 30절을 각 절로 녹이기, 이길 수 없는 선언 지우기)는 화면을 하나도
// 바꾸지 않아야 한다. 테스트는 몇 요소의 몇 속성만 잠그므로, 이 도구가 요소 묶음 × 환경 × 속성을
// 통째로 계산해 하나라도 달라지면 실패한다. 판정은 tests/css-cascade.mjs 그대로다(로드 순서·명시도·
// !important·@media). 거기서 모르는 것(+ ~ 결합자)은 여기서도 보이지 않는다 — 그런 규칙은 손으로 본다.
//
// 구형 엔진 판: 브라우저는 모르는 선택자가 하나라도 든 선택자 목록을 규칙째 버리고, 모르는 속성·값의 선언은
// 그 선언만 버린다. css-cascade 는 선택자를 하나씩 맞춰 보고 모든 선언을 읽으므로 이것을 모른다 — 그래서
// «늘 진다»던 선언이 사실은 이긴 규칙이 버려지는 엔진의 대체값일 수 있고(:has() 목록에 덮이던 앱 바의 흐름 배치,
// padding-block 에 덮이던 랭킹 안내의 padding), 같은 명시도의 두 규칙 순서를 바꾼 것이 그 엔진에서만 드러날 수
// 있다(:focus-visible 목록이 버려지는 엔진의 홈 dock 칸 올라섬 바탕). 그래서 FEATURES 의 기능 하나씩, 그리고
// ENGINES 의 실제 엔진 묶음마다 두 판에서 그 엔진이 모르는 것을 똑같이 지우고 다시 견준다. 지운 규칙에 맞는
// 요소만 다시 계산한다(나머지는 기본 판과 같다). CSS 에 새 문법을 쓰면 FEATURES 에 한 줄 더한다.
// 이 판이 보지 못하는 것: :is()·:where() 의 너그러운 목록 안에서만 쓰인 새 선택자(만나면 멈춘다), var() 가
// 계산값 시점에 무효가 되는 것(선언이 버려지지 않고 unset 이 된다), FEATURES 에 없는 문법.
//
// 요소 묶음
//   - index.html 의 모든 요소(nodeFromHtml 과 같은 조상 사슬). 숨김을 푼 판도 함께
//   - 그 요소들에 상태를 얹은 판: 선택자마다 오른쪽 끝 칸이 요구하는 상태(:hover·:focus-visible·:disabled…,
//     is-*·BEM 수식어 클래스, TS 가 바꾸는 속성, :has(), 의사 요소)를 더해 그 선택자가 맞게 만든다
//   - 선택자마다 그것만 맞는 가장 작은 증인 사슬
//   - src/ 가 만드는 클래스 묶음(className = '…')과 tests/*.test.mjs 의 node() 서술
//   - 오른쪽 끝 칸이 같은 클래스를 갖는 두 선택자를 함께 맞는 증인 — 캐스케이드 순서가 갈리는 자리다
// 환경: 폭·높이 격자 × pointer·hover 네 가지 × 움직임 줄이기 × 강제 색상. 격자는 두 판의 @media 에서 읽은
//   모든 폭·높이 중단점과 그 ±1px(경계 양쪽)에 흔한 기기 크기를 더한 것이다 — 중단점을 더하면 저절로 따라온다.
//   모든 구간의 네 모서리가 들어가므로 orientation 도 가능한 쪽을 모두 본다. @media 결과가 같은 환경은 한 칸으로 센다.
// 속성: 어느 규칙이든 정하는 모든 속성을 단축 속성까지 풀어 낱 속성으로 본다(background 가 background-color
//   를, padding-inline-start 가 padding-left 를 덮는다). 이긴 선언의 이름과 원문 값을 견준다(공백만 모은다).
//   토큰은 :root 요소의 사용자 속성으로 함께 견주므로 var() 를 풀지 않아도 같다.
//
// 알아 둘 것
//   - 증인 사슬은 실제 화면에 없는 조합일 수 있다(앱 바 안의 캐릭터 같은). 그래도 같아야 통과한다 — 그런
//     규칙은 옮기지 않고 남겨 두는 편을 고른다. 다른 칸마다 요소의 출처([html] [pair] …)를 함께 보인다
//   - 초기값은 모른다. `grid-column: auto` 처럼 초기값과 같은 선언을 지워도 «다름»으로 센다
//   - 계산이 css-cascade 의 valueOf 와 같은지 실행마다 표본 수천 건을 대조한다(어긋나면 실패)
//   - css-cascade 가 건너뛰는 @keyframes·@font-face 는 이름마다 본문 글을 견준다(같은 이름이 둘이면 뒤의 것이 이긴다)
//   - 기준 판의 CSS 는 node_modules/.cache/css-snapshot/ 에 풀어 둔다. 한 번에 2–3분 걸린다

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadStyles, node, nodeFromHtml, selectorMatches, specificity, tokens, valueOf,
} from '../tests/css-cascade.mjs';

const ROOT = new URL('..', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
export const CSS_FILES = ['css/style.css', 'css/voxel-theme.css'];

// ── 단축 속성 → 낱 속성 ───────────────────────────────────────────
// 같은 낱 속성을 정하는 선언끼리만 다툰다. 논리 속성은 가로쓰기 LTR 의 물리 속성과 한 무리다.
const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const side = (prefix, suffix = '') => SIDES.map((s) => `${prefix}-${s}${suffix}`);
const MASK = ['mask-image', 'mask-position', 'mask-size', 'mask-repeat', 'mask-origin', 'mask-clip', 'mask-composite', 'mask-mode'];
const LONGHANDS = {
  background: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
    'background-attachment', 'background-origin', 'background-clip'],
  border: [...side('border', '-width'), ...side('border', '-style'), ...side('border', '-color'), 'border-image'],
  'border-color': side('border', '-color'),
  'border-style': side('border', '-style'),
  'border-width': side('border', '-width'),
  ...Object.fromEntries(SIDES.map((s) => [`border-${s}`, [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]])),
  'border-radius': CORNERS.map((c) => `border-${c}-radius`),
  padding: side('padding'),
  'padding-block': ['padding-top', 'padding-bottom'],
  'padding-inline': ['padding-left', 'padding-right'],
  'padding-block-start': ['padding-top'],
  'padding-block-end': ['padding-bottom'],
  'padding-inline-start': ['padding-left'],
  'padding-inline-end': ['padding-right'],
  margin: side('margin'),
  'margin-block': ['margin-top', 'margin-bottom'],
  'margin-inline': ['margin-left', 'margin-right'],
  'margin-block-start': ['margin-top'],
  'margin-block-end': ['margin-bottom'],
  'margin-inline-start': ['margin-left'],
  'margin-inline-end': ['margin-right'],
  inset: [...SIDES],
  'inset-inline': ['left', 'right'],
  'inset-block': ['top', 'bottom'],
  gap: ['row-gap', 'column-gap'],
  'grid-gap': ['row-gap', 'column-gap'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  font: ['font-style', 'font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures', 'font-variant-east-asian',
    'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family'],
  'font-variant': ['font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures', 'font-variant-east-asian'],
  outline: ['outline-color', 'outline-style', 'outline-width'],
  overflow: ['overflow-x', 'overflow-y'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay',
    'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'],
  mask: MASK,
  '-webkit-mask': MASK,
  '-webkit-mask-image': ['mask-image'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'],
  '-webkit-user-select': ['user-select'],
  '-webkit-appearance': ['appearance'],
};

/** 이 선언이 정하는 낱 속성들. 모르는 이름(사용자 속성 포함)은 제 이름 하나다 */
export function longhandsOf(property) {
  return LONGHANDS[property] ?? [property];
}

// ── 선택자 읽기 (증인 만들기용; 판정은 언제나 css-cascade 의 selectorMatches) ──
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0 && char === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const COMPOUND = /(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~|^$*]?=)(?:'([^']*)'|"([^"]*)"|([^\]\s]*))(?:\s+i)?)?\]|::([\w-]+)|:([\w-]+)(\((?:[^()]|\([^()]*\))*\))?/g;

function parseCompound(text) {
  const parts = [];
  let consumed = 0;
  for (const match of text.matchAll(COMPOUND)) {
    if (match.index !== consumed) return null;
    consumed = match.index + match[0].length;
    if (match[1]) parts.push({ type: 'tag', name: match[1].toLowerCase() });
    else if (match[2]) parts.push({ type: 'id', name: match[2] });
    else if (match[3]) parts.push({ type: 'class', name: match[3] });
    else if (match[4]) parts.push({ type: 'attr', name: match[4], op: match[5], value: match[6] ?? match[7] ?? match[8] });
    else if (match[9]) parts.push({ type: 'pseudo-element', name: match[9] });
    else if (match[10]) parts.push({ type: 'pseudo', name: match[10], arg: match[11]?.slice(1, -1) });
  }
  return consumed === text.length ? parts : null;
}

const parsedCache = new Map();
function parseComplex(selector) {
  if (parsedCache.has(selector)) return parsedCache.get(selector);
  const tokens_ = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(char)) {
      if (current) tokens_.push(current);
      current = '';
      let combinator = ' ';
      while (i < selector.length && /[\s>+~]/.test(selector[i])) {
        if (!/\s/.test(selector[i])) combinator = selector[i];
        i += 1;
      }
      i -= 1;
      if (tokens_.length) tokens_.push(combinator);
      continue;
    }
    current += char;
  }
  if (current) tokens_.push(current);
  let compounds = [];
  for (let i = 0; i < tokens_.length; i += 2) {
    const parts = parseCompound(tokens_[i]);
    if (!parts) {
      compounds = null;
      break;
    }
    compounds.push({ parts, combinator: tokens_[i - 1] ?? null });
  }
  parsedCache.set(selector, compounds);
  return compounds;
}

/** 오른쪽 끝 칸이 괄호 밖에서 요구하는 것 — 빠른 거르기와 같은 무리 찾기에 쓴다 */
function rightmostNeed(selector) {
  const compounds = parseComplex(selector.trim());
  const need = { tag: null, id: null, classes: [], attrs: [], states: [], has: [], pseudo: null, unsupported: !compounds };
  if (!compounds) return need;
  if (compounds.some((c) => c.combinator === '+' || c.combinator === '~')) need.unsupported = true;
  for (const part of compounds.at(-1).parts) {
    if (part.type === 'tag' && part.name !== '*') need.tag = part.name;
    else if (part.type === 'id') need.id = part.name;
    else if (part.type === 'class') need.classes.push(part.name);
    else if (part.type === 'attr' && (!part.op || part.op === '=')) need.attrs.push(part);
    else if (part.type === 'pseudo-element') need.pseudo = part.name;
    else if (part.type === 'pseudo' && part.name === 'has') need.has.push(part.arg.trim());
    else if (part.type === 'pseudo' && !['not', 'is', 'where'].includes(part.name)) {
      need.states.push(part.arg === undefined ? part.name : `${part.name}(${part.arg})`);
    }
  }
  return need;
}

/** need 가 요소의 오른쪽 끝 칸에서 이미 어긋나는가 — 어긋나면 selectorMatches 를 부를 필요가 없다 */
function needFails(need, element) {
  if (need.unsupported) return true;
  if (need.pseudo !== (element.pseudo ?? null)) return true;
  if (need.tag && need.tag !== element.tag) return true;
  if (need.id && need.id !== element.id) return true;
  for (const name of need.classes) if (!element.classes.includes(name)) return true;
  for (const attr of need.attrs) {
    if (!(attr.name in element.attrs)) return true;
    if (attr.op === '=' && element.attrs[attr.name] !== attr.value) return true;
  }
  for (const state of need.states) if (!element.states.includes(state)) return true;
  for (const arg of need.has) if (!element.has?.includes(arg)) return true;
  return false;
}

// ── 요소 ─────────────────────────────────────────────────────────
function cloneChain(element) {
  if (!element) return null;
  return {
    tag: element.tag, id: element.id, classes: [...element.classes], attrs: { ...element.attrs },
    states: [...element.states], pseudo: element.pseudo, has: [...(element.has ?? [])], parent: cloneChain(element.parent),
  };
}

function bare(tag = '*') {
  return { tag, id: null, classes: [], attrs: {}, states: [], pseudo: null, has: [], parent: null };
}

function nodeKey(element) {
  const attrs = Object.keys(element.attrs).sort().map((name) => `[${name}=${element.attrs[name]}]`).join('');
  const classes = [...new Set(element.classes)].sort().map((name) => `.${name}`).join('');
  const states = [...new Set(element.states)].sort().map((name) => `:${name}`).join('');
  const has = element.has?.length ? `{${[...new Set(element.has)].sort().join('|')}}` : '';
  return `${element.tag}${element.id ? `#${element.id}` : ''}${classes}${attrs}${states}${element.pseudo ? `::${element.pseudo}` : ''}${has}`;
}

export function chainKey(element) {
  const keys = [];
  for (let at = element; at; at = at.parent) keys.push(nodeKey(at));
  return keys.reverse().join(' > ');
}

/** 판정에 쓰이지 않는 속성(aria-label 글 등)은 지워 같은 요소를 한 번만 센다 */
function stripAttrs(element, keep) {
  for (let at = element; at; at = at.parent) {
    for (const name of Object.keys(at.attrs)) if (!keep.has(name)) delete at.attrs[name];
  }
  return element;
}

// ── 증인 만들기: 요소(사슬)에 상태를 더해 선택자가 맞게 한다 ──────────────
// policy 는 무엇을 더할 수 있는지다. REAL 은 실행 중에 실제로 바뀌는 것(상태 클래스·상태 속성·의사 클래스)만,
// ANY 는 무엇이든 — 두 선택자가 함께 맞는 자리를 일부러 만들 때 쓴다.
function applyParts(element, parts, policy, isLeaf) {
  for (const part of parts) {
    switch (part.type) {
      case 'tag':
        if (part.name === '*' || element.tag === part.name) break;
        if (element.tag === '*') element.tag = part.name;
        else return false;
        break;
      case 'id':
        if (element.id === part.name) break;
        if (!element.id && policy.id) element.id = part.name;
        else return false;
        break;
      case 'class':
        if (element.classes.includes(part.name)) break;
        if (policy.cls(part.name, element)) element.classes.push(part.name);
        else return false;
        break;
      case 'attr': {
        if (part.op && part.op !== '=') return false;
        const present = part.name in element.attrs;
        if (present && (!part.op || element.attrs[part.name] === part.value)) break;
        if (!policy.attr(part.name, element, present)) return false;
        element.attrs[part.name] = part.op ? part.value : (present ? element.attrs[part.name] : '');
        break;
      }
      case 'pseudo-element':
        if (!isLeaf || (element.pseudo && element.pseudo !== part.name)) return false;
        element.pseudo = part.name;
        break;
      case 'pseudo': {
        if (part.name === 'not') break;
        if (part.name === 'has') {
          if (!element.has.includes(part.arg.trim())) element.has.push(part.arg.trim());
          break;
        }
        if (part.name === 'is' || part.name === 'where') {
          let done = false;
          for (const alternative of splitTop(part.arg, ',')) {
            const inner = parseComplex(alternative);
            if (!inner || inner.length !== 1) continue;
            const trial = { ...element, classes: [...element.classes], attrs: { ...element.attrs }, states: [...element.states], has: [...element.has] };
            if (applyParts(trial, inner[0].parts, policy, isLeaf)) {
              Object.assign(element, trial);
              done = true;
              break;
            }
          }
          if (!done) return false;
          break;
        }
        const token = part.arg === undefined ? part.name : `${part.name}(${part.arg})`;
        if (!element.states.includes(token)) element.states.push(token);
        break;
      }
      default:
        return false;
    }
  }
  // :not(…) 은 맞지 않게 지운다. 지울 수 없으면(구조 클래스 등) 그 선택자는 이 요소에 맞지 않는다
  for (const part of parts) {
    if (part.type !== 'pseudo' || part.name !== 'not') continue;
    for (const inner of splitTop(part.arg, ',')) {
      const probe = { ...element, pseudo: null };
      if (!selectorMatches(inner, probe)) continue;
      const compounds = parseComplex(inner);
      if (!compounds || compounds.length !== 1) return false;
      for (const innerPart of compounds[0].parts) {
        if (innerPart.type === 'attr' && policy.dropAttr(innerPart.name)) delete element.attrs[innerPart.name];
        else if (innerPart.type === 'class' && policy.cls(innerPart.name, element)) {
          element.classes = element.classes.filter((name) => name !== innerPart.name);
        } else if (innerPart.type === 'pseudo') {
          const token = innerPart.arg === undefined ? innerPart.name : `${innerPart.name}(${innerPart.arg})`;
          element.states = element.states.filter((name) => name !== token);
        }
      }
      if (selectorMatches(inner, { ...element, pseudo: null })) return false;
    }
  }
  return true;
}

function tryApply(element, parts, policy, isLeaf) {
  const trial = { ...element, classes: [...element.classes], attrs: { ...element.attrs }, states: [...element.states], has: [...element.has] };
  if (!applyParts(trial, parts, policy, isLeaf)) return false;
  Object.assign(element, trial);
  return true;
}

/** leaf 사슬을 복사해 selector 가 맞도록 고친다. 안 되면 null. synth 면 모자란 조상을 끼워 넣는다 */
export function augment(leaf, selector, policy, { synth = false } = {}) {
  const compounds = parseComplex(selector.trim());
  if (!compounds || compounds.some((c) => c.combinator === '+' || c.combinator === '~')) return null;
  const copy = cloneChain(leaf);
  if (!tryApply(copy, compounds.at(-1).parts, policy, true)) return null;
  let current = copy;
  for (let index = compounds.length - 2; index >= 0; index -= 1) {
    const { combinator } = compounds[index + 1];
    const { parts } = compounds[index];
    // 만든 사슬에서는 html·body 에 다른 칸의 요구를 얹지 않는다 — body 가 .app-bar 인 요소는 없다
    const frame = (at) => synth && (at.tag === 'html' || at.tag === 'body')
      && !parts.some((part) => part.type === 'tag' || (part.type === 'pseudo' && part.name === 'root'));
    if (combinator === '>') {
      if (current.parent && !frame(current.parent) && tryApply(current.parent, parts, policy, false)) {
        current = current.parent;
        continue;
      }
      if (!synth) return null;
      const inserted = bare();
      if (!applyParts(inserted, parts, ANY, false)) return null;
      inserted.parent = current.parent;
      current.parent = inserted;
      current = inserted;
      continue;
    }
    // 자손 결합자: 이미 맞는 조상을 먼저, 없으면 가장 가까운 고칠 수 있는 조상, 그래도 없으면 끼워 넣는다
    let found = null;
    for (let at = current.parent; at && !found; at = at.parent) {
      if (tryApply(at, parts, NONE, false)) found = at;
    }
    for (let at = current.parent; at && !found; at = at.parent) {
      if (!frame(at) && tryApply(at, parts, policy, false)) found = at;
    }
    if (!found) {
      if (!synth) return null;
      const inserted = bare();
      if (!applyParts(inserted, parts, ANY, false)) return null;
      inserted.parent = current.parent;
      current.parent = inserted;
      found = inserted;
    }
    current = found;
  }
  return selectorMatches(selector, copy) ? copy : null;
}

const NONE = { id: false, cls: () => false, attr: () => false, dropAttr: () => false };
export const ANY = { id: true, cls: () => true, attr: () => true, dropAttr: () => true };

/**
 * 실행 중에 붙을 수 있는 클래스: is-* 는 어디에나, BEM 수식어(블록--이름)는 그 블록을 가진 요소에만.
 * src 가 붙였다 떼는 수식어(classList)는 언제나, 그 밖의 수식어는 같은 블록의 다른 수식어가 아직 없을 때만
 * (.button 은 .button--primary 일 수 있지만 .button--ghost 가 동시에 .button--primary 이지는 않다)
 */
function realPolicy(stateClasses, stateAttrs) {
  const isState = (name, element) => {
    if (name.startsWith('is-')) return true;
    const at = name.indexOf('--');
    if (at <= 0) return false;
    const block = name.slice(0, at);
    if (!element.classes.includes(block)) return false;
    return stateClasses.has(name) || !element.classes.some((other) => other.startsWith(`${block}--`));
  };
  return {
    id: false,
    cls: isState,
    attr: (name) => stateAttrs.has(name),
    dropAttr: (name) => stateAttrs.has(name),
  };
}

/** html > body > … 증인. 선택자의 칸마다 요소 하나 (body·html 을 요구하는 칸은 그 자리를 쓴다) */
export function witness(selector) {
  const leaf = bare();
  const root = bare('html');
  root.states.push('root');
  const body = bare('body');
  body.parent = root;
  leaf.parent = body;
  return augment(leaf, selector, ANY, { synth: true });
}

// ── 요소 묶음 만들기 ────────────────────────────────────────────────
function htmlElements(html) {
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  const stack = [];
  const chains = [];
  for (const match of clean.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, closing, rawTag, rawAttrs] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.map((item) => item.tag).lastIndexOf(tag);
      if (at !== -1) stack.length = at;
      continue;
    }
    const attrs = {};
    for (const attr of rawAttrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = attr[2] ?? '';
    const item = { tag, attrs };
    let element;
    if (attrs.id && html.includes(`id="${attrs.id}"`)) {
      element = nodeFromHtml(html, attrs.id);
    } else {
      let parent = null;
      for (const ancestor of [...stack, item]) {
        const made = node(ancestor.tag, parent);
        made.id = ancestor.attrs.id ?? null;
        made.classes = (ancestor.attrs.class ?? '').split(/\s+/).filter(Boolean);
        made.attrs = { ...ancestor.attrs };
        parent = made;
      }
      element = parent;
    }
    chains.push(element);
    if (!voids.has(tag) && !rawAttrs.trim().endsWith('/')) stack.push(item);
  }
  for (const chain of chains) {
    for (let at = chain; at; at = at.parent) {
      at.has ??= [];
      delete at.attrs.class;
      delete at.attrs.id;
      if (at.tag === 'html' && !at.states.includes('root')) at.states.push('root');
    }
  }
  return chains;
}

function shown(chain) {
  const copy = cloneChain(chain);
  for (let at = copy; at; at = at.parent) delete at.attrs.hidden;
  return copy;
}

function sourceFiles(directory, pattern) {
  const out = [];
  for (const entry of readdirSync(new URL(directory, ROOT), { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(`${path}/`, pattern));
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

/** src/ 가 만드는 클래스 묶음, 실행 중에 붙였다 떼는 클래스·속성 */
function scanSources() {
  const combos = new Set();
  const stateClasses = new Set();
  const stateAttrs = new Set(['hidden', 'open', 'disabled', 'tabindex', 'contenteditable']);
  for (const path of sourceFiles('src/', /\.ts$/)) {
    const text = readFileSync(new URL(path, ROOT), 'utf8');
    for (const match of text.matchAll(/className\s*=\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
      const names = match[2].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter((name) => /^[a-z][\w-]*[a-z0-9]$/i.test(name));
      if (names.length) combos.add(names.join(' '));
    }
    for (const match of text.matchAll(/classList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g)) {
      for (const literal of match[1].matchAll(/(['"`])([\w-]+)\1/g)) stateClasses.add(literal[2]);
    }
    for (const match of text.matchAll(/(?:set|remove|toggle)Attribute\(\s*(['"`])([\w-]+)\1/g)) stateAttrs.add(match[2]);
    for (const match of text.matchAll(/\.dataset\.([a-zA-Z]+)\s*=(?!=)/g)) {
      stateAttrs.add(`data-${match[1].replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
    }
    for (const match of text.matchAll(/\['(aria-[\w-]+|data-[\w-]+)'\]/g)) stateAttrs.add(match[1]);
  }
  return { combos: [...combos], stateClasses, stateAttrs };
}

/** tests/*.test.mjs 의 node('…', 부모) 서술. 이름으로 이은 부모는 따라가고 모르는 부모는 비운다 */
function testDescriptors(html) {
  const chains = [];
  for (const path of sourceFiles('tests/', /\.test\.mjs$/)) {
    const text = readFileSync(new URL(path, ROOT), 'utf8');
    const named = new Map();
    for (const match of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*nodeFromHtml\(\s*\w+\s*,\s*(['"])([\w-]+)\2\s*\)/g)) {
      try {
        named.set(match[1], () => nodeFromHtml(html, match[3]));
      } catch {
        // 지금 index.html 에 없는 id 는 건너뛴다
      }
    }
    const calls = [...text.matchAll(/(?:(?:const|let)\s+(\w+)\s*=\s*)?node\(\s*(['"`])((?:(?!\2).)*)\2\s*(?:,\s*(\w+))?/g)];
    for (const match of calls) {
      if (match[1] && !match[3].includes('${')) named.set(match[1], { descriptor: match[3], parent: match[4] });
    }
    const resolve = (name, depth = 0) => {
      const entry = named.get(name);
      if (!entry || depth > 12) return null;
      if (typeof entry === 'function') {
        try {
          return entry();
        } catch {
          return null;
        }
      }
      return node(entry.descriptor, entry.parent ? resolve(entry.parent, depth + 1) : null);
    };
    for (const match of calls) {
      if (match[3].includes('${')) continue;
      chains.push(node(match[3], match[4] ? resolve(match[4]) : null));
    }
  }
  for (const chain of chains) for (let at = chain; at; at = at.parent) at.has ??= [];
  return chains;
}

/** 견줄 요소 묶음. 두 판의 선택자를 모두 넣어야 한쪽에만 있는 규칙도 증인을 얻는다 */
export function buildElements(ruleSets, { pairs = true } = {}) {
  const html = readFileSync(new URL('index.html', ROOT), 'utf8');
  const selectors = [...new Set(ruleSets.flatMap((rules) => rules.flatMap((rule) => rule.selectors)))];
  const attrNames = new Set();
  for (const selector of selectors) for (const match of selector.matchAll(/\[([\w-]+)/g)) attrNames.add(match[1]);
  const { combos, stateClasses, stateAttrs } = scanSources();
  const REAL = realPolicy(stateClasses, stateAttrs);
  const out = new Map();
  const kinds = new Map();
  const counts = {};
  const add = (kind, element) => {
    if (!element) return;
    stripAttrs(element, attrNames);
    const key = chainKey(element);
    if (out.has(key)) return;
    out.set(key, element);
    kinds.set(key, kind);
    counts[kind] = (counts[kind] ?? 0) + 1;
  };

  // 선택자마다의 오른쪽 끝 요구 — 클래스가 상태로 더할 수 없는 것이면 그 요소에는 해 볼 필요가 없다
  const needs = new Map(selectors.map((selector) => [selector, rightmostNeed(selector)]));
  const promote = (kind, base) => {
    for (const selector of selectors) {
      const need = needs.get(selector);
      if (need.unsupported) continue;
      if (need.id && base.id !== need.id) continue;
      if (need.tag && base.tag !== '*' && base.tag !== need.tag) continue;
      if (!need.classes.every((name) => base.classes.includes(name) || REAL.cls(name, base))) continue;
      add(kind, augment(base, selector, REAL));
    }
  };

  const pages = htmlElements(html);
  for (const chain of pages) {
    add('html', cloneChain(chain));
    add('html', shown(chain));
  }
  for (const chain of pages) {
    promote('html+state', chain);
    promote('html+state', shown(chain));
  }

  for (const selector of selectors) add('witness', witness(selector));

  const combosAsNodes = combos.map((combo) => {
    const leaf = bare();
    leaf.classes = combo.split(' ');
    const body = bare('body');
    const root = bare('html');
    root.states.push('root');
    body.parent = root;
    leaf.parent = body;
    return leaf;
  });
  for (const leaf of combosAsNodes) {
    add('src', cloneChain(leaf));
    for (const selector of selectors) {
      const need = needs.get(selector);
      if (need.unsupported || (need.id && leaf.id !== need.id)) continue;
      if (!need.classes.every((name) => leaf.classes.includes(name) || REAL.cls(name, leaf))) continue;
      add('src+state', augment(leaf, selector, REAL, { synth: true }));
    }
  }

  for (const chain of testDescriptors(html)) {
    add('tests', cloneChain(chain));
    promote('tests+state', chain);
  }

  if (pairs) {
    // 오른쪽 끝 칸이 같은 클래스(또는 id)를 요구하는 선택자끼리 — 한 요소가 둘 다 맞는 자리
    const groups = new Map();
    for (const selector of selectors) {
      const need = needs.get(selector);
      if (need.unsupported) continue;
      const keys = need.id ? [`#${need.id}`] : need.classes.filter((name) => !name.startsWith('is-'));
      for (const key of keys) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(selector);
      }
    }
    for (const members of groups.values()) {
      const witnesses = members.map((selector) => witness(selector));
      for (let i = 0; i < members.length; i += 1) {
        if (!witnesses[i]) continue;
        for (let j = 0; j < members.length; j += 1) {
          if (i !== j) add('pair', augment(witnesses[i], members[j], ANY, { synth: true }));
        }
      }
    }
    // 오른쪽 끝에 클래스가 없는 선택자(:focus-visible, .is-standing, [data-icon] …)는 무리마다 대표 하나와
    const universal = selectors.filter((selector) => {
      const need = needs.get(selector);
      // 조상 맥락이 붙은 것(.app-bar > *, .home-quests :focus-visible)은 그 맥락의 실제 요소(index.html)로만 본다
      return !need.unsupported && !need.id && need.classes.every((name) => name.startsWith('is-'))
        && parseComplex(selector.trim()).length === 1;
    });
    const representatives = [...groups.values()].map((members) => witness(members[0])).filter(Boolean);
    for (const representative of representatives) {
      for (const selector of universal) add('pair', augment(representative, selector, ANY, { synth: true }));
    }
  }
  return { elements: out, counts, attrNames, kinds };
}

// ── 환경 ─────────────────────────────────────────────────────────
// 흔한 기기 크기(세로·가로)와 테스트가 쓰는 크기. 중단점 쪽 값은 breakpoints() 가 @media 에서 읽는다
const DEVICE_WIDTHS = [320, 360, 375, 390, 412, 430, 467, 568, 667, 740, 768, 844, 915, 1024, 1280, 1440];
const DEVICE_HEIGHTS = [320, 360, 375, 390, 412, 568, 640, 664, 700, 768, 812, 844, 900, 932, 1024];
const INPUTS = [
  { pointer: 'coarse', hover: 'none' },
  { pointer: 'fine', hover: 'hover' },
  { pointer: 'coarse', hover: 'hover' },
  { pointer: 'fine', hover: 'none' },
];

/**
 * @media 의 폭·높이 중단점마다 그 값과 ±1px. 경계의 양쪽과 경계 자신(max-width 는 같을 때 맞다)이 모두 든다.
 * px 밖의 단위(em 등)는 이 격자가 모르므로 멈춘다 — 조용히 넘기면 그 중단점의 한쪽을 영영 보지 않는다
 */
export function breakpoints(queries) {
  const widths = new Set(DEVICE_WIDTHS);
  const heights = new Set(DEVICE_HEIGHTS);
  for (const query of queries) {
    for (const match of query.matchAll(/\(\s*(?:min|max)-(width|height)\s*:\s*([^)]*?)\s*\)/g)) {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(match[2]);
      if (!px) throw new Error(`@media ${query}: px 가 아닌 중단점(${match[2]})은 이 도구가 모른다`);
      const value = Number(px[1]);
      for (const near of [value - 1, value, value + 1]) (match[1] === 'width' ? widths : heights).add(near);
    }
  }
  const sorted = (set) => [...set].sort((a, b) => a - b);
  return { widths: sorted(widths), heights: sorted(heights) };
}

export function environments(queries) {
  const { widths, heights } = breakpoints(queries);
  const list = [];
  for (const width of widths) {
    for (const height of heights) {
      for (const input of INPUTS) {
        for (const reducedMotion of [false, true]) {
          for (const forcedColors of [false, true]) list.push({ width, height, ...input, reducedMotion, forcedColors });
        }
      }
    }
  }
  return list;
}

/** @media 문자열이 env 에서 맞는가 — css-cascade 의 판정을 :root 토큰 탐침으로 빌린다 */
export function mediaTruth(query, env) {
  const effective = env.forcedColors ? query.replace(/\(\s*forced-colors\s*:\s*active\s*\)/g, 'all') : query;
  const probe = { selectors: [':root'], declarations: [{ property: '--probe', value: '1', important: false }], media: [effective], order: 0 };
  return tokens([probe], env).has('--probe');
}

// ── 계산 ─────────────────────────────────────────────────────────
export function compile(rules) {
  const buckets = new Map();
  const put = (key, entry) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  };
  rules.forEach((rule, index) => {
    rule.declarations.forEach((declaration) => {
      declaration.longhands ??= longhandsOf(declaration.property);
    });
    for (const selector of rule.selectors) {
      const need = rightmostNeed(selector);
      const entry = { index, selector, need, spec: specificity(selector) };
      if (need.id) put(`#${need.id}`, entry);
      else if (need.classes.length) put(`.${need.classes[0]}`, entry);
      else if (need.tag) put(need.tag, entry);
      else put('*', entry);
    }
  });
  return { rules, buckets };
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** 요소에 맞는 규칙과 그 명시도(규칙마다 맞은 선택자 중 가장 큰 것) */
export function matchRules(compiled, element) {
  const candidates = [
    ...(compiled.buckets.get('*') ?? []),
    ...(element.id ? compiled.buckets.get(`#${element.id}`) ?? [] : []),
    ...(compiled.buckets.get(element.tag) ?? []),
    ...element.classes.flatMap((name) => compiled.buckets.get(`.${name}`) ?? []),
  ];
  const best = new Map();
  for (const entry of candidates) {
    if (needFails(entry.need, element)) continue;
    if (!selectorMatches(entry.selector, element)) continue;
    const previous = best.get(entry.index);
    if (!previous || compare(entry.spec, previous) > 0) best.set(entry.index, entry.spec);
  }
  return [...best].sort((a, b) => a[0] - b[0]).map(([index, spec]) => ({ rule: compiled.rules[index], spec }));
}

function beats(a, b) {
  if (a.important !== b.important) return a.important;
  const bySpec = compare(a.spec, b.spec);
  if (bySpec !== 0) return bySpec > 0;
  return a.order > b.order;
}

const SEPARATOR = '\u0001';

/**
 * 낱 속성마다 이긴 선언. 결과는 «속성=이름:값» 칸을 정렬해 이은 글이다. 값의 공백은 하나로 모은다 —
 * 여러 줄로 나눠 적은 값을 한 줄로 고쳐 적는 것은 계산값을 바꾸지 않는다
 */
export function resolve(matched, mediaOk) {
  const best = new Map();
  for (const { rule, spec } of matched) {
    if (!rule.media.every(mediaOk)) continue;
    rule.declarations.forEach((declaration, position) => {
      const candidate = { declaration, spec, important: declaration.important, order: rule.order * 1000 + position };
      for (const longhand of declaration.longhands) {
        const current = best.get(longhand);
        if (!current || beats(candidate, current)) best.set(longhand, candidate);
      }
    });
  }
  return [...best].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([longhand, { declaration }]) => `${longhand}=${declaration.property}:${declaration.value.replace(/\s+/g, ' ')}`)
    .join(SEPARATOR);
}

function countCells(result) {
  let count = 1;
  for (let at = result.indexOf(SEPARATOR); at !== -1; at = result.indexOf(SEPARATOR, at + 1)) count += 1;
  return count;
}

function cellsOf(result) {
  return new Map(result.split(SEPARATOR).filter(Boolean).map((cell) => {
    const at = cell.indexOf('=');
    return [cell.slice(0, at), cell.slice(at + 1)];
  }));
}

/** 그 판의 CSS 를 풀어 읽는다. 규칙과 원문(at-rule 견주기용)을 함께 돌려준다 */
async function loadAt(ref) {
  const directory = `node_modules/.cache/css-snapshot/${ref.replace(/[^\w.-]/g, '_')}`;
  const sources = [];
  for (const path of CSS_FILES) {
    const target = new URL(`${directory}/${path}`, ROOT);
    mkdirSync(new URL('.', target), { recursive: true });
    const text = execFileSync('git', ['show', `${ref}:${path}`], { cwd: ROOT_PATH, encoding: 'utf8', maxBuffer: 1 << 26 });
    writeFileSync(target, text);
    sources.push(text);
  }
  return { rules: await loadStyles(CSS_FILES.map((path) => `${directory}/${path}`)), sources };
}

function envLabel(env) {
  return `${env.width}×${env.height} ${env.pointer}/${env.hover}${env.reducedMotion ? ' reduce' : ''}${env.forcedColors ? ' forced' : ''}`;
}

/**
 * 두 규칙 묶음을 요소 묶음 × 환경 × 낱 속성에서 견준다.
 * 돌려주는 것: 크기, 다른 칸 목록(요소 · 환경 · 낱 속성 · 전 → 후)
 */
export function snapshotDiff(baseRules, currentRules, { pairs = true, sample = 400, elementSet = null, envQueries = null } = {}) {
  const { elements, counts, kinds } = elementSet ?? buildElements([baseRules, currentRules], { pairs });
  const queries = [...new Set([...baseRules, ...currentRules].flatMap((rule) => rule.media))];
  const envs = environments(envQueries ?? queries);
  const queryIndex = new Map(queries.map((query, index) => [query, index]));
  // 환경을 @media 결과로 묶는다
  const signatures = new Map();
  for (const env of envs) {
    const bits = queries.map((query) => (mediaTruth(query, env) ? 1 : 0));
    const key = bits.join('');
    if (!signatures.has(key)) signatures.set(key, { bits, env, count: 0 });
    signatures.get(key).count += 1;
  }
  const sigList = [...signatures.values()];
  const base = compile(baseRules);
  const current = compile(currentRules);
  const longhands = new Set();
  for (const rule of [...baseRules, ...currentRules]) for (const d of rule.declarations) for (const l of d.longhands) longhands.add(l);
  const shared = new Set();
  for (const rule of currentRules) for (const d of rule.declarations) for (const l of d.longhands) if (l !== d.property) shared.add(l);
  const plain = sigList.filter((sig) => !sig.env.forcedColors);

  // 요소마다 쓰는 @media 묶음이 같으면 환경 → 무리 번호도 같다. 그 표를 나눠 쓴다
  const groupTables = new Map();
  const groupTable = (used) => {
    const key = used.join(',');
    if (!groupTables.has(key)) {
      const table = new Int32Array(sigList.length);
      const seen = new Map();
      sigList.forEach((sig, index) => {
        let code = '';
        for (const query of used) code += sig.bits[query];
        if (!seen.has(code)) seen.set(code, seen.size);
        table[index] = seen.get(code);
      });
      groupTables.set(key, { table, size: seen.size });
    }
    return groupTables.get(key);
  };
  // 맞는 규칙 묶음이 같은 요소는 계산도 같다. 묶음마다 한 번만 풀고, 두 판의 묶음 짝마다 한 번만 견준다
  const evaluations = [new Map(), new Map()];
  const evaluate = (which, compiled, element) => {
    const matched = matchRules(compiled, element);
    const key = matched.map(({ rule, spec }) => `${rule.order}:${spec.join('.')}`).join(',');
    const cache = evaluations[which];
    if (cache.has(key)) return cache.get(key);
    const used = [...new Set(matched.flatMap(({ rule }) => rule.media))].map((query) => queryIndex.get(query)).sort((a, b) => a - b);
    const { table, size } = groupTable(used);
    const results = new Array(size);
    const evaluation = {
      key,
      matched,
      table,
      result(sigIndex) {
        const group = table[sigIndex];
        if (results[group] === undefined) {
          const { bits } = sigList[sigIndex];
          results[group] = resolve(matched, (query) => bits[queryIndex.get(query)] === 1);
        }
        return results[group];
      },
    };
    cache.set(key, evaluation);
    return evaluation;
  };

  const diffs = [];
  const compared = new Map();
  let values = 0;
  let checked = 0;
  let sampleMismatch = 0;
  const sampleEvery = Math.max(1, Math.floor(elements.size / sample));
  let at = 0;
  for (const [key, element] of elements) {
    at += 1;
    const before = evaluate(0, base, element);
    const after = evaluate(1, current, element);
    const pairId = `${before.key}|${after.key}`;
    let outcome = compared.get(pairId);
    if (!outcome) {
      outcome = { values: 0, diffs: [] };
      // 두 판의 무리 번호 짝마다 한 번만 견준다
      const pairsSeen = new Map();
      sigList.forEach((sig, index) => {
        const pairKey = before.table[index] * 65536 + after.table[index];
        const entry = pairsSeen.get(pairKey);
        if (entry) {
          entry.count += sig.count;
          entry.sigs += 1;
        } else pairsSeen.set(pairKey, { index, count: sig.count, sigs: 1 });
      });
      for (const { index, count, sigs } of pairsSeen.values()) {
        const a = before.result(index);
        const b = after.result(index);
        outcome.values += (a ? countCells(a) : 0) * sigs;
        if (a === b) continue;
        const cellsA = cellsOf(a);
        const cellsB = cellsOf(b);
        for (const longhand of new Set([...cellsA.keys(), ...cellsB.keys()])) {
          if (cellsA.get(longhand) !== cellsB.get(longhand)) {
            outcome.diffs.push({ env: envLabel(sigList[index].env), envCount: count, longhand, before: cellsA.get(longhand) ?? null, after: cellsB.get(longhand) ?? null });
          }
        }
      }
      compared.set(pairId, outcome);
    }
    values += outcome.values;
    for (const diff of outcome.diffs) diffs.push({ key, kind: kinds.get(key), ...diff });
    // 이 계산이 css-cascade 의 valueOf 와 같은지 표본으로 확인한다 (다른 이름과 낱 속성을 나누지 않는 속성만)
    if (at % sampleEvery === 0) {
      const sig = plain[at % plain.length];
      const cells = cellsOf(after.result(sigList.indexOf(sig)));
      for (const { rule } of after.matched) {
        for (const declaration of rule.declarations) {
          const { property } = declaration;
          if (declaration.longhands.length !== 1 || declaration.longhands[0] !== property || shared.has(property)) continue;
          if (['background', 'border-color', 'border-style', 'border-bottom', 'padding-bottom', 'margin-bottom'].includes(property)) continue;
          checked += 1;
          const mine = cells.get(property);
          const got = mine === undefined ? null : mine.slice(property.length + 1);
          const expected = valueOf(currentRules, element, property, sig.env);
          if ((expected === null ? null : expected.replace(/\s+/g, ' ')) !== got) sampleMismatch += 1;
        }
      }
    }
  }
  return {
    elements: elements.size, counts, envs: envs.length, signatures: sigList.length, longhands: longhands.size,
    matrix: elements.size * sigList.length * longhands.size, values, diffs, checked, sampleMismatch,
  };
}

// ── 구형 엔진 ─────────────────────────────────────────────────────
// 기능마다 그것을 모르는 엔진과, 그 엔진이 버리는 것. selector 는 선택자 목록째, property·value 는 선언 하나를
// 버린다(둘 다 있으면 둘 다 맞는 선언만). 판은 엔진 이름이 아니라 «무엇을 버리는가»로 짠다
export const FEATURES = {
  has: { label: ':has()', engines: 'Safari ≤15.3 · Chrome ≤104 · Firefox ≤120', selector: /:has\(/ },
  focusVisible: { label: ':focus-visible', engines: 'Safari ≤15.3 · Chrome ≤85 · Firefox ≤84', selector: /:focus-visible/ },
  isWhere: { label: ':is()·:where()', engines: 'Safari ≤13.1 · Chrome ≤87 · Firefox ≤77', selector: /:(?:is|where)\(/ },
  webkitPseudo: { label: '::-webkit- 의사 요소', engines: 'Firefox', selector: /::-webkit-/ },
  logical: {
    label: '논리 속성 묶음(padding-block·margin-inline·inset …)', engines: 'Safari ≤14.0 · Chrome ≤86 · Firefox ≤65',
    property: /^(?:(?:padding|margin)-(?:block|inline)|inset(?:-(?:block|inline)(?:-start|-end)?)?)$/,
  },
  logicalSides: {
    label: '논리 속성 한쪽(padding-inline-start …)', engines: 'Safari ≤12.0 · Chrome ≤86 · Firefox ≤40',
    property: /^(?:padding|margin)-(?:block|inline)-(?:start|end)$/,
  },
  viewportUnits: { label: 'svh·lvh·dvh', engines: 'Safari ≤15.3 · Chrome ≤107 · Firefox ≤100', value: /\d[sld]v(?:h|w|i|b|min|max)(?![\w-])/ },
  aspectRatio: { label: 'aspect-ratio', engines: 'Safari ≤14 · Chrome ≤87 · Firefox ≤88', property: /^aspect-ratio$/ },
  transformProps: { label: 'translate·rotate·scale 속성', engines: 'Safari ≤14.0 · Chrome ≤103 · Firefox ≤71', property: /^(?:translate|rotate|scale)$/ },
  scrollMargin: { label: 'scroll-margin', engines: 'Safari ≤14.0', property: /^scroll-margin/ },
  accentColor: { label: 'accent-color', engines: 'Safari ≤15.3 · Chrome ≤92 · Firefox ≤91', property: /^accent-color$/ },
  overflowAnywhere: { label: 'overflow-wrap: anywhere', engines: 'Safari ≤15.3', property: /^overflow-wrap$/, value: /\banywhere\b/ },
  appearance: { label: '접두사 없는 appearance', engines: 'Safari ≤15.3', property: /^appearance$/ },
  mask: { label: '접두사 없는 mask', engines: 'Safari ≤15.3 · Chrome ≤119', property: /^mask(?:-|$)/ },
  userSelect: { label: '접두사 없는 user-select', engines: 'Safari', property: /^user-select$/ },
  backdropFilter: { label: '접두사 없는 backdrop-filter', engines: 'Safari ≤17', property: /^backdrop-filter$/ },
  scrollBehavior: { label: 'scroll-behavior', engines: 'Safari ≤15.3', property: /^scroll-behavior$/ },
};

// 기능 둘 이상이 함께 빠질 때만 드러나는 순서도 있어 실제 엔진 묶음을 따로 본다
const SAFARI_15_3 = ['has', 'focusVisible', 'viewportUnits', 'accentColor', 'overflowAnywhere', 'appearance', 'mask', 'userSelect',
  'backdropFilter', 'scrollBehavior'];
export const ENGINES = [
  ...Object.entries(FEATURES).map(([key, feature]) => ({ name: `${feature.label} (${feature.engines})`, features: [key] })),
  { name: 'Firefox 115–120 ESR', features: ['has', 'webkitPseudo'] },
  { name: 'Safari 15.0–15.3', features: SAFARI_15_3 },
  { name: 'Safari 14.0', features: [...SAFARI_15_3, 'aspectRatio', 'logical', 'transformProps', 'scrollMargin'] },
  { name: 'Chrome 93–103', features: ['has', 'viewportUnits', 'transformProps', 'mask'] },
];

/** 괄호 짝을 지키며 :is(…)·:where(…) 의 안을 비운다 — 너그러운 목록이라 그 안의 모르는 갈래는 목록을 버리지 않는다 */
function stripForgiving(selector) {
  let out = '';
  for (let i = 0; i < selector.length; i += 1) {
    const head = /^:(?:is|where)\(/.exec(selector.slice(i));
    if (!head) {
      out += selector[i];
      continue;
    }
    let depth = 0;
    let end = i + head[0].length - 1;
    for (; end < selector.length; end += 1) {
      if (selector[end] === '(') depth += 1;
      else if (selector[end] === ')' && --depth === 0) break;
    }
    out += `${head[0]})`;
    i = end;
  }
  return out;
}

/** 이 선택자를 pattern 의 기능을 모르는 엔진이 버리는가. 너그러운 목록 안에서만 쓰였으면 멈춘다(그 갈래만 빠진다) */
export function selectorUses(selector, pattern) {
  if (pattern.test(stripForgiving(selector))) return true;
  if (pattern.test(selector)) {
    throw new Error(`${selector}: :is()·:where() 안에서만 쓰인 새 선택자는 이 도구가 모른다 — 손으로 본다`);
  }
  return false;
}

function declarationUses(declaration, feature) {
  if (!feature.property && !feature.value) return false;
  // 사용자 속성은 아무 값이나 받는다 — 그 값을 쓰는 자리가 계산값 시점에 무효가 될 뿐이다(위 머리말)
  if (declaration.property.startsWith('--')) return false;
  return (!feature.property || feature.property.test(declaration.property)) && (!feature.value || feature.value.test(declaration.value));
}

/**
 * features 를 모르는 엔진이 읽은 규칙들. 바뀐(버려지거나 선언이 빠진) 원래 규칙과 버린 선언의 낱 속성도 함께
 * 돌려준다
 */
export function withoutFeatures(rules, keys) {
  const features = keys.map((key) => FEATURES[key]);
  const selectorPatterns = features.filter((feature) => feature.selector).map((feature) => feature.selector);
  const kept = [];
  const changed = [];
  const longhands = new Set();
  const drop = (declarations) => {
    for (const declaration of declarations) for (const longhand of longhandsOf(declaration.property)) longhands.add(longhand);
  };
  for (const rule of rules) {
    if (rule.selectors.some((selector) => selectorPatterns.some((pattern) => selectorUses(selector, pattern)))) {
      changed.push(rule);
      drop(rule.declarations);
      continue;
    }
    const declarations = rule.declarations.filter((declaration) => !features.some((feature) => declarationUses(declaration, feature)));
    if (declarations.length === rule.declarations.length) {
      kept.push(rule);
      continue;
    }
    changed.push(rule);
    drop(rule.declarations.filter((declaration) => !declarations.includes(declaration)));
    if (declarations.length) kept.push({ ...rule, declarations });
  }
  return { rules: kept, changed, longhands };
}

/**
 * 규칙을 longhands 의 낱 속성만 정하는 것으로 줄인다. 낱 속성마다 이긴 선언은 따로 정해지므로, 버린 선언과
 * 낱 속성이 겹치지 않는 칸은 기본 판과 같다 — 그 칸을 다시 풀지 않는다
 */
function narrowTo(rules, longhands) {
  const out = [];
  for (const rule of rules) {
    const declarations = [];
    for (const declaration of rule.declarations) {
      const own = longhandsOf(declaration.property).filter((longhand) => longhands.has(longhand));
      if (own.length) declarations.push({ ...declaration, longhands: own });
    }
    if (declarations.length) out.push({ ...rule, declarations });
  }
  return out;
}

/**
 * ENGINES 마다 두 판을 그 엔진이 읽은 대로 견준다. 바뀐 규칙에 맞는 요소의, 버린 선언이 정하던 낱 속성만 다시
 * 계산한다 — 맞는 규칙이 하나도 바뀌지 않은 요소와 그 밖의 낱 속성은 기본 판과 결과가 같고, 기본 판의 다름은
 * 기본 판이 이미 말한다
 */
export function engineDiffs(baseRules, currentRules, elementSet, { engines = ENGINES } = {}) {
  const envQueries = [...new Set([...baseRules, ...currentRules].flatMap((rule) => rule.media))];
  return engines.map((engine) => {
    const base = withoutFeatures(baseRules, engine.features);
    const current = withoutFeatures(currentRules, engine.features);
    const longhands = new Set([...base.longhands, ...current.longhands]);
    base.rules = narrowTo(base.rules, longhands);
    current.rules = narrowTo(current.rules, longhands);
    const touched = [compile(base.changed), compile(current.changed)];
    const elements = new Map();
    for (const [key, element] of elementSet.elements) {
      if (touched.some((compiled) => matchRules(compiled, element).length > 0)) elements.set(key, element);
    }
    const counts = {};
    for (const key of elements.keys()) counts[elementSet.kinds.get(key)] = (counts[elementSet.kinds.get(key)] ?? 0) + 1;
    const result = elements.size === 0
      ? { elements: 0, diffs: [], checked: 0, sampleMismatch: 0 }
      : snapshotDiff(base.rules, current.rules, { elementSet: { elements, counts, kinds: elementSet.kinds }, envQueries });
    return { engine, changedRules: base.changed.length + current.changed.length, ...result };
  });
}

// ── css-cascade 가 건너뛰는 at-rule ─────────────────────────────────
/** @keyframes·@font-face 를 이름마다 본문 글(공백을 모은)로. 같은 이름이 둘이면 뒤의 것이 이기므로 둘 다 적는다 */
function atRules(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  for (const match of text.matchAll(/@(keyframes|font-face)\s*([^{]*)\{/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    for (; end < text.length && depth > 0; end += 1) {
      if (text[end] === '{') depth += 1;
      else if (text[end] === '}') depth -= 1;
    }
    const body = text.slice(match.index + match[0].length, end - 1).replace(/\s+/g, ' ').trim();
    // @font-face 는 이름이 본문(font-family)에 있다
    const name = match[1] === 'keyframes' ? match[2].trim() : (/font-family:\s*([^;]+)/.exec(body)?.[1].trim() ?? '');
    const key = `@${match[1]} ${name}`;
    out.set(key, [...(out.get(key) ?? []), body]);
  }
  return out;
}

/** 두 판의 at-rule 이 이름마다 같은가. 다른 것의 이름 목록 */
export function atRuleDiffs(baseSources, currentSources) {
  const before = atRules(baseSources.join('\n'));
  const after = atRules(currentSources.join('\n'));
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => JSON.stringify(before.get(name) ?? []) !== JSON.stringify(after.get(name) ?? [])).sort();
}

function report(result, { verbose }) {
  const kinds = Object.entries(result.counts).map(([kind, count]) => `${kind} ${count}`).join(', ');
  console.log(`요소 ${result.elements}개 (${kinds})`);
  console.log(`환경 ${result.envs}개 → @media 결과가 다른 ${result.signatures}칸`);
  console.log(`낱 속성 ${result.longhands}개 → 행렬 ${result.elements} × ${result.signatures} × ${result.longhands}`
    + ` = ${result.matrix.toLocaleString('en-US')}칸, 그중 값이 정해진 칸 ${result.values.toLocaleString('en-US')}개`);
  console.log(`valueOf 표본 대조 ${result.checked}건, 어긋남 ${result.sampleMismatch}건`);
  if (result.diffs.length === 0) {
    console.log('달라진 계산값 없음');
    return;
  }
  console.log(`달라진 칸 ${result.diffs.length}개`);
  const shown_ = verbose ? result.diffs : result.diffs.slice(0, 40);
  for (const diff of shown_) {
    console.log(`- [${diff.kind}] ${diff.key}\n    ${diff.env} (같은 환경 ${diff.envCount}개) ${diff.longhand}: ${diff.before} → ${diff.after}`);
  }
  if (shown_.length < result.diffs.length) console.log(`… ${result.diffs.length - shown_.length}개 더 (--verbose)`);
}

function reportEngines(results, { verbose }) {
  console.log(`구형 엔진 판 ${results.length}개 (모르는 선택자의 목록·모르는 선언을 두 판에서 똑같이 버린다)`);
  for (const result of results) {
    const head = `- ${result.engine.name}: 바뀐 규칙 ${result.changedRules}개, 다시 계산한 요소 ${result.elements}개`;
    if (result.diffs.length === 0 && result.sampleMismatch === 0) {
      console.log(`${head} — 같음`);
      continue;
    }
    console.log(`${head} — 달라진 칸 ${result.diffs.length}개, valueOf 어긋남 ${result.sampleMismatch}건`);
    const shown_ = verbose ? result.diffs : result.diffs.slice(0, 12);
    for (const diff of shown_) {
      console.log(`    [${diff.kind}] ${diff.key}\n      ${diff.env} ${diff.longhand}: ${diff.before} → ${diff.after}`);
    }
    if (shown_.length < result.diffs.length) console.log(`    … ${result.diffs.length - shown_.length}개 더 (--verbose)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : args[at + 1];
  };
  const ref = option('--base') ?? 'HEAD';
  const verbose = args.includes('--verbose');
  const [base, currentRules] = await Promise.all([loadAt(ref), loadStyles(CSS_FILES)]);
  const elementSet = buildElements([base.rules, currentRules], { pairs: !args.includes('--no-pairs') });
  const result = snapshotDiff(base.rules, currentRules, { elementSet });
  report(result, { verbose });
  let failed = result.diffs.length > 0 || result.sampleMismatch > 0;

  const atDiffs = atRuleDiffs(base.sources, CSS_FILES.map((path) => readFileSync(new URL(path, ROOT), 'utf8')));
  console.log(atDiffs.length === 0 ? '@keyframes·@font-face 같음' : `@keyframes·@font-face 다름: ${atDiffs.join(', ')}`);
  failed ||= atDiffs.length > 0;

  if (!args.includes('--no-engines')) {
    const engines = engineDiffs(base.rules, currentRules, elementSet);
    reportEngines(engines, { verbose });
    failed ||= engines.some((engine) => engine.diffs.length > 0 || engine.sampleMismatch > 0);
  }
  if (failed) process.exitCode = 1;
}

// 브라우저 없이 «이 요소에 실제로 이기는 선언»을 계산하는 작은 도우미.
//
// 화면 상태 회귀는 대개 캐스케이드에서 난다. 복셀 테마의 공통 표면 규칙이 style.css 의
// 상태 수식어(정답·오답·선택됨)와 명시도가 같고 뒤에 로드되어, 정답 보기와 고른 캐릭터가
// 평범한 카드로 보였다. 선택자 문자열만 찾는 테스트는 이런 덮어쓰기를 잡지 못하므로
// 로드 순서·명시도·!important·@media 를 그대로 따져 이긴 값을 돌려준다.
//
// 지원하는 문법은 이 프로젝트 CSS 가 쓰는 만큼이다. 모르는 결합자(+ ~)는 «맞지 않음»으로
// 본다 — 모르는 것을 맞다고 하면 테스트가 거짓으로 통과한다.

import { readFile } from 'node:fs/promises';

/** 요소 하나. parent 를 따라 올라가며 자손 결합자를 판정한다 */
export function node(descriptor, parent = null, { has = [] } = {}) {
  const element = { tag: '*', id: null, classes: [], attrs: {}, states: [], pseudo: null, parent, has };
  const pattern = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:'([^']*)'|"([^"]*)"|([^\]]*)))?\]|::([\w-]+)|:([\w-]+(?:\([^)]*\))?)/g;
  for (const match of descriptor.matchAll(pattern)) {
    if (match[1]) element.tag = match[1].toLowerCase();
    else if (match[2]) element.id = match[2];
    else if (match[3]) element.classes.push(match[3]);
    else if (match[4]) element.attrs[match[4]] = match[5] ?? match[6] ?? match[7] ?? '';
    else if (match[8]) element.pseudo = match[8];
    else if (match[9]) element.states.push(match[9]);
  }
  return element;
}

/** index.html 에서 id 로 요소를 찾아 조상 사슬까지 node 로 만든다 */
export function nodeFromHtml(html, id) {
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
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
    if (attrs.id === id) {
      let parent = null;
      for (const ancestor of [...stack, item]) {
        const element = node(ancestor.tag, parent);
        element.id = ancestor.attrs.id ?? null;
        element.classes = (ancestor.attrs.class ?? '').split(/\s+/).filter(Boolean);
        element.attrs = { ...ancestor.attrs };
        parent = element;
      }
      return parent;
    }
    if (!voids.has(tag) && !rawAttrs.trim().endsWith('/')) stack.push(item);
  }
  throw new Error(`index.html 에 #${id} 가 없다`);
}

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth -= 1;
    } else if (depth === 0 && char === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseBlock(text, media, rules, nextOrder) {
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open === -1) return;
    let depth = 1;
    let close = open + 1;
    while (close < text.length && depth > 0) {
      if (text[close] === '{') depth += 1;
      else if (text[close] === '}') depth -= 1;
      close += 1;
    }
    const prelude = text.slice(index, open).trim();
    const body = text.slice(open + 1, close - 1);
    index = close;

    if (prelude.startsWith('@media')) {
      parseBlock(body, [...media, prelude.slice('@media'.length).trim()], rules, nextOrder);
      continue;
    }
    if (prelude.startsWith('@')) continue; // @font-face, @keyframes

    const declarations = splitTopLevel(body, ';').map((declaration) => {
      const colon = declaration.indexOf(':');
      const property = declaration.slice(0, colon).trim().toLowerCase();
      let value = declaration.slice(colon + 1).trim();
      const important = /!important$/i.test(value);
      if (important) value = value.replace(/\s*!important$/i, '');
      return { property, value, important };
    }).filter((declaration) => declaration.property);

    rules.push({ selectors: splitTopLevel(prelude, ','), declarations, media, order: nextOrder() });
  }
}

/** 파일을 로드 순서대로 읽는다. 뒤에 오는 파일이 같은 명시도에서 이긴다 */
export async function loadStyles(paths) {
  const rules = [];
  let order = 0;
  for (const path of paths) {
    const text = (await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    parseBlock(text, [], rules, () => order++);
  }
  return rules;
}

function mediaMatches(query, env) {
  return splitTopLevel(query, ',').some((alternative) => alternative
    .split(/\s+and\s+/)
    .every((part) => {
      const feature = part.trim().match(/^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/);
      if (!feature) return part.trim() === 'screen' || part.trim() === 'all';
      const [, name, raw] = feature;
      const px = Number.parseFloat(raw);
      switch (name) {
        case 'max-width': return env.width <= px;
        case 'min-width': return env.width >= px;
        case 'max-height': return env.height <= px;
        case 'min-height': return env.height >= px;
        case 'pointer': return env.pointer === raw;
        case 'hover': return env.hover === raw;
        case 'prefers-reduced-motion': return (env.reducedMotion ? 'reduce' : 'no-preference') === raw;
        default: return false;
      }
    }));
}

function parseCompound(text) {
  const parts = [];
  const pattern = /(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~|^$*]?=)(?:'([^']*)'|"([^"]*)"|([^\]\s]*))(?:\s+i)?)?\]|::([\w-]+)|:([\w-]+)(\((?:[^()]|\([^()]*\))*\))?/g;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== consumed) return null; // 모르는 문법
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

function parseComplex(selector) {
  // 결합자 앞뒤 공백을 하나로 모은 뒤 compound 와 결합자를 번갈아 읽는다
  const tokens = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      let combinator = ' ';
      while (i < selector.length && /[\s>+~]/.test(selector[i])) {
        if (selector[i] !== ' ' && selector[i] !== '\n' && selector[i] !== '\t') combinator = selector[i];
        i += 1;
      }
      i -= 1;
      if (tokens.length) tokens.push(combinator);
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  const compounds = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const parts = parseCompound(tokens[i]);
    if (!parts) return null;
    compounds.push({ parts, combinator: tokens[i - 1] ?? null });
  }
  return compounds;
}

function compoundMatches(parts, element) {
  for (const part of parts) {
    switch (part.type) {
      case 'tag':
        if (part.name !== '*' && part.name !== element.tag) return false;
        break;
      case 'id':
        if (element.id !== part.name) return false;
        break;
      case 'class':
        if (!element.classes.includes(part.name)) return false;
        break;
      case 'attr': {
        if (!(part.name in element.attrs)) return false;
        if (part.op === '=' && element.attrs[part.name] !== part.value) return false;
        if (part.op && part.op !== '=') return false;
        break;
      }
      case 'pseudo-element':
        if (element.pseudo !== part.name) return false;
        break;
      case 'pseudo': {
        if (part.name === 'not') {
          if (splitTopLevel(part.arg, ',').some((inner) => selectorMatches(inner, { ...element, pseudo: null }))) return false;
        } else if (part.name === 'has') {
          if (!element.has.includes(part.arg.trim())) return false;
        } else if (part.name === 'is' || part.name === 'where') {
          if (!splitTopLevel(part.arg, ',').some((inner) => selectorMatches(inner, element))) return false;
        } else {
          const token = part.arg === undefined ? part.name : `${part.name}(${part.arg})`;
          if (!element.states.includes(token)) return false;
        }
        break;
      }
      default:
        return false;
    }
  }
  // 의사 요소를 요청했는데 선택자에 없으면 그 요소 자신의 규칙이다 — 맞지 않는다
  if (element.pseudo && !parts.some((part) => part.type === 'pseudo-element')) return false;
  return true;
}

function matchFrom(compounds, index, element) {
  const { parts, combinator } = compounds[index];
  if (!compoundMatches(parts, element)) return false;
  if (index === 0) return true;
  // 조상은 언제나 의사 요소가 아닌 진짜 요소다
  if (combinator === '>') {
    return Boolean(element.parent) && matchFrom(compounds, index - 1, element.parent);
  }
  if (combinator === ' ') {
    for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) {
      if (matchFrom(compounds, index - 1, ancestor)) return true;
    }
    return false;
  }
  return false; // + ~ 는 쓰지 않는다
}

export function selectorMatches(selector, element) {
  const compounds = parseComplex(selector.trim());
  if (!compounds) return false;
  return matchFrom(compounds, compounds.length - 1, element);
}

export function specificity(selector) {
  const compounds = parseComplex(selector.trim()) ?? [];
  const score = [0, 0, 0];
  for (const { parts } of compounds) {
    for (const part of parts) {
      if (part.type === 'id') score[0] += 1;
      else if (part.type === 'class' || part.type === 'attr') score[1] += 1;
      else if (part.type === 'tag' && part.name !== '*') score[2] += 1;
      else if (part.type === 'pseudo-element') score[2] += 1;
      else if (part.type === 'pseudo') {
        if (part.name === 'where') continue;
        if (['not', 'has', 'is'].includes(part.name)) {
          const inner = splitTopLevel(part.arg, ',').map(specificity)
            .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0] ?? [0, 0, 0];
          score[0] += inner[0];
          score[1] += inner[1];
          score[2] += inner[2];
        } else {
          score[1] += 1;
        }
      }
    }
  }
  return score;
}

const FAMILIES = {
  background: ['background', 'background-color'],
  'border-color': ['border', 'border-color'],
  'border-style': ['border', 'border-style'],
  'border-bottom': ['border', 'border-bottom', 'border-bottom-width', 'border-width'],
  'padding-bottom': ['padding', 'padding-bottom'],
  'margin-bottom': ['margin', 'margin-bottom'],
};

/**
 * 요소에 실제로 적용될 선언.
 * 속성 이름에 FAMILIES 가 있으면 단축 속성까지 같은 자리로 놓고 이긴 «원문»을 돌려준다.
 */
export function winning(rules, element, property, env) {
  const names = FAMILIES[property] ?? [property];
  let best = null;
  for (const rule of rules) {
    if (!rule.media.every((query) => mediaMatches(query, env))) continue;
    const matched = rule.selectors.filter((selector) => selectorMatches(selector, element));
    if (matched.length === 0) continue;
    const spec = matched.map(specificity).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
    rule.declarations.forEach((declaration, position) => {
      if (!names.includes(declaration.property)) return;
      const candidate = { ...declaration, spec, order: rule.order * 1000 + position, selector: matched[0] };
      if (!best || beats(candidate, best)) best = candidate;
    });
  }
  return best;
}

function beats(a, b) {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i += 1) {
    if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i];
  }
  return a.order > b.order;
}

/** winning() 의 값만. 아무 규칙도 없으면 null */
export function valueOf(rules, element, property, env) {
  return winning(rules, element, property, env)?.value ?? null;
}

// ── 토큰 ───────────────────────────────────────────────────────────
// 디자인 층은 값을 :root 의 토큰으로만 정한다. 이긴 선언이 `var(--space-4)` 같은 원문이면
// 숫자로 비교할 수 없어, 거꾸로 «NaN === NaN» 처럼 아무것도 검사하지 못한 채 통과할 수 있다.
// 그래서 토큰을 풀고 calc()·max()·min()·env() 까지 계산하는 도우미를 둔다.

/** env 에서 :root 에 선언된 사용자 속성. @media 안의 :root 재정의도 따른다 */
export function tokens(rules, env) {
  const values = new Map();
  const winners = new Map();
  for (const rule of rules) {
    if (!rule.media.every((query) => mediaMatches(query, env))) continue;
    if (!rule.selectors.some((selector) => selector.trim() === ':root')) continue;
    rule.declarations.forEach((declaration, position) => {
      if (!declaration.property.startsWith('--')) return;
      const order = rule.order * 1000 + position;
      const previous = winners.get(declaration.property);
      if (previous === undefined || order > previous) {
        winners.set(declaration.property, order);
        values.set(declaration.property, declaration.value);
      }
    });
  }
  return values;
}

/** var(--x, fallback) 를 토큰 값으로 바꾼다. 없는 토큰은 대체값, 대체값도 없으면 그대로 둔다 */
export function resolveVars(value, map, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 20) throw new Error(`토큰이 순환한다: ${value}`);
  let out = '';
  let index = 0;
  while (index < value.length) {
    const at = value.indexOf('var(', index);
    if (at === -1) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, at);
    let level = 0;
    let end = at + 3;
    for (; end < value.length; end += 1) {
      if (value[end] === '(') level += 1;
      else if (value[end] === ')') {
        level -= 1;
        if (level === 0) break;
      }
    }
    const inner = value.slice(at + 4, end);
    const comma = splitTopLevel(inner, ',');
    const name = comma[0].trim();
    const fallback = comma.length > 1 ? inner.slice(inner.indexOf(',') + 1).trim() : null;
    const replacement = map.has(name) ? map.get(name) : fallback;
    out += replacement === null ? `var(${inner})` : resolveVars(replacement, map, depth + 1);
    index = end + 1;
  }
  return out;
}

/**
 * px 길이 하나를 계산한다. calc·max·min·env(대체값 또는 0)과 사칙연산을 이해한다.
 * 계산할 수 없으면(%, em, 모르는 함수) NaN 이다 — 모르는 것을 0 으로 치면 거짓으로 통과한다.
 */
export function evaluateLength(value) {
  if (value === null || value === undefined) return Number.NaN;
  const source = String(value).trim();
  const tokens_ = [];
  // 숫자(px 또는 단위 없음) · 함수 이름( · 식별자 · 연산자. 부호는 파서가 단항 연산으로 다룬다
  const pattern = /\s*(?:(\d*\.?\d+)([a-z%]*)|([a-z-]+)\(|([a-z][a-z0-9-]*)|([()+\-*/,]))/y;
  let position = 0;
  while (position < source.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match || match[0].length === 0) return Number.NaN;
    position = pattern.lastIndex;
    if (match[1] !== undefined) {
      if (match[2] && match[2] !== 'px') return Number.NaN; // %·em 은 이 도우미가 모른다
      tokens_.push({ type: 'num', value: Number(match[1]) });
    } else if (match[3] !== undefined) tokens_.push({ type: 'fn', value: match[3] });
    else if (match[4] !== undefined) tokens_.push({ type: 'ident', value: match[4] });
    else tokens_.push({ type: 'op', value: match[5] });
  }
  let at = 0;
  const peek = () => tokens_[at];
  const take = () => tokens_[at++];
  function args() {
    const list = [];
    while (peek() && !(peek().type === 'op' && peek().value === ')')) {
      list.push(expression());
      if (peek()?.type === 'op' && peek().value === ',') take();
    }
    take();
    return list;
  }
  function factor() {
    const token = take();
    if (!token) return Number.NaN;
    if (token.type === 'num') return token.value;
    if (token.type === 'op' && token.value === '-') return -factor();
    if (token.type === 'op' && token.value === '(') {
      const inner = expression();
      take();
      return inner;
    }
    if (token.type === 'fn') {
      if (token.value === 'env') {
        // env(이름, 대체값) — 브라우저 밖에서는 안전 영역이 0 이다
        if (peek()?.type !== 'ident') return Number.NaN;
        take();
        let fallback = 0;
        if (peek()?.type === 'op' && peek().value === ',') {
          take();
          fallback = expression();
        }
        take();
        return fallback;
      }
      const values = args();
      if (token.value === 'calc') return values[0];
      if (token.value === 'max') return Math.max(...values);
      if (token.value === 'min') return Math.min(...values);
      return Number.NaN;
    }
    return Number.NaN;
  }
  function term() {
    let value = factor();
    while (peek()?.type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = take().value;
      const right = factor();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  }
  function expression() {
    let value = term();
    while (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = take().value;
      const right = term();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }
  const result = expression();
  return at === tokens_.length ? result : Number.NaN;
}

/** 이긴 선언(또는 원문 값)을 토큰까지 풀어 px 숫자로 */
export function lengthOf(rules, value, env) {
  return evaluateLength(resolveVars(value, tokens(rules, env)));
}

/** 공백으로 나뉜 단축 값을 괄호 깊이를 지켜 나눈다 ('0 calc(a + b)' → ['0', 'calc(a + b)']) */
export function shorthandParts(value) {
  if (!value) return [];
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

export const DESKTOP = { width: 1280, height: 900, pointer: 'fine', hover: 'hover', reducedMotion: false };
export const MOBILE = { width: 390, height: 844, pointer: 'coarse', hover: 'none', reducedMotion: false };
export const NARROW = { width: 320, height: 640, pointer: 'coarse', hover: 'none', reducedMotion: false };

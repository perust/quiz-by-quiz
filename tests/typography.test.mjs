import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DESKTOP, MOBILE, loadStyles, node, resolveVars, tokens, valueOf } from "./css-cascade.mjs";

const rules = await loadStyles(["css/style.css", "css/voxel-theme.css"]);
const text = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const family = /^["\x27]Pretendard Variable["\x27],/;

test("본문과 제목·숫자는 시스템 글꼴보다 self-hosted Pretendard Variable을 먼저 선택한다", () => {
  for (const env of [MOBILE, DESKTOP, { ...MOBILE, width: 320, height: 550 }, { ...MOBILE, width: 480, height: 320 }]) {
    const root = tokens(rules, env);
    for (const token of ["--font-text", "--font-display"]) {
      const resolved = resolveVars(`var(${token})`, root);
      assert.match(resolved, family, `${token}: ${env.width}×${env.height}에서 Pretendard가 실제 첫 후보여야 한다`);
      assert.doesNotMatch(resolved, /NeoDunggeunmo/);
      assert.match(resolved, /system-ui, sans-serif$/);
    }
  }
});

test("공식 가변 글꼴은 로컬 URL·전체 weight 범위·swap으로 연결된다", async () => {
  const theme = await text("css/voxel-theme.css");
  const face = [...theme.matchAll(/@font-face\s*\{([^}]+)\}/g)].find((m) => /Pretendard Variable/.test(m[1]))?.[1];
  assert.ok(face, "Pretendard를 선언만 하지 않고 @font-face로 연결한다");
  assert.match(face, /url\(["\x27]fonts\/PretendardVariable-1.3.9\.woff2["\x27]\)/);
  assert.match(face, /font-weight:\s*45 920\s*;/);
  assert.match(face, /font-style:\s*normal\s*;/);
  assert.match(face, /font-display:\s*swap\s*;/);
  assert.doesNotMatch(face, /local\(|https?:/);
});

test("공식 v1.3.9 원본 bytes와 저작권·OFL 전문을 함께 배포한다", async () => {
  const font = await readFile(new URL("../css/fonts/PretendardVariable-1.3.9.woff2", import.meta.url));
  assert.equal(font.subarray(0, 4).toString(), "wOF2");
  assert.equal(font.length, 2057688);
  assert.equal(createHash("sha256").update(font).digest("hex"), "9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4");
  const license = await readFile(new URL("../css/fonts/PRETENDARD-LICENSE.txt", import.meta.url));
  assert.equal(createHash("sha256").update(license).digest("hex"), "d31ddd9f2bed32fd7e302a205cf2380ba0de6529152d239ef99cfb6f261bfc04");
  assert.match(license.toString(), /Copyright \(c\) 2021, Kil Hyung-jin/);
  assert.match(license.toString(), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(license.toString(), /DISCLAIMER[\s\S]*OTHER DEALINGS IN THE FONT SOFTWARE\./);
});

test("폼과 대화상자·질문·선택지·타이머는 공통 글꼴 상속을 유지한다", () => {
  const body = node("body");
  assert.equal(valueOf(rules, body, "font-family", MOBILE), "var(--font-text)");
  for (const tag of ["button", "input", "select", "textarea"]) {
    assert.equal(valueOf(rules, node(tag, body), "font", MOBILE), "inherit");
  }
  for (const descriptor of ["h1.question", "span.choice__text", "span#timer-text", "p.dialog__body", "span.ranking-item__name"]) {
    const value = valueOf(rules, node(descriptor, body), "font-family", MOBILE);
    assert.ok(value === null || value === "var(--font-text)" || value === "var(--font-display)", `${descriptor}: ${value}`);
  }
});

test("preload와 CSS는 동일한 self-hosted font를 사용하고 외부 CDN을 추가하지 않는다", async () => {
  const html = await text("index.html");
  assert.match(html, /<link\s+rel="preload"\s+href="css\/fonts\/PretendardVariable-1\.3\.9\.woff2"\s+as="font"\s+type="font\/woff2"\s+crossorigin>/);
  const theme = await text("css/voxel-theme.css");
  assert.doesNotMatch(theme, /@import\s+(?:url\()?[^;]*(?:fonts\.google|jsdelivr|unpkg|cdnjs)/);
});

test("키 이름과 부팅 안내 코드도 UA monospace 대신 공통 Pretendard를 쓴다", () => {
  for (const tag of ["kbd", "code", "pre"]) {
    assert.equal(valueOf(rules, node(tag, node("body")), "font-family", MOBILE), "var(--font-text)", tag);
  }
});

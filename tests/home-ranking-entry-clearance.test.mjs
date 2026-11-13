import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {MOBILE,loadStyles,nodeFromHtml,valueOf,lengthOf,node} from "./css-cascade.mjs";
const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
const rules=await loadStyles(["css/style.css","css/voxel-theme.css"]);
test("랭킹은 중앙 스크롤 영역에 남고 영역 끝은 공용 reserve와 캐릭터 공간을 비운다",()=>{
 for(const env of [MOBILE,{...MOBILE,width:320,height:550},{...MOBILE,width:480,height:320}]){
  const hub=nodeFromHtml(html,"home-hub");
  hub.parent.parent.parent.parent.has=[".walk-controls--on"];
  assert.equal(valueOf(rules,hub,"overflow",env),"auto");
  const rank=nodeFromHtml(html,"open-ranking");
  assert.notEqual(valueOf(rules,rank,"position",env),"absolute");
  assert.equal(valueOf(rules,rank.parent,"display",env),"grid");
  const bottom=lengthOf(rules,valueOf(rules,hub,"bottom",env),env);
  assert.ok(bottom>=lengthOf(rules,"var(--walk-controls-reserve)",env)+48+16);
 }
});

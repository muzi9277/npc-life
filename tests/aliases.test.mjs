import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const raw = JSON.parse(fs.readFileSync(new URL("../script/NPCLife-3.5.4.json", import.meta.url), "utf8"));
const src = raw.content;
const start = src.indexOf("/* NL353_ALIAS_START */");
const end = src.indexOf("/* NL353_ALIAS_END */");
assert.ok(start > 0 && end > start);
const context = { console };
vm.createContext(context);
vm.runInContext(src.slice(start, end + "/* NL353_ALIAS_END */".length), context);
const api = context;

test("aliases are trimmed, deduped, and never the formal name or a single character", () => {
  assert.deepEqual([...api.nl353NormalizeAliases("林淑仪", [" 林姐 ", "林姐", "林", "", "林淑仪", "阿姐", "阿姐"])], ["林姐", "阿姐"]);
  assert.deepEqual([...api.nl353NormalizeAliases("Mary", ["mary", "Miss Mary", "M"])], ["Miss Mary"]);
  assert.deepEqual([...api.nl353AliasesFromCard("林淑仪", { 曾用名: "林姐、阿姐", aliases: ["林姐", "老师"] })], ["林姐", "老师", "阿姐"]);
});

test("a rename keeps the old key as an alias", () => {
  const oldCard = { 曾用名: "林姐", aliases: ["阿姐"], 当前在做: "煮茶" };
  const stamped = api.nl353StampAliases("林淑仪", oldCard, { 别名: ["林老师"], 曾用名: "林姐" }, "林姐");
  assert.deepEqual([...stamped].sort(), ["林姐", "阿姐", "林老师"].sort());
  assert.equal([...stamped].includes("林淑仪"), false);
});

test("formal names keep the old containment rule, aliases do not swallow a longer name", () => {
  assert.equal(api.nl353CardMentioned("玛丽莲来了", "玛丽", {}, ["玛丽", "玛丽莲"]), true);
  assert.equal(api.nl353CardMentioned("玛丽莲来了", "张三", { aliases: ["玛丽"] }, ["张三", "玛丽莲"]), false);
  assert.equal(api.nl353CardMentioned("玛丽来了", "张三", { 曾用名: "玛丽" }, ["张三", "玛丽莲"]), true);
  assert.equal(api.nl353CardMentioned("林姐在廊下", "林淑仪", { 曾用名: "林姐" }, ["林淑仪"]), true);
  assert.equal(api.nl353CardMentioned("今天没有人", "林淑仪", {}, ["林淑仪"]), false);
  assert.equal(api.nl353GuardedMention("Annie waved", "Ann", ["Annie"], "oo"), false);
  assert.equal(api.nl353Mention("Annie waved", "Ann", "oo"), false);
  assert.equal(api.nl353Mention("Ann waved", "Ann", "oo"), true);
});

test("trace scoring counts aliases and still counts a formal name with no aliases", () => {
  const onlyFormal = api.nl353TraceNameScore("林淑仪路过", "林淑仪留下脚印", [{ name: "林淑仪", aliases: [] }]);
  assert.equal(onlyFormal, 16);
  const withAlias = api.nl353TraceNameScore("林姐路过", "林姐留下脚印", [{ name: "林淑仪", aliases: ["林姐"] }]);
  assert.equal(withAlias, 16);
  const buried = api.nl353TraceNameScore("玛丽莲路过", "玛丽莲留下脚印", [
    { name: "张三", aliases: ["玛丽"] },
    { name: "玛丽莲", aliases: [] }
  ]);
  assert.equal(buried, 16);
});

test("the bundle wires aliases into the existing matchers", () => {
  assert.match(src, /nl353AliasesFromCard\(t,card\)/);
  assert.match(src, /nl353StampAliases/);
  assert.match(src, /nl353CardMentioned\(C,e,i\.NPC&&i\.NPC\[e\],c\)/);
  assert.match(src, /nl353GuardedMention\(e,n,longer,"oo"\)/);
  assert.match(src, /nl353TraceNameScore\(s,o,t\.npcs\)/);
  assert.match(src, /roster:l/);
  assert.match(src, /别名/);
  assert.equal(raw.id, "923cea18-89d1-47c1-ac88-13555709f9dc");
});

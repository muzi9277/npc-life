import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const scriptUrl = new URL("../script/NPCLife-3.5.4.json", import.meta.url);
const previousUrl = new URL("../script/NPCLife-3.5.3.json", import.meta.url);
const raw = JSON.parse(fs.readFileSync(scriptUrl, "utf8"));
const src = raw.content;

function extractFunction(source, name) {
  const token = `function ${name}(`;
  const start = source.indexOf(token);
  if (start < 0) throw new Error(`missing ${name}`);
  let i = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

const start = src.indexOf("/* NL353_ISOLATION_START */");
const end = src.indexOf("/* NL353_ISOLATION_END */");
assert.ok(start > 0 && end > start, "isolation block markers");
const block = src.slice(start, end + "/* NL353_ISOLATION_END */".length);
const helpers = ["nl353DedupKnows", "nl353NormalizeKnows", "nl353EnsureKnows", "nl353NpcKnows", "nl353Remember", "nl353EventSummary"]
  .map((name) => extractFunction(src, name))
  .join("\n");
const context = { console, globalThis: {} };
vm.createContext(context);
vm.runInContext(`${helpers}\n${block}`, context);

const {
  nl353BuildPacket,
  nl353BuildGatePrompt,
  nl353SelectCharacters,
  nl353MergeUpdateParsed,
  nl353DecideUpdateFallback,
  nl353ComposeBackgroundBlock,
  nl353ComposeParallelBlock,
  nl353AcceptKnowsConfirm,
  nl353WriteKnowsNotes,
  nl353Prescreen,
  nl353Remember,
  nl353SideRow
} = context;

const secret = "暗格密码7781";
const plan = "把密信藏进柜底";
const cards = {
  林青: { 心事: "林青在等一封信", 当前在做: "擦灯", 位置: "廊下" },
  阿芷: { 心事: secret, 藏起来的打算: plan, 当前在做: "写信", 位置: "内室" }
};
const ledger = {
  events: [
    { id: "e1", summary: "甲亲眼看见门口的灯灭了" },
    { id: "e2", summary: `乙的${secret}被翻出来` }
  ],
  rumors: [{ id: "r9", eventId: "e9", content: "全镇都在传不该进这个包的传闻" }],
  activities: [{ id: "a1", summary: "不该出现的活动总表" }],
  queue: [{ id: "q1", planText: "不该出现的队列" }],
  knows: {
    林青: [{ eventId: "e1", via: "witness" }],
    阿芷: [{ eventId: "e2", via: "witness" }]
  }
};

test("keeps the published script id and a distinct 3.5.4 name", () => {
  assert.equal(raw.id, "923cea18-89d1-47c1-ac88-13555709f9dc");
  assert.equal(raw.name, "NPC Life 3.5.4");
  assert.match(src, /Ci="3\.5\.4"/);
  assert.match(src, /isolatedNpcCalls:!0/);
  assert.match(src, /runOne:\(name,messages,card\)=>Jr\(/);
  assert.equal(fs.readFileSync(previousUrl, "utf8").includes("NPC Life 3.5.3"), true);
});

test("an off-stage packet has only that character's profile and knows", () => {
  const packet = context.nl353BuildPacket({
    name: "阿芷",
    cards,
    roster: ["林青", "阿芷"],
    ledger,
    recentText: "玩家: 甲，把青鸟口令留在廊下。",
    task: "update"
  });
  assert.equal(packet.inScene, false);
  assert.equal(packet.blocked, false);
  assert.match(packet.prompt, /写信/);
  assert.match(packet.prompt, new RegExp(secret));
  assert.match(packet.prompt, /e2/);
  assert.doesNotMatch(packet.prompt, /青鸟口令/);
  assert.doesNotMatch(packet.prompt, /林青在等一封信/);
  assert.doesNotMatch(packet.prompt, /门口的灯灭了/);
  assert.doesNotMatch(packet.prompt, /不该出现的活动总表/);
  assert.doesNotMatch(packet.prompt, /不该出现的队列/);
  assert.doesNotMatch(packet.prompt, /全镇都在传/);
  assert.doesNotMatch(packet.prompt, /"activities":/);
  assert.doesNotMatch(packet.prompt, /"rumors":/);
  assert.doesNotMatch(packet.prompt, /"queue":/);
  assert.doesNotMatch(packet.prompt, /"knows":/);
  assert.doesNotMatch(packet.prompt, /"adjacencies":/);
});

test("an in-scene packet can include the witnessed lines and not the other archive", () => {
  const packet = nl353BuildPacket({
    name: "林青",
    cards,
    roster: ["林青", "阿芷"],
    ledger,
    recentText: "旁白: 林青听见廊下有人喊了一声开饭。",
    task: "side"
  });
  assert.equal(packet.inScene, true);
  assert.equal(packet.blocked, false);
  assert.match(packet.prompt, /林青在等一封信/);
  assert.match(packet.prompt, /门口的灯灭了/);
  assert.match(packet.prompt, /开饭/);
  assert.doesNotMatch(packet.prompt, new RegExp(secret));
  assert.doesNotMatch(packet.prompt, new RegExp(plan));
  assert.doesNotMatch(packet.prompt, /乙的暗格/);
});

test("the prescreen prompt lists names and recent lines, not private cards", async () => {
  let seen = "";
  const screen = await nl353Prescreen({
    bifa: { 名单: ["林青", "阿芷"], NPC: cards },
    chatMessages: [{ role: "user", content: "林青，过来。" }],
    ask: async (prompt) => {
      seen = prompt;
      return { characters: ["林青"] };
    }
  });
  assert.match(seen, /林青/);
  assert.match(seen, /过来/);
  assert.doesNotMatch(seen, new RegExp(secret));
  assert.doesNotMatch(seen, /林青在等一封信/);
  assert.doesNotMatch(seen, /写信/);
  assert.deepEqual([...screen.selected], ["林青", "阿芷"]);
  const offstage = nl353BuildPacket({
    name: "阿芷",
    cards: screen.cards,
    roster: screen.names,
    ledger,
    recentText: screen.recentText,
    task: "side"
  });
  assert.equal(offstage.inScene, false);
  assert.doesNotMatch(offstage.prompt, /过来/);
});

test("selection trusts a real gate list, keeps off-stage beats, and caps the list", () => {
  assert.deepEqual([...nl353SelectCharacters({
    roster: ["林青", "阿芷", "丙三", "丁四"],
    gateNames: ["林青", "路人"],
    inScene: ["林青", "阿芷"],
    offstage: ["丙三"]
  })], ["林青", "丙三"]);
  assert.deepEqual([...nl353SelectCharacters({
    roster: ["林青", "阿芷", "丙三"],
    gateNames: null,
    inScene: ["阿芷"],
    offstage: ["丙三"]
  })], ["阿芷", "丙三"]);
  const many = ["一一", "二二", "三三", "四四", "五五", "六六", "七七", "八八"];
  assert.equal(nl353SelectCharacters({ roster: many, gateNames: many, inScene: [], offstage: [] }).length, 6);
});

test("a bad gate answer falls back to local presence instead of an empty list", async () => {
  const screen = await nl353Prescreen({
    bifa: { 名单: ["林青", "阿芷"], NPC: cards },
    chatMessages: [{ role: "assistant", content: "林青还在廊下。" }],
    ask: async () => "不是 JSON"
  });
  assert.equal(screen.gateNames, null);
  assert.deepEqual([...screen.selected], ["林青", "阿芷"]);
});

test("merged updates drop any other character the model tried to write", () => {
  const merged = nl353MergeUpdateParsed([
    { name: "林青", inScene: true, parsed: { 剧情时间: "0137-06-12 07:00", 林青: { 当前在做: "擦灯" }, 阿芷: { 心事: secret } } }
  ]);
  assert.equal(merged["林青"].当前在做, "擦灯");
  assert.equal(merged["阿芷"], undefined);
  assert.equal(merged["剧情时间"], "0137-06-12 07:00");
});

test("knows confirms cannot add foreign events or replace witness with rumor", () => {
  const book = { knows: { 林青: [{ eventId: "e1", via: "witness" }] } };
  const row = nl353SideRow("林青", {
    character: "林青",
    confirm: [{ eventId: "e2", via: "witness" }, { eventId: "e1", via: "rumor" }]
  }, { allowedIds: ["e1"], records: book.knows["林青"], inScene: true });
  assert.deepEqual([...row.confirm.map((item) => item.eventId)], ["e1"]);
  assert.equal(row.confirm[0].via, "witness");
  assert.deepEqual([...nl353AcceptKnowsConfirm(book, [{ name: "林青", eventId: "e2", via: "witness", allowedIds: ["e1"] }])], []);
  assert.equal(book.knows["林青"].some((rec) => rec.eventId === "e2"), false);
  assert.equal(nl353Remember(book, "林青", { eventId: "e1", via: "rumor" }), false);
  assert.equal(book.knows["林青"].some((rec) => rec.eventId === "e1" && rec.via === "witness"), true);
  nl353WriteKnowsNotes(book, [{ name: "林青", knowsNote: "灯大概是自己灭的" }]);
  assert.equal(book.knowsNote["林青"], "灯大概是自己灭的");
  assert.equal(book.knows["阿芷"], undefined);
});

test("fallback stays explicit", () => {
  assert.equal(nl353DecideUpdateFallback({ enabled: false }), "combined");
  assert.equal(nl353DecideUpdateFallback({ enabled: true, roster: 0, autoTrack: true }), "combined");
  assert.equal(nl353DecideUpdateFallback({ enabled: true, roster: 2, selected: 0, succeeded: 0 }), "skip");
  assert.equal(nl353DecideUpdateFallback({ enabled: true, roster: 2, selected: 2, succeeded: 1 }), "isolated");
  assert.equal(nl353DecideUpdateFallback({ enabled: true, roster: 2, selected: 2, succeeded: 0, timedOut: true }), "skip");
  assert.equal(nl353DecideUpdateFallback({ enabled: true, roster: 2, selected: 2, succeeded: 0, timedOut: false }), "combined");
  assert.equal(nl353DecideUpdateFallback({ aborted: true, enabled: true }), "abort");
});

test("composed blocks are per character and still tagged for the main model", () => {
  const background = nl353ComposeBackgroundBlock([
    { character: "林青", slot: "擦灯", background: "他把灯芯拨正。" }
  ]);
  const parallel = nl353ComposeParallelBlock([
    { character: "林青", inScene: true, parallel: "不该写进在场的人" },
    { character: "阿芷", inScene: false, parallelTitle: "内室", parallel: "她把信纸折好。" }
  ]);
  assert.match(background, /<npc_life_background>/);
  assert.match(background, /林青｜擦灯/);
  assert.match(parallel, /<npc_life_parallel>/);
  assert.match(parallel, /她把信纸折好/);
  assert.doesNotMatch(parallel, /不该写进在场的人/);
});

test("the gate prompt builder itself has no world-layer dump", () => {
  const prompt = nl353BuildGatePrompt(["林青", "阿芷"], ["玩家: 只是一句公开的话"]);
  assert.match(prompt, /<Registered_Characters>/);
  assert.match(prompt, /只是一句公开的话/);
  assert.doesNotMatch(prompt, /"activities":/);
  assert.doesNotMatch(prompt, /心事/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const raw = JSON.parse(fs.readFileSync(new URL("../script/NPCLife-3.5.4.json", import.meta.url), "utf8"));
const src = raw.content;

function slice(from, to) {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`missing ${from} .. ${to}`);
  return src.slice(start, end);
}

const promoteSrc = slice("function nlPromotePlanned", "function nlBuildAdjacency");
const knowsSrc = slice("function nl353EventSummary", "function nl353TagRegexes");
const closingSrc = slice("/* NL353_CLOSING_START */", "function Pi()");
const isolationSrc = slice("/* NL353_ISOLATION_START */", "/* NL353_ISOLATION_END */") + "\n/* NL353_ISOLATION_END */";

const motive = {};
vm.createContext(motive);
vm.runInContext(`${promoteSrc}\n${knowsSrc}\n${closingSrc}`, motive);

const iso = { console, globalThis: {} };
vm.createContext(iso);
vm.runInContext(`${isolationSrc}\n${closingSrc}`, iso);

function plan(extra = {}) {
  return {
    phase: "planned",
    status: "active",
    committed: true,
    createdAtTurn: 2,
    npcIds: ["林青"],
    summary: "去廊下等信",
    ...extra
  };
}

test("the packaged promote function dedups already executed wording", () => {
  assert.equal(src.split("function nlPromotePlanned").length - 1, 1);
  assert.equal(src.split("ti(p,e.host,r,A);nlPromotePlanned(p,l);").length - 1, 1);
  assert.match(promoteSrc, /seen=new Set\(\)/);
  const ledger = {
    activities: [plan()],
    archived: { activities: [{ ...plan(), phase: "doing", promotedAtTurn: 4, status: "active" }] }
  };
  const done = motive.nlPromotePlanned(ledger, 5);
  assert.equal(done.length, 0);
  assert.equal(ledger.activities[0].status, "revoked");
  assert.equal(ledger.activities[0].phase, "planned");
});

test("a reworded plan still promotes, and stale or uncommitted plans do not", () => {
  const ledger = {
    activities: [
      plan({ summary: "改去市集" }),
      plan({ createdAtTurn: 8 }),
      plan({ createdAtTurn: 1 }),
      plan({ committed: false, summary: "另一件未提交的事" })
    ]
  };
  const done = motive.nlPromotePlanned(ledger, 8);
  assert.equal(done.length, 1);
  assert.equal(done[0].summary, "改去市集");
  assert.equal(done[0].phase, "doing");
  assert.equal(done[0].promotedAtTurn, 8);
  assert.equal(ledger.activities[1].phase, "planned");
  assert.equal(ledger.activities[2].phase, "planned");
  assert.equal(ledger.activities[3].phase, "planned");
  assert.equal(ledger.activities[3].status, "active");
});

test("two identical planned items in one pass promote only the first", () => {
  const ledger = { activities: [plan(), plan()] };
  const done = motive.nlPromotePlanned(ledger, 5);
  assert.equal(done.length, 1);
  assert.equal(ledger.activities[0].phase, "doing");
  assert.equal(ledger.activities[1].status, "revoked");
});

test("main-model injection keeps on-scene knows and drops parallel text and off-stage secrets", () => {
  const secret = "暗格密码7781被翻出来";
  const ledger = {
    events: [
      { id: "e1", summary: "门口的灯灭了" },
      { id: "e2", summary: secret }
    ],
    knows: {
      林青: [{ eventId: "e1", via: "witness" }],
      阿芷: [{ eventId: "e2", via: "witness" }]
    }
  };
  const text = motive.nl353BuildKnowsInjection(ledger, {
    states: {
      林青: { name: "林青", locationId: "廊下" },
      阿芷: { name: "阿芷", locationId: "内室" }
    },
    npcs: [
      { id: "林青", name: "林青" },
      { id: "阿芷", name: "阿芷" }
    ],
    playerLocationId: "廊下",
    recentText: "林青站在廊下",
    onSceneOnly: true
  });
  assert.match(text, /林青/);
  assert.match(text, /门口的灯灭了/);
  assert.doesNotMatch(text, /阿芷/);
  assert.doesNotMatch(text, /暗格密码7781/);
  const payload = motive.nl353MainModelPayload({
    world: `${text}\n<npc_life_parallel>阿芷在内室拆开密信。</npc_life_parallel>`,
    background: "林青｜等待中\n他在廊下。"
  });
  assert.equal(payload.parallelInjection, "");
  assert.doesNotMatch(payload.injectionText, /npc_life_parallel/);
  assert.doesNotMatch(payload.injectionText, /拆开密信/);
  assert.doesNotMatch(payload.backgroundInjection, /npc_life_parallel/);
  const history = motive.nl353ScrubParallelHistory([
    { mes: "正文<npc_life_parallel>阿芷私下数钱。</npc_life_parallel>", extra: {} }
  ]);
  assert.doesNotMatch(history[0].mes, /npc_life_parallel/);
  assert.doesNotMatch(history[0].mes, /私下数钱/);
  assert.match(history[0].extra.npc_life_parallel, /私下数钱/);
});

test("local prescreen adds at most two off-stage triggers and does not call a model", async () => {
  let asked = false;
  const screen = await iso.nl353Prescreen({
    bifa: { 名单: ["林青", "阿芷", "丙三", "丁四", "戊五"], NPC: {} },
    chatMessages: [{ role: "user", content: "林青，过来。" }],
    turn: 4,
    ledger: {
      events: [
        { id: "a", tick: 4, actorId: "阿芷", summary: "送信" },
        { id: "b", tick: 4, actorId: "丙三", summary: "关门" },
        { id: "c", tick: 4, actorId: "丁四", summary: "点灯" }
      ],
      queue: [{ npcId: "戊五", status: "pending", dueTick: 4, planText: "出发" }]
    },
    ask: async () => {
      asked = true;
      return { characters: ["丁四"] };
    }
  });
  assert.equal(asked, false);
  assert.equal([...screen.selected][0], "林青");
  assert.equal([...screen.selected].filter((name) => name !== "林青").length, 2);
  assert.deepEqual([...screen.selected].slice(1), ["阿芷", "丙三"]);
});

test("isolated character calls overlap instead of waiting in series", async () => {
  iso.setTimeout = setTimeout;
  iso.clearTimeout = clearTimeout;
  let active = 0;
  let max = 0;
  iso.Bn = async (prompt) => {
    active += 1;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    const name = String(prompt).includes("只负责「阿芷」") ? "阿芷" : "林青";
    return { ok: true, value: { character: name, slot: "在", background: "短近况", parallel: "", confirm: [] } };
  };
  const result = await iso.nl353RunIsolatedSide({
    settings: { isolatedNpcCalls: true },
    bifa: { 名单: ["林青", "阿芷"], NPC: { 林青: { 当前在做: "等" }, 阿芷: { 当前在做: "写" } } },
    messages: [{ role: "user", content: "林青和阿芷都在厅里。" }],
    ledger: { knows: {} },
    states: {},
    wantBackground: true,
    wantParallel: false
  });
  assert.equal(result.fallback, false);
  assert.ok(max >= 2);
});

test("card keywords raise trust or hostility to at least 3", () => {
  const ledger = { relations: { 林青: { 主角: { trust: 1, hostility: 0 } } } };
  motive.nlSeedRelationsFromBifa(ledger, {
    名单: ["林青", "阿芷", "路人甲"],
    NPC: {
      林青: { 恋爱对象: "是", 身份锚点: "书院的朋友" },
      阿芷: { 心事: "记恨那个人" },
      路人甲: { 身份锚点: "卖菜" }
    }
  }, "主角");
  assert.equal(ledger.relations["林青"]["主角"].trust, 3);
  assert.equal(ledger.relations["阿芷"]["主角"].hostility, 3);
  assert.equal(ledger.relations["路人甲"], undefined);
  assert.equal(src.includes("hostilityThreshold:1"), true);
  assert.equal(src.includes("hostilityThreshold:3"), false);
});

test("non-daily actions rumor directly and secrets become a vague buzz", () => {
  const fight = motive.nl353EventRumorPlan({ id: "e", type: "conflict", summary: "阿芷和人动了手", secret: false }, []);
  assert.equal(fight.kind, "direct");
  assert.match(fight.content, /动了手/);
  const hidden = motive.nl353EventRumorPlan({ id: "e2", summary: "阿芷私下把密信藏进柜底", secret: true }, ["林青"]);
  assert.equal(hidden.kind, "buzz");
  assert.doesNotMatch(hidden.content, /密信/);
  assert.match(hidden.content, /具体没说清/);
  const daily = motive.nl353EventRumorPlan({ summary: "林青去买菜", type: "daily" }, []);
  assert.equal(daily.kind, "none");
});

test("a close NPC unseen for three turns gets an approach opportunity", () => {
  const ledger = { relations: { 林青: { 主角: { trust: 3, hostility: 0 } } }, seen: { 林青: 1 } };
  const early = motive.nl353ApproachUnseen(ledger, 3, { playerId: "主角", hostilityThreshold: 1, states: { 林青: { name: "林青", locationId: "内室" } }, playerLocationId: "廊下", recentText: "" });
  assert.equal(early.length, 0);
  ledger.seen["林青"] = 1;
  const due = motive.nl353ApproachUnseen(ledger, 4, { playerId: "主角", hostilityThreshold: 1, states: { 林青: { name: "林青", locationId: "内室" } }, playerLocationId: "廊下", recentText: "" });
  assert.equal(due.length, 1);
  assert.equal(due[0].type, "approach");
  assert.equal(due[0].source, "affinity");
  assert.match(due[0].summary, /过来找你/);
  assert.doesNotMatch(due[0].summary, /npc_life_parallel/);
});

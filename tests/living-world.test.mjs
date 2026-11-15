import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createLedger, recordActivity, recordTrace, recordDiscovery, commitLedgerTurn,
    appendSettlementDrafts, draftsFromSettlement, applyStoryDiscoveries, isDiscoveredCanon,
} from '../activity-ledger.js';
import {
    DEFAULT_LIVING_WORLD, normalizeLivingWorldPreferences, tokenize, isPublicWorldState,
    collectWorldBookEntries, applySlidingWindow, formatWorldBook,
    collectSubmittedWorldResults, matchIntentOverlap, formatIntentOverlap,
    encounterEligibility, selectEncounters, formatEncounters, buildLivingWorldInjection,
    locationCompatibility, encounterLocationWeight, effectiveEncounterProbability,
} from '../living-world.js';

function npc(id, name, extra = {}) {
    return { id, name, entityType: 'person', tracked: true, appeared: true, hasProfile: true, description: `${name}是世界卡里已出场的人物，性格沉稳。`, ...extra };
}

function ledgerWith(activities, turnId = 't1', cursor = 3) {
    const ledger = createLedger();
    for (const item of activities) recordActivity(ledger, item);
    commitLedgerTurn(ledger, turnId, cursor);
    return ledger;
}

test('出厂默认窗口与偶遇概率可直接使用，且会夹紧非法值', () => {
    const fresh = normalizeLivingWorldPreferences({});
    assert.equal(fresh.worldBookMaxEntries, 24);
    assert.equal(fresh.worldBookMaxTurns, 8);
    assert.equal(fresh.worldBookBudget, 1600);
    assert.equal(fresh.encounterProbability, 0.08);
    assert.equal(fresh.encounterMaxPerTurn, 1);
    assert.equal(fresh.encounterSameWeight, 1.6);
    assert.equal(fresh.encounterUncertainWeight, 1);
    assert.equal(fresh.encounterMismatchWeight, 0.35);
    assert.equal(fresh.intentOverlapBudget, 700);
    assert.equal(fresh.injectionBudget, 4500);
    assert.equal(DEFAULT_LIVING_WORLD.encounterMaxPerTurn, 1);
    const clamped = normalizeLivingWorldPreferences({
        worldBookMaxEntries: 999, worldBookMaxTurns: 0, encounterProbability: 3, encounterMaxPerTurn: -2,
        encounterSameWeight: 99, encounterMismatchWeight: -1, encounterUncertainWeight: 'nope',
    });
    assert.equal(clamped.worldBookMaxEntries, 80);
    assert.equal(clamped.worldBookMaxTurns, 1);
    assert.equal(clamped.encounterProbability, 1);
    assert.equal(clamped.encounterMaxPerTurn, 0);
    assert.equal(clamped.encounterSameWeight, 8);
    assert.equal(clamped.encounterMismatchWeight, 0);
    assert.equal(clamped.encounterUncertainWeight, 1);
    const empty = normalizeLivingWorldPreferences({ encounterSameWeight: '', encounterMismatchWeight: null });
    assert.equal(empty.encounterSameWeight, 1.6);
    assert.equal(empty.encounterMismatchWeight, 0.35);
});

test('动态世界书按轮数和条数双上限淘汰最旧条目，正在做的当前快照保留', () => {
    const qing = npc('qing', '林青');
    const activities = [];
    for (let turn = 1; turn <= 12; turn++) {
        activities.push({
            id: `act:old:${turn}`, npcIds: ['qing'], phase: 'done',
            summary: `林青完成了第${turn}件旧事`, locationId: 'loc:north',
            turnId: `t${turn}`, createdAtTurn: turn, source: 'settlement',
        });
    }
    activities.push({
        id: 'act:doing', npcIds: ['qing'], phase: 'doing',
        summary: '林青正在巡视北塔', locationId: 'loc:north',
        turnId: 't12', createdAtTurn: 12, source: 'settlement',
    });
    const ledger = ledgerWith(activities, 't12', 12);
    const raw = collectWorldBookEntries({
        ledger, npcs: [qing], states: { qing: { locationId: 'loc:north', activity: '巡视' } },
        currentTurn: 12, locationName: () => '北塔',
    });
    const windowed = applySlidingWindow(raw, { maxEntries: 5, maxTurns: 3, currentTurn: 12 });
    const done = windowed.filter(item => item.phase === 'done');
    const doing = windowed.filter(item => item.phase === 'doing');
    assert.equal(doing.length, 1);
    assert.match(doing[0].summary, /正在巡视北塔/);
    assert.ok(done.length <= 4, '条数上限扣除当前快照后只留最近历史');
    assert.ok(done.every(item => item.createdAtTurn > 12 - 3), '超出轮数窗口的旧条目应被淘汰');
    assert.ok(!done.some(item => /第1件旧事|第8件旧事|第9件旧事/.test(item.summary)));
    assert.ok(done.some(item => /第12件旧事/.test(item.summary)));
});

test('动态世界书把幕后活动写成世界后台状态，而不是玩家已知情报；已确认地点不被旧活动覆盖', () => {
    const qing = npc('qing', '林青');
    const ledger = ledgerWith([
        { id: 'act:secret', npcIds: ['qing'], phase: 'done', summary: '林青在北塔翻找藏书并翻乱了书架', locationId: 'loc:north', turnId: 't1', createdAtTurn: 4, source: 'settlement', publicCanon: false },
        { id: 'act:doing', npcIds: ['qing'], phase: 'doing', summary: '林青正在南门守夜', locationId: 'loc:south', turnId: 't2', createdAtTurn: 5, source: 'settlement', publicCanon: false },
    ], 't2', 5);
    const text = formatWorldBook(applySlidingWindow(collectWorldBookEntries({
        ledger, npcs: [qing],
        states: { qing: { locationId: 'loc:south', activity: '守夜' } },
        currentTurn: 5, locationName: id => id === 'loc:south' ? '南门' : '北塔',
    }), { maxEntries: 24, maxTurns: 8, currentTurn: 5 }));
    assert.match(text, /辅助上下文，不是正史/);
    assert.match(text, /不得覆盖当前正文和已确认状态/);
    assert.match(text, /世界后台状态/);
    assert.match(text, /不是玩家已知情报/);
    assert.match(text, /南门/);
    assert.match(text, /正在守夜|正在做：林青正在南门守夜/);
    assert.doesNotMatch(text, /已经看见|已经知道|玩家已经掌握了未发现/);
    assert.doesNotMatch(text, /玩家已知情报：林青在北塔翻找/);
});

test('意图重合：已提交「桥断了」与途经该桥的意图注入本轮；无关意图不注入；未提交结果不进入', () => {
    const submitted = [{
        id: 'act:bridge', summary: '山道上的石桥断了，无法再从这里过河',
        locationId: 'loc:bridge', locationName: '石桥', npcIds: ['qing'],
        turnId: 't-old', createdAtTurn: 3, publicWorld: true, committed: true,
    }];
    const related = matchIntentOverlap('我要去打败魔王，路上会用到那座桥。', submitted);
    assert.equal(related.length, 1);
    assert.match(related[0].summary, /石桥断了/);
    const overlapText = formatIntentOverlap(related);
    assert.match(overlapText, /与本轮意图重合的世界状态/);
    assert.match(overlapText, /石桥断了/);
    assert.match(overlapText, /已提交的公开世界变化/);

    const unrelated = matchIntentOverlap('我在客栈安静吃饭，不想出门。', submitted);
    assert.equal(unrelated.length, 0);
    assert.equal(formatIntentOverlap(unrelated), '');

    const pending = [{
        id: 'act:new-fire', summary: '南门的城门被烧毁了',
        locationId: 'loc:south', locationName: '南门', npcIds: ['qing'],
        turnId: 't-pending', createdAtTurn: 4, publicWorld: true, committed: false,
    }];
    const tooEarly = matchIntentOverlap('我要去南门一趟。', pending);
    assert.equal(tooEarly.length, 0, '本轮尚未提交的结果不得进入本轮注入');

    const ledger = createLedger();
    recordActivity(ledger, { id: 'act:bridge', npcIds: ['qing'], phase: 'done', summary: '山道上的石桥断了，无法再从这里过河', locationId: 'loc:bridge', turnId: 't-old', publicWorld: true });
    commitLedgerTurn(ledger, 't-old', 3);
    recordActivity(ledger, { id: 'act:new-fire', npcIds: ['qing'], phase: 'done', summary: '南门的城门被烧毁了', locationId: 'loc:south', turnId: 't-pending', publicWorld: true });
    // 新草稿尚未 commitLedgerTurn
    const built = buildLivingWorldInjection({
        ledger, npcs: [npc('qing', '林青')], states: { qing: { locationId: 'loc:north', activity: '巡视' } },
        currentTurn: 4, playerIntent: '我要去打败魔王，路上会用到那座桥，随后再去南门。',
        locationName: id => id === 'loc:bridge' ? '石桥' : '南门',
        preferences: { encounterProbability: 0 },
    });
    assert.match(built.overlapText, /石桥断了/);
    assert.doesNotMatch(built.overlapText, /城门被烧毁/);
    assert.ok(!built.overlaps.some(item => /烧毁/.test(item.summary)));
});

test('私密未发现痕迹不会因意图重合被写成玩家已经看见', () => {
    assert.equal(isPublicWorldState('林青在北塔翻找藏书并翻乱了书架'), false);
    assert.equal(isPublicWorldState('山道上的石桥断了'), true);
    const ledger = createLedger();
    const drafts = draftsFromSettlement([{
        id: 'e-search', kind: 'activity', summary: '林青完成了事先计划的翻找藏书并翻乱了书架',
        npcIds: ['qing'], locationId: 'loc:north', turnId: 't1', knownBy: [],
    }], [], { turnId: 't1', locationName: () => '北塔' });
    appendSettlementDrafts(ledger, drafts, { turnId: 't1', createdAtTurn: 1 });
    commitLedgerTurn(ledger, 't1', 3);
    const results = collectSubmittedWorldResults({ ledger, locationName: () => '北塔' });
    assert.equal(results.length, 0);
    const hits = matchIntentOverlap('我去北塔调查这里有没有人来过。', results);
    assert.equal(hits.length, 0);
});

test('偶遇：低概率与单轮上限生效；囚禁、未登场资料不足、未行动者仍硬排除；地点不同不再硬排除', () => {
    const qing = npc('qing', '林青');
    const ning = npc('ning', '顾宁');
    const prisoner = npc('lock', '囚徒');
    const ghost = npc('ghost', '未登场者', { appeared: false, hasProfile: false, description: '' });
    const far = npc('far', '远行者');
    const idle = npc('idle', '闲人');
    const wanderer = npc('wander', '行者');
    const acting = {
        qing: { locationId: 'loc:north', activity: '巡视', mobility: 'free', scene: 'away' },
        ning: { locationId: 'loc:north', activity: '守夜', mobility: 'free', scene: 'away' },
        lock: { locationId: 'loc:north', activity: '闭关修炼', mobility: 'immobile', confinement: { value: 'imprisoned' }, scene: 'away' },
        ghost: { locationId: 'unknown', activity: '潜行', mobility: 'free', scene: 'away' },
        far: { locationId: 'loc:south', activity: '赶路', mobility: 'free', scene: 'away' },
        idle: { locationId: 'loc:north', activity: '空闲', mobility: 'free', scene: 'away' },
        wander: { locationId: 'unknown', activity: '赶路', mobility: 'free', scene: 'away' },
    };
    const ledger = ledgerWith([
        { id: 'a1', npcIds: ['qing'], phase: 'doing', summary: '林青正在北塔巡视', locationId: 'loc:north', turnId: 't3' },
        { id: 'a2', npcIds: ['ning'], phase: 'doing', summary: '顾宁正在北塔守夜', locationId: 'loc:north', turnId: 't3' },
        { id: 'a3', npcIds: ['lock'], phase: 'doing', summary: '囚徒仍被关押', locationId: 'loc:north', turnId: 't3' },
        { id: 'a4', npcIds: ['ghost'], phase: 'doing', summary: '未登场者正在潜行', locationId: 'unknown', turnId: 't3' },
        { id: 'a5', npcIds: ['far'], phase: 'doing', summary: '远行者正在南门赶路', locationId: 'loc:south', turnId: 't3' },
        { id: 'a6', npcIds: ['wander'], phase: 'doing', summary: '行者正在赶路', locationId: 'unknown', turnId: 't3' },
    ], 't3', 3);
    const context = { ledger, playerLocationId: 'loc:north', mentionedText: '我在北塔附近走走。' };

    assert.equal(encounterEligibility(prisoner, acting.lock, context).ok, false);
    assert.match(encounterEligibility(prisoner, acting.lock, context).reasons.join('，'), /闭关或囚禁/);
    assert.equal(encounterEligibility(ghost, acting.ghost, context).ok, false);
    assert.match(encounterEligibility(ghost, acting.ghost, context).reasons.join('，'), /未登场且资料不足/);
    assert.equal(encounterEligibility(idle, acting.idle, context).ok, false);
    assert.match(encounterEligibility(idle, acting.idle, context).reasons.join('，'), /当前没有正在进行的行动/);
    assert.equal(locationCompatibility('loc:north', 'loc:south'), 'mismatch');
    const farVerdict = encounterEligibility(far, acting.far, context);
    assert.equal(farVerdict.ok, true, '地点不同不得硬排除正在行动的人');
    assert.equal(farVerdict.fit, 'mismatch');
    assert.ok(!farVerdict.reasons.some(reason => /地点/.test(reason)));
    const wanderVerdict = encounterEligibility(wanderer, acting.wander, context);
    assert.equal(wanderVerdict.ok, true);
    assert.equal(wanderVerdict.fit, 'uncertain');
    const sameVerdict = encounterEligibility(qing, acting.qing, context);
    assert.equal(sameVerdict.ok, true);
    assert.equal(sameVerdict.fit, 'same');

    const candidates = [
        { npcId: 'qing', npcName: '林青', summary: '巡视', fit: 'same' },
        { npcId: 'ning', npcName: '顾宁', summary: '守夜', fit: 'same' },
        { npcId: 'third', npcName: '第三人', summary: '路过', fit: 'uncertain' },
    ];
    const none = selectEncounters(candidates, { probability: 0, maxPerTurn: 1, seed: 's', currentTurn: 3 });
    assert.equal(none.length, 0);
    const capped = selectEncounters(candidates, { probability: 1, maxPerTurn: 1, seed: 's', currentTurn: 3 });
    assert.equal(capped.length, 1, '单轮最多偶遇 1 人');
    const unlimited = selectEncounters(candidates, { probability: 1, maxPerTurn: 3, seed: 's', currentTurn: 3 });
    assert.equal(unlimited.length, 3);
});

test('地点只做软加权：同地权重大于异地，固定随机下入选结果不同，异地仍可能被选中', () => {
    assert.equal(encounterLocationWeight('same'), 1.6);
    assert.equal(encounterLocationWeight('uncertain'), 1);
    assert.equal(encounterLocationWeight('mismatch'), 0.35);
    const sameP = effectiveEncounterProbability(0.5, 'same');
    const uncertainP = effectiveEncounterProbability(0.5, 'uncertain');
    const mismatchP = effectiveEncounterProbability(0.5, 'mismatch');
    assert.equal(sameP, 0.8);
    assert.equal(uncertainP, 0.5);
    assert.equal(mismatchP, 0.175);
    assert.ok(sameP > uncertainP && uncertainP > mismatchP);
    assert.equal(effectiveEncounterProbability(1, 'same'), 1, '加权后仍夹在 0–1，不会超过 1');

    const same = { npcId: 'qing', npcName: '林青', summary: '巡视', fit: 'same' };
    const far = { npcId: 'far', npcName: '远行者', summary: '赶路', fit: 'mismatch' };
    const midRoll = selectEncounters([same, far], { probability: 0.5, maxPerTurn: 2, random: () => 0.3, seed: 'fixed', currentTurn: 3 });
    assert.deepEqual(midRoll.map(item => item.npcId), ['qing'], '中等随机值下同地入选、异地落选');
    const lowRoll = selectEncounters([same, far], { probability: 0.5, maxPerTurn: 2, random: () => 0.1, seed: 'fixed', currentTurn: 3 });
    assert.equal(lowRoll.length, 2, '足够低的随机值下异地也可以入选');
    assert.ok(lowRoll.some(item => item.npcId === 'far' && item.fit === 'mismatch'));
    assert.ok(lowRoll.find(item => item.npcId === 'qing').chance > lowRoll.find(item => item.npcId === 'far').chance);

    const onlyFar = selectEncounters([far], { probability: 1, maxPerTurn: 1, random: () => 0, seed: 'fixed', currentTurn: 3 });
    assert.equal(onlyFar.length, 1);
    assert.equal(onlyFar[0].npcId, 'far');
    assert.equal(onlyFar[0].weight, 0.35);
    assert.equal(onlyFar[0].chance, 0.35);
});

test('偶遇注入本身不会把未发现痕迹标成已发现', () => {
    const qing = npc('qing', '林青');
    const ledger = createLedger();
    const drafts = draftsFromSettlement([{
        id: 'e-search', kind: 'activity', summary: '林青完成了事先计划的翻找藏书并翻乱了书架',
        npcIds: ['qing'], locationId: 'loc:north', turnId: 't1', knownBy: [],
    }], [], { turnId: 't1', locationName: () => '北塔' });
    appendSettlementDrafts(ledger, drafts, { turnId: 't1', createdAtTurn: 1 });
    recordActivity(ledger, { id: 'act:doing', npcIds: ['qing'], phase: 'doing', summary: '林青正在北塔整理书架', locationId: 'loc:north', turnId: 't2' });
    commitLedgerTurn(ledger, 't2', 5);
    const traceId = ledger.traces[0].id;
    assert.equal(isDiscoveredCanon(ledger, traceId), false);
    const built = buildLivingWorldInjection({
        ledger, npcs: [qing], states: { qing: { locationId: 'loc:north', activity: '整理书架', mobility: 'free', scene: 'away' } },
        currentTurn: 5, playerIntent: '我在院子里晒太阳。', mentionedText: '我在院子里晒太阳。',
        player: { locationId: 'loc:north' }, locationName: () => '北塔',
        preferences: { encounterProbability: 1, encounterMaxPerTurn: 1 },
        random: () => 0,
    });
    assert.ok(built.encounters.some(item => item.npcId === 'qing'));
    assert.match(built.encounterText, /偶遇机会/);
    assert.match(built.encounterText, /不是强行改写玩家行动/);
    assert.equal(isDiscoveredCanon(ledger, traceId), false, '偶遇不得写回已发现');
    assert.equal((ledger.discoveries || []).filter(item => item.knowledge === 'found').length, 0);
    const later = applyStoryDiscoveries(ledger, {
        text: '你只是在院子里晒太阳，没有去查看书架。',
        locationId: 'loc:yard', currentTurn: 5, offeredTraceIds: [traceId],
    });
    assert.equal(later.length, 0);
    assert.equal(isDiscoveredCanon(ledger, traceId), false);
});

test('地点不确定或不同时偶遇只给可能路过的机会，不声称算过路线或已经到达；同地可写成可能在此处出现', () => {
    const lineOf = blob => (blob.split('\n').find(line => line.startsWith('- ')) || '');
    const uncertain = formatEncounters([{
        npcId: 'qing', npcName: '林青', summary: '林青正在赶路', fit: 'uncertain', locationName: '',
    }]);
    assert.match(lineOf(uncertain), /可能路过，系统并未计算路线，也未声称已经到达/);
    assert.doesNotMatch(lineOf(uncertain), /可能在此处出现/);
    assert.doesNotMatch(uncertain, /已经发现|已发现痕迹/);

    const mismatch = formatEncounters([{
        npcId: 'far', npcName: '远行者', summary: '远行者正在南门赶路', fit: 'mismatch', locationName: '南门',
    }]);
    assert.match(lineOf(mismatch), /可能路过，系统并未计算路线，也未声称已经到达/);
    assert.doesNotMatch(lineOf(mismatch), /可能在此处出现/);
    assert.doesNotMatch(mismatch, /已经发现|已发现痕迹/);

    const same = formatEncounters([{
        npcId: 'qing', npcName: '林青', summary: '林青正在巡视', fit: 'same', locationName: '北塔',
    }]);
    assert.match(lineOf(same), /可能在此处出现/);
});

test('异地正在行动的人可进入偶遇注入，措辞不声称已经到达或算过路线', () => {
    const far = npc('far', '远行者');
    const ledger = ledgerWith([
        { id: 'a5', npcIds: ['far'], phase: 'doing', summary: '远行者正在南门赶路', locationId: 'loc:south', turnId: 't3' },
    ], 't3', 3);
    const built = buildLivingWorldInjection({
        ledger, npcs: [far], states: { far: { locationId: 'loc:south', activity: '赶路', mobility: 'free', scene: 'away' } },
        currentTurn: 3, playerIntent: '我在北塔附近走走。', mentionedText: '我在北塔附近走走。',
        player: { locationId: 'loc:north' }, locationName: () => '南门',
        preferences: { encounterProbability: 1, encounterMaxPerTurn: 1 },
        random: () => 0,
    });
    assert.equal(built.encounters.length, 1);
    assert.equal(built.encounters[0].npcId, 'far');
    assert.equal(built.encounters[0].fit, 'mismatch');
    assert.match(built.encounterText, /远行者/);
    const line = built.encounterText.split('\n').find(item => item.startsWith('- ') && item.includes('远行者')) || '';
    assert.match(line, /可能路过，系统并未计算路线，也未声称已经到达/);
    assert.doesNotMatch(line, /可能在此处出现/);
    assert.doesNotMatch(built.encounterText, /已经发现|已发现痕迹/);
});

test('tokenize 能抓住桥、门等关键地点字，辅助轻量重合判断', () => {
    const tokens = tokenize('我要去打败魔王，路上会用到那座桥');
    assert.ok(tokens.includes('桥'));
    assert.ok(tokenize('石桥断了').includes('桥'));
    assert.ok(!tokenize('我在客栈安静吃饭').includes('桥'));
});

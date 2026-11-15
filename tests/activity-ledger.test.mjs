import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline, proposeTurn, timelineContext } from '../timeline.js';
import { createWorldService } from '../world-service.js';
import {
    createLedger, normalizeLedger, recordActivity, recordTrace, recordDiscovery,
    appendSettlementDrafts, commitLedgerTurn, revokeLedgerTurn, revokeBySourceKeys,
    searchDiscoverableTraces, formatClueOpportunities, formatLedgerInjection, draftsFromSettlement,
    canArrangeActivity, hasSufficientProfile, isInvestigationText, activitiesForNpc, isDiscoveredCanon,
    describeObservableTrace, applyStoryDiscoveries, recordOfferedOpportunities, formatFoundClues,
} from '../activity-ledger.js';
import { writePublicMemory, selectMemoryRows } from '../services.js';

const rules = () => ({
    npcs: [{ id: 'qing', name: '阿青', tracked: true, confirmed: true, description: '阿青是北塔里沉静的守书人，性格谨慎。' }],
    states: { qing: { locationId: 'tower', scene: 'away', locked: false, activity: '未知' } },
    locations: [{ id: 'tower', name: '北塔', confirmed: true }, { id: 'yard', name: '庭院', confirmed: true }],
    parties: [], player: { locationId: 'yard', scene: 'present' },
});
const activity = (minutes = 30) => ({ kind: 'activity', locationId: 'tower', durationMinutes: minutes, summary: '阅读' });
const search = (minutes = 30) => ({ kind: 'activity', locationId: 'tower', durationMinutes: minutes, summary: '翻找藏书并翻乱了书架' });
const turn = (timeline, id, delta, plans = [], r = rules(), extra = {}) =>
    proposeTurn(timeline, { id, deltaMinutes: delta, plans, sources: extra.sources || [], feedback: extra.feedback || [] }, r);
const placeOf = id => ({ tower: '北塔', yard: '庭院' }[id] || id);

function settle(ledger, result, sourceKeys = []) {
    const drafts = draftsFromSettlement(
        result.timeline.events.filter(event => event.turnId === result.turnId),
        result.timeline.plans,
        { turnId: result.turnId, sourceKeys, locationName: placeOf },
    );
    appendSettlementDrafts(ledger, drafts, { turnId: result.turnId, sourceKeys, createdAtTurn: result.timeline.turns.length });
    return drafts;
}

test('人物资料与安排资格：未登场且资料不足不可提前安排，用户指定可以', () => {
    assert.equal(hasSufficientProfile({ name: '路人甲' }), false);
    assert.equal(hasSufficientProfile({ name: '阿青', description: '阿青是北塔守书人，性格谨慎。' }), true);
    const original = { id: 'x', name: '路人甲', tracked: true, appeared: false, hasProfile: false };
    assert.equal(canArrangeActivity(original), false);
    assert.equal(canArrangeActivity({ ...original, userDesignated: true }), true);
    assert.equal(canArrangeActivity({ id: 'qing', name: '阿青', tracked: true, appeared: true, description: '阿青是北塔守书人，性格谨慎。' }), true);
    assert.equal(canArrangeActivity({ id: 'legacy', name: '旧档', tracked: true }), true);
    assert.equal(canArrangeActivity({ id: 'card', name: '未出场', tracked: true, appeared: false, description: '有完整设定资料的世界书角色。' }), false);
});

test('合成剧情：可观察活动产生带类型痕迹 → 数轮后调查才注入机会 → 正文发现写回 → 编辑来源后回退', () => {
    const r = rules();
    let timeline = createTimeline();
    const ledger = createLedger();

    // 时间线动作名不能夹带新事实；用允许的日常行动走时钟，再用可观察行动的结算草稿生成痕迹。
    const planned = turn(timeline, 't1-plan', 0, [{ npcIds: ['qing'], goal: '日常', reason: '安排', steps: [activity()] }], r);
    timeline = planned.timeline;
    settle(ledger, planned, ['src:plan']);
    const done = turn(timeline, 't1-done', 30, [], r, { sources: [{ key: 'src:act', content: '过了三十分钟。', role: 'assistant' }] });
    timeline = done.timeline;
    assert.equal(timeline.events[0].knownBy.includes('player'), false);
    assert.equal(timelineContext(timeline, r), '');
    const observable = {
        id: 'e-search', kind: 'activity',
        summary: '阿青完成了事先计划的翻找藏书并翻乱了书架',
        npcIds: ['qing'], locationId: 'tower', turnId: 't1-done', knownBy: [],
    };
    const drafts = draftsFromSettlement(
        [...timeline.events.filter(event => event.turnId === 't1-done'), observable],
        [],
        { turnId: 't1-done', sourceKeys: ['src:act'], locationName: placeOf },
    );
    assert.equal(drafts.traces.length, 1, '阅读等日常完成不应生成痕迹，翻找藏书应生成');
    appendSettlementDrafts(ledger, drafts, { turnId: 't1-done', sourceKeys: ['src:act'], createdAtTurn: timeline.turns.length });

    // 尚未提交前，检索不应把痕迹提供给正文。
    assert.deepEqual(searchDiscoverableTraces(ledger, { text: '我去北塔调查一下有没有人来过', locationId: 'tower', locationName: '北塔', currentTurn: 2, locations: r.locations, npcs: r.npcs }), []);
    commitLedgerTurn(ledger, 't1-done', 2);
    commitLedgerTurn(ledger, 't1-plan', 2);
    const traces = ledger.traces.filter(item => item.status === 'active');
    assert.equal(traces.length, 1);
    assert.equal(traces[0].committed, true);
    assert.equal(traces[0].traceType, 'search');
    assert.match(traces[0].summary, /搜寻痕迹/);
    assert.match(traces[0].summary, /北塔/);
    assert.match(traces[0].content, /翻找藏书|翻乱了书架/);
    assert.doesNotMatch(traces[0].summary, /留下了行踪/);

    // 下一轮仍未调查：即使已提交，也不应无故写成玩家已知。
    const idle = searchDiscoverableTraces(ledger, { text: '我们继续聊天。', currentTurn: 3, npcs: r.npcs, locations: r.locations });
    assert.equal(idle.length, 0);
    assert.equal(timelineContext(timeline, r), '');

    // 数轮后，玩家调查相关场景，才把可发现机会注入正文。
    const hits = searchDiscoverableTraces(ledger, {
        text: '几天后我走进北塔，调查这里好像有没有人来过。',
        locationId: 'tower', locationName: '北塔', currentTurn: 5,
        npcs: r.npcs, locations: r.locations,
    });
    assert.ok(hits.length >= 1);
    const opportunity = formatClueOpportunities(hits);
    assert.match(opportunity, /可被发现的线索机会/);
    assert.match(opportunity, /搜寻痕迹：在北塔/);
    const opportunityLines = opportunity.split('\n').filter(line => line.startsWith('- ')).join('\n');
    assert.doesNotMatch(opportunityLines, /玩家已经看见|玩家已经知道/);
    assert.ok(!isDiscoveredCanon(ledger, hits[0].trace.id));
    recordOfferedOpportunities(ledger, hits, { offeredAtTurn: 5, turnId: 't5-offer' });

    // 正文只是路过、没有写出发现：不得写回已发现，下次调查仍可给机会。
    const passed = applyStoryDiscoveries(ledger, {
        text: '我走进北塔，穿过大厅继续往里走。\n你路过北塔的厅堂，没有停留，继续向前。',
        locationId: 'tower', locationName: '北塔', currentTurn: 5, turnId: 't5-pass',
        npcs: r.npcs, locations: r.locations, offeredTraceIds: [hits[0].trace.id], sourceKeys: ['src:pass'],
    });
    assert.equal(passed.length, 0);
    assert.equal(isDiscoveredCanon(ledger, hits[0].trace.id), false);
    const stillOpen = searchDiscoverableTraces(ledger, {
        text: '我走进北塔调查有没有人来过。', locationId: 'tower', locationName: '北塔', currentTurn: 6,
        npcs: r.npcs, locations: r.locations,
    });
    assert.ok(stillOpen.some(item => item.trace.id === hits[0].trace.id));

    // 调查且正文写出发现后，资料库变为已发现，之后不再以可发现机会重复注入。
    const discovered = applyStoryDiscoveries(ledger, {
        text: '我停下来，仔细调查北塔这里好像有没有人来过。\n你蹲在地上查看，发现书架被翻乱，这里好像有人来过，留下了翻找的痕迹。',
        locationId: 'tower', locationName: '北塔', currentTurn: 6, turnId: 't6',
        npcs: r.npcs, locations: r.locations, offeredTraceIds: [hits[0].trace.id],
        sourceKeys: ['src:investigate'],
    });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].knowledge, 'found');
    assert.match(discovered[0].evidence, /发现书架被翻乱|好像有人来过/);
    assert.equal(isDiscoveredCanon(ledger, hits[0].trace.id), true);
    const afterFound = searchDiscoverableTraces(ledger, {
        text: '我继续在北塔调查。', locationId: 'tower', locationName: '北塔', currentTurn: 7,
        npcs: r.npcs, locations: r.locations,
    });
    assert.equal(afterFound.some(item => item.trace.id === hits[0].trace.id), false);
    const known = formatLedgerInjection(ledger, {
        text: '我继续在北塔调查。', locationId: 'tower', locationName: '北塔', currentTurn: 7,
        npcs: r.npcs, locations: r.locations,
    });
    assert.match(known, /已发现的线索/);
    assert.match(known, /已发现：/);
    assert.doesNotMatch(known, /可被发现的线索机会/);

    // 编辑调查来源后，发现回退，不应继续当成已发现正史。
    const revoked = revokeBySourceKeys(ledger, ['src:investigate']);
    assert.equal(revoked.discoveries, 1);
    assert.equal(discovered[0].status, 'revoked');
    assert.equal(isDiscoveredCanon(ledger, hits[0].trace.id), false);
    const again = searchDiscoverableTraces(ledger, {
        text: '我走进北塔调查有没有人来过。', locationId: 'tower', locationName: '北塔', currentTurn: 7,
        npcs: r.npcs, locations: r.locations,
    });
    assert.ok(again.some(item => item.trace.id === hits[0].trace.id));
    const againInject = formatLedgerInjection(ledger, {
        text: '我走进北塔调查有没有人来过。', locationId: 'tower', locationName: '北塔', currentTurn: 7,
        npcs: r.npcs, locations: r.locations,
    });
    assert.match(againInject, /可被发现的线索机会/);
    assert.doesNotMatch(againInject, /已发现的线索/);
});

test('未写时间=0 仍记录事件和计划，但不推进时钟；本轮结算不污染本轮注入', async () => {
    const messages = [{ key: 'old', role: 'assistant', content: '旧开场。' }];
    const chat = { day: 1, stateRevision: 0, npcStates: { qing: { locationId: 'tower', scene: 'away', activity: '休息' } }, committedInjection: '' };
    const world = {};
    const calls = [];
    const committedInjections = [];
    let injectionBeforeCommit = null;
    const host = {
        data: () => ({ world, chat, store: { preferences: { autoMode: 'world', autoEnabled: true } } }),
        identity: () => 'world|chat', sources: () => messages, messageSignature: () => JSON.stringify(messages),
        preferences: () => ({ autoMode: 'world', autoEnabled: true }),
        rules: () => rules(),
        request: async (system, prompt, task) => {
            calls.push(task);
            if (task === 'analysis') return { deltaMinutes: null, timeEvidence: '片刻', timeConfidence: 0.2, timeExplicit: false, feedback: [] };
            return { plans: [{ npcIds: ['qing'], goal: '日常', reason: '安排', knownEventIds: [], steps: [activity()] }] };
        },
        commit: (timeline, projections) => {
            injectionBeforeCommit = chat.committedInjection || timelineContext(chat.timeline || { events: [], turns: [] }, rules());
            chat.timeline = timeline;
            const ledger = chat.activityLedger = normalizeLedger(chat.activityLedger);
            const drafts = draftsFromSettlement(timeline.events.filter(event => event.turnId === timeline.turns.at(-1)?.id), timeline.plans, { turnId: timeline.turns.at(-1).id });
            appendSettlementDrafts(ledger, drafts, { turnId: timeline.turns.at(-1).id, createdAtTurn: timeline.turns.length });
            commitLedgerTurn(ledger, timeline.turns.at(-1).id, timeline.turns.length);
            chat.committedInjection = [timelineContext(timeline, rules()), formatLedgerInjection(ledger, { text: '继续聊天', currentTurn: timeline.turns.length, npcs: rules().npcs })].filter(Boolean).join('\n');
            committedInjections.push(chat.committedInjection);
        },
        rollback: () => {}, saveView: () => {}, refresh: () => {}, id: () => `turn:${calls.length}`,
        npcLore: () => '阿青是北塔里沉静的守书人，性格谨慎。',
    };
    const service = createWorldService(host);
    await service.run();
    messages.push({ key: 'src:chat', role: 'user', content: '他们交谈了片刻。' });
    await service.run();
    assert.equal(chat.timeline.clockMinutes, 0);
    assert.equal(chat.timeline.plans.length, 1);
    assert.equal(chat.timeline.plans[0].steps[0].remainingMinutes, 30);
    assert.equal(injectionBeforeCommit, '');
    // 结算提交后，下一轮才使用新的已提交注入；本轮结算前的注入不被改写成当轮结果旁白。
    assert.ok(committedInjections.at(-1) === '' || !committedInjections.at(-1).includes('已经看见'));
});

test('记忆只读，不能覆盖已提交正史；写回不会调用插件接口', () => {
    const ledger = createLedger();
    recordActivity(ledger, { npcIds: ['qing'], phase: 'done', summary: '阿青在北塔阅读', source: 'settlement', publicCanon: true, committed: true, turnId: 't1' });
    const memory = selectMemoryRows([{ name: '旧记忆', data: [['事'], ['阿青昨天已经成功夺位，并且玩家早就知道全部行踪']] }], ['阿青'], 400);
    assert.match(memory, /夺位/);
    const injection = formatLedgerInjection(ledger, { text: '继续', npcs: [{ id: 'qing', name: '阿青' }], locationName: () => '北塔' });
    assert.match(injection, /阿青在北塔阅读/);
    assert.doesNotMatch(injection, /夺位/);
    const called = [];
    const result = writePublicMemory({
        ext_appendRows: (...args) => called.push(['ext_appendRows', args]),
        addMemory: (...args) => called.push(['addMemory', args]),
    }, [{ name: '阿青', summary: '夺位成功' }]);
    assert.equal(result.written, false);
    assert.deepEqual(called, []);
});

test('资料库可积累检索，不是只留最近一两笔；按来源撤销活动会带走痕迹', () => {
    const ledger = createLedger();
    for (let i = 0; i < 8; i++) {
        const activity = recordActivity(ledger, { npcIds: ['qing'], phase: 'done', summary: `做过第${i}件事`, source: 'settlement', committed: true, turnId: `t${i}`, sourceKeys: [`s${i}`] });
        recordTrace(ledger, { activityId: activity.id, npcIds: ['qing'], summary: `第${i}件事留下的痕迹`, keywords: ['痕迹', '北塔'], committed: true, turnId: `t${i}`, sourceKeys: [`s${i}`], locationId: 'tower', createdAtTurn: i });
    }
    commitLedgerTurn(ledger, '', 8);
    const history = activitiesForNpc(ledger, 'qing');
    assert.equal(history.length, 8);
    const hits = searchDiscoverableTraces(ledger, { text: '我到北塔调查痕迹', locationId: 'tower', locationName: '北塔', currentTurn: 10 });
    assert.ok(hits.length >= 2);
    revokeBySourceKeys(ledger, ['s3']);
    assert.equal(activitiesForNpc(ledger, 'qing').length, 7);
    assert.equal(searchDiscoverableTraces(ledger, { text: '我到北塔调查痕迹', locationId: 'tower', locationName: '北塔', currentTurn: 10 }).every(item => !item.trace.summary.includes('第3件事')), true);
});



test('阅读、休息、做饭、对话和未执行计划不生成痕迹；搜寻、破坏等生成且含类型与地点', () => {
    const event = (summary, locationId = 'tower', kind = 'activity') => [{
        id: `e:${summary}`, kind, summary: summary.includes('完成了') ? summary : `阿青完成了事先计划的${summary}`,
        npcIds: ['qing'], locationId, turnId: 't1', knownBy: [],
    }];
    const loc = { locationName: placeOf };
    for (const summary of ['阅读', '思考对策', '休息', '睡觉', '做饭', '吃饭', '与人交谈', '阅读有关调查方法的书', '准备前往北塔']) {
        const drafts = draftsFromSettlement(event(summary), [], { turnId: 't1', ...loc });
        assert.equal(drafts.traces.length, 0, summary);
        assert.ok(drafts.activities.length >= 1, summary);
    }
    const travelPlans = [{
        id: 'p-travel', status: 'active', npcIds: ['qing'], goal: '前往庭院',
        steps: [{ id: 's1', status: 'active', kind: 'travel', targetLocationId: 'yard', locationId: 'tower' }],
    }];
    const travel = draftsFromSettlement([], travelPlans, { turnId: 't1', ...loc });
    assert.equal(travel.traces.length, 0);
    assert.ok(travel.activities.length >= 1);

    const cases = [
        ['翻找藏书并翻乱了书架', 'search', /搜寻痕迹/, /北塔/],
        ['砸开侧门并破坏了门锁', 'damage', /破坏痕迹/, /北塔/],
        ['闯入庭院', 'intrusion', /闯入痕迹/, /庭院/],
        ['仓皇逃窜，地上留下脚印', 'escape', /逃亡痕迹/, /北塔/],
    ];
    for (const [summary, type, typeRe, placeRe] of cases) {
        const locationId = summary.includes('庭院') ? 'yard' : 'tower';
        const drafts = draftsFromSettlement(event(summary, locationId), [], { turnId: 't1', ...loc });
        assert.equal(drafts.traces.length, 1, summary);
        assert.equal(drafts.traces[0].traceType, type, summary);
        assert.match(drafts.traces[0].summary, typeRe);
        assert.match(drafts.traces[0].summary, placeRe);
        assert.ok(drafts.traces[0].content);
        assert.doesNotMatch(drafts.traces[0].summary, /留下了行踪/);
    }
    assert.equal(describeObservableTrace({ summary: '做饭', locationId: 'tower' }, loc), null);
    assert.equal(describeObservableTrace({ summary: '翻找密室', locationId: 'tower' }, loc).type, 'search');
});
test('isInvestigationText 能识别调查意图', () => {
    assert.equal(isInvestigationText('我去北塔调查一下有没有人来过'), true);
    assert.equal(isInvestigationText('我们继续闲聊天气'), false);
});

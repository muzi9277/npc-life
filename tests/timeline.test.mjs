import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline, proposeTurn, undoTurns, timelineContext } from '../timeline.js';

// 每个测试使用全新规则；route 的耗时已经包含移动速度倍率。
function rules(count = 1) {
    const npcs = Array.from({ length: count }, (_, index) => ({ id: `n${index}`, name: `角色${index}`, tracked: true, confirmed: true, archived: false, ignored: false }));
    return { npcs, states: Object.fromEntries(npcs.map(npc => [npc.id, { locationId: 'a', scene: 'away', locked: false, activity: '原活动', travelRate: 9, relationship: { value: 'friend' } }])),
        locations: [{ id: 'a', name: '书房', confirmed: true }, { id: 'b', name: '花园', confirmed: true }, { id: 'x', name: '未确认', confirmed: false }],
        parties: [], player: { locationId: 'a', scene: 'present' }, route: () => ({ durationMinutes: 90 }) };
}
const activity = (minutes = 90, extra = {}) => ({ kind: 'activity', locationId: 'a', summary: '阅读', durationMinutes: minutes, ...extra });
const travel = (extra = {}) => ({ kind: 'travel', locationId: 'a', targetLocationId: 'b', durationMinutes: 1, summary: '发现宝藏', ...extra });
const plan = (steps = [activity()], npcIds = ['n0'], extra = {}) => ({ npcIds, goal: '私密目标', reason: '私密心理', steps, ...extra });
const turn = (timeline, id, deltaMinutes, plans = [], r = rules(), extra = {}) => proposeTurn(timeline, { id, deltaMinutes, plans, sources: [], ...extra }, r);
// 深冻结输入，确保实现没有隐蔽地修改嵌套对象。
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; }

test('createTimeline 精确字段与独立 baselineSources', () => {
    const sources = [{ key: 'base', content: '基线', role: 'user' }];
    const timeline = createTimeline({ baseDay: 4, sources });
    assert.deepEqual(timeline, { version: 1, clockMinutes: 0, baseDay: 4, revision: 0, plans: [], turns: [], events: [], pending: null, sourceCursor: 1, baselineSources: sources, pausedReason: '' });
    timeline.baselineSources[0].content = '变化';
    assert.equal(sources[0].content, '基线');
    assert.throws(() => createTimeline({ baseDay: 0 }), TypeError);
});

test('确定性 60+30 分钟完成旧计划，新计划不倒算', () => {
    const r = rules();
    const initial = turn(createTimeline(), 'start', 60, [plan()], r);
    assert.equal(initial.timeline.plans[0].steps[0].remainingMinutes, 90);
    assert.deepEqual(initial.projections, []);
    const first = turn(initial.timeline, 'plus60', 60, [], r);
    assert.equal(first.timeline.plans[0].steps[0].remainingMinutes, 30);
    const last = turn(first.timeline, 'plus30', 30, [], r);
    assert.equal(last.timeline.clockMinutes, 150);
    assert.equal(last.timeline.plans[0].status, 'completed');
    assert.deepEqual(last.projections, [{ npcId: 'n0', field: 'activity', value: '阅读' }]);
    assert.equal(last.timeline.events[0].summary, '角色0完成了事先计划的阅读');
    assert.deepEqual(last, turn(first.timeline, 'plus30', 30, [], r));
});

test('零分钟不执行，包括零耗时步骤；负数/NaN/重复id被拒绝', () => {
    const start = turn(createTimeline(), 's', 0, [plan([activity(0)])]).timeline;
    const zero = turn(start, 'z', 0);
    assert.equal(zero.timeline.plans[0].status, 'active');
    assert.equal(zero.timeline.events.length, 0);
    assert.equal(turn(start, 'positive', 1).timeline.plans[0].status, 'completed');
    for (const value of [-1, NaN, Infinity]) assert.throws(() => turn(start, 'bad', value), TypeError);
    assert.throws(() => turn(start, 's', 0), /id/);
});

test('travel 只采用route耗时，不二次乘rate；完成才投影地点', () => {
    const r = rules();
    let routeArgs;
    r.route = (...args) => { routeArgs = args; return { durationMinutes: 90 }; };
    const start = turn(createTimeline(), 's', 0, [plan([travel()])], r).timeline;
    assert.deepEqual(routeArgs, ['a', 'b', ['n0']]);
    assert.equal(start.plans[0].steps[0].durationMinutes, 90);
    const partial = turn(start, 'p', 60, [], r);
    assert.deepEqual(partial.projections, []);
    const done = turn(partial.timeline, 'd', 30, [], r);
    assert.deepEqual(done.projections, [{ npcId: 'n0', field: 'locationId', value: 'b' }]);
    assert.equal(done.timeline.events[0].summary, '角色0抵达花园');
    assert.ok(!done.timeline.events[0].summary.includes('宝藏'));
    assert.equal(r.states.n0.locationId, 'a');
});

test('剩余时段跨步骤，用虚拟状态校验并只保留三步', () => {
    const r = rules();
    const steps = [activity(20), travel(), activity(10, { locationId: 'b', summary: '休息' }), activity(1)];
    const start = turn(createTimeline(), 's', 0, [plan(steps)], r).timeline;
    assert.equal(start.plans[0].steps.length, 3);
    const done = turn(start, 'd', 125, [], r);
    assert.equal(done.timeline.plans[0].status, 'completed');
    assert.deepEqual(done.timeline.events.map(event => event.clockMinutes), [20, 110, 120]);
    assert.deepEqual(done.projections.map(item => [item.field, item.value]), [['activity', '阅读'], ['locationId', 'b'], ['activity', '休息']]);
    assert.deepEqual(r.states.n0.relationship, { value: 'friend' });
});

test('只预先验证合法步骤；后续route未知时连前置活动也不执行', () => {
    const r = rules();
    r.route = () => null;
    const start = turn(createTimeline(), 's', 0, [plan([activity(10), travel()])], r).timeline;
    const result = turn(start, 'd', 100, [], r);
    assert.equal(result.timeline.plans[0].status, 'blocked');
    assert.equal(result.timeline.plans[0].steps[0].remainingMinutes, 10);
    assert.equal(result.timeline.events.length, 0);
    assert.deepEqual(result.projections, []);
});

test('未知地点、未确认地点、未知NPC、未追踪以及非法route都blocked', () => {
    const variants = [
        r => { r.states.n0.locationId = 'unknown'; },
        r => { r.npcs[0].confirmed = false; },
        r => { r.npcs[0].tracked = false; },
        r => { r.npcs = []; },
        r => { r.route = () => null; },
        r => { r.route = () => ({ durationMinutes: NaN }); },
    ];
    for (const setup of variants) {
        const r = rules(); setup(r);
        const result = turn(createTimeline(), 's', 100, [plan([travel()])], r);
        assert.equal(result.timeline.plans[0].status, 'blocked');
        assert.deepEqual(result.projections, []);
    }
    for (const destination of ['unknown', 'x', 'missing']) {
        assert.equal(turn(createTimeline(), destination, 0, [plan([travel({ targetLocationId: destination })])]).timeline.plans[0].status, 'blocked');
    }
});

test('present 禁止travel，原地非重大activity允许，重大activity保守blocked', () => {
    const r = rules(); r.states.n0.scene = 'present';
    assert.equal(turn(createTimeline(), 'travel', 0, [plan([travel()])], r).timeline.plans[0].status, 'blocked');
    assert.equal(turn(createTimeline(), 'major', 0, [plan()], r).timeline.plans[0].status, 'blocked');
    const start = turn(createTimeline(), 'minor', 0, [plan([activity(1, { major: false })])], r).timeline;
    const done = turn(start, 'done', 1, [], r);
    assert.equal(done.timeline.plans[0].status, 'completed');
    assert.deepEqual(done.timeline.events[0].knownBy, ['n0', 'player']);
});

test('locked/活动锁/不可移动均禁止activity和travel，但允许原地wait', () => {
    for (const patch of [{ locked: true }, { activityLock: { active: true } }, { mobility: 'immobile' }]) {
        const r = rules(); Object.assign(r.states.n0, patch);
        for (const steps of [[activity()], [travel()]]) assert.equal(turn(createTimeline(), 'blocked', 0, [plan(steps)], r).timeline.plans[0].status, 'blocked');
        const start = turn(createTimeline(), 's', 0, [plan([{ kind: 'wait', locationId: 'a', durationMinutes: 1, summary: '秘密新事实' }])], r).timeline;
        const done = turn(start, 'd', 1, [], r);
        assert.equal(done.timeline.plans[0].status, 'completed');
        assert.deepEqual(done.projections, []);
        assert.equal(done.timeline.events[0].summary, '角色0完成了事先计划的等待');
    }
});

test('旧计划在锁定、外部行程、归档、忽略时暂停且不消耗分钟', () => {
    const start = turn(createTimeline(), 's', 0, [plan()]).timeline;
    for (const setup of [r => { r.states.n0.locked = true; }, r => { r.states.n0.travel = { status: 'in_transit' }; }, r => { r.npcs[0].archived = true; }, r => { r.npcs[0].ignored = true; }]) {
        const r = rules(); setup(r);
        const paused = turn(start, 'p', 100, [], r).timeline;
        assert.equal(paused.plans[0].status, 'blocked');
        assert.equal(paused.plans[0].steps[0].remainingMinutes, 90);
        assert.equal(turn(paused, 'resume', 90).timeline.plans[0].status, 'completed');
    }
});

test('同行成员完整，同地点且所有成员可移动，否则blocked', () => {
    const r = rules(3); r.parties = [{ members: ['n0', 'n1'], confirmed: true }, { members: ['n1', 'n2'], confirmed: true }];
    assert.equal(turn(createTimeline(), 'split', 0, [plan([travel()], ['n0', 'n1'])], r).timeline.plans[0].status, 'blocked');
    const start = turn(createTimeline(), 'all', 0, [plan([travel()], ['n0', 'n1', 'n2'])], r).timeline;
    const done = turn(start, 'done', 90, [], r);
    assert.equal(done.projections.length, 3);
    r.states.n2.locked = true;
    assert.equal(turn(start, 'locked', 90, [], r).timeline.plans[0].status, 'blocked');
    r.states.n2.locked = false; r.states.n2.locationId = 'b';
    assert.equal(turn(start, 'apart', 90, [], r).timeline.plans[0].status, 'blocked');
});

test('本轮推进所有旧计划，不受六人新请求上限影响', () => {
    const r = rules(12);
    const start = turn(createTimeline(), 's', 0, r.npcs.map(npc => plan([activity(1)], [npc.id])), r).timeline;
    const done = turn(start, 'done', 1, [], r);
    assert.equal(done.projections.length, 12);
    assert.equal(done.timeline.events.length, 12);
    assert.ok(done.timeline.plans.every(item => item.status === 'completed'));
});

test('无feedback不替换有效计划，cancel/replace在推进之前且新计划轮末开始', () => {
    const start = turn(createTimeline(), 's', 0, [plan()]).timeline;
    const replacement = plan([activity(20, { summary: '休息' })]);
    const unchanged = turn(start, 'no', 10, [replacement]).timeline;
    assert.equal(unchanged.plans.length, 1);
    assert.equal(unchanged.plans[0].steps[0].remainingMinutes, 80);
    for (const action of ['cancel', 'replace']) {
        const result = turn(start, action, 100, action === 'replace' ? [replacement] : [], rules(), { feedback: [{ npcId: 'n0', action, evidence: '上层已核验的正文证据' }] });
        assert.equal(result.timeline.plans[0].status, 'cancelled');
        assert.equal(result.timeline.events.length, 0);
        if (action === 'replace') assert.equal(result.timeline.plans[1].steps[0].remainingMinutes, 20);
    }
    assert.equal(turn(start, 'empty', 0, [replacement], rules(), { feedback: [{ npcId: 'n0', action: 'replace', evidence: '' }] }).timeline.plans.length, 1);
});

test('causeIds仅限存在且全体参与者知情的事件，同地点away不赋予player知情', () => {
    const r = rules(2);
    let timeline = createTimeline();
    timeline.events = [
        { id: 'all', knownBy: ['n0', 'n1'] }, { id: 'private', knownBy: ['n0'] }, { id: 'player', knownBy: ['player'] },
    ];
    timeline = turn(timeline, 's', 0, [plan([activity(1)], ['n0', 'n1'], { knownEventIds: ['all', 'private', 'player', 'missing'] })], r).timeline;
    const done = turn(timeline, 'done', 1, [], r).timeline;
    assert.deepEqual(done.plans[0].knownEventIds, ['all']);
    assert.deepEqual(done.events.at(-1).causeIds, ['all']);
    assert.deepEqual(done.events.at(-1).knownBy, ['n0', 'n1']);
    assert.equal(timelineContext(done, r), '');
});

test('事件拒绝模型summary新事实，动作描述不超过160字符', () => {
    for (const summary of ['阅读并发现国王已经死亡', '阅读。某人抵达', '阅读'.repeat(100)]) {
        const result = turn(createTimeline(), 's', 0, [plan([activity(1, { summary })])]).timeline;
        assert.equal(result.plans[0].status, 'blocked');
        assert.ok(result.plans[0].steps[0].summary.length <= 160);
    }
});

test('undo只恢复engine快照及源游标，返回撤回链，保留上层字段', () => {
    const r = rules();
    const baseline = [{ key: 'b', role: 'user', content: '基线' }];
    let timeline = createTimeline({ sources: baseline });
    timeline = turn(timeline, 's', 0, [plan([activity(1)])], r, { sources: [{ key: '1', content: '正文1', role: 'user' }] }).timeline;
    const expected = structuredClone(timeline);
    timeline = turn(timeline, 'd', 1, [], r, { sources: [{ key: '2', content: '正文2', role: 'assistant' }, { key: '3', content: '正文3', role: 'user' }] }).timeline;
    timeline.pending = { host: '保留' }; timeline.pausedReason = '宿主原因';
    assert.equal(timeline.sourceCursor, 4);
    assert.deepEqual(Object.keys(timeline.turns[1].before).sort(), ['clockMinutes', 'events', 'plans', 'sourceCursor']);
    const undone = undoTurns(freeze(timeline), 1);
    for (const field of ['clockMinutes', 'events', 'plans', 'sourceCursor', 'turns', 'baselineSources']) assert.deepEqual(undone.timeline[field], expected[field]);
    assert.equal(undone.revokedTurns[0].id, 'd');
    assert.deepEqual(undone.revokedTurns[0].projections, [{ npcId: 'n0', field: 'activity', value: '阅读' }]);
    assert.deepEqual(undone.timeline.pending, { host: '保留' });
    assert.equal(undone.timeline.pausedReason, '宿主原因');
    const all = undoTurns(undone.timeline, 0);
    assert.equal(all.timeline.sourceCursor, 1);
    assert.equal(all.timeline.turns.length, 0);
    assert.deepEqual(all.timeline.plans, []);
    assert.deepEqual(undoTurns(all.timeline, 0).revokedTurns, []);
    assert.throws(() => undoTurns(timeline, -1), RangeError);
});

test('context最多最近3条玩家已知同场事件，预算按字符，不泄露目标心理', () => {
    const r = rules(); r.states.n0.scene = 'present';
    let timeline = createTimeline();
    for (let index = 0; index < 5; index++) {
        timeline = turn(timeline, `s${index}`, 0, [plan([activity(1, { major: false })])], r).timeline;
        timeline = turn(timeline, `d${index}`, 1, [], r).timeline;
    }
    const context = timelineContext(timeline, r);
    assert.equal(context.split('\n').length, 3);
    assert.ok(!context.includes('[1分钟]'));
    assert.ok(!context.includes('私密'));
    assert.ok(timelineContext(timeline, r, 20).length <= 20);
    assert.equal(timelineContext(timeline, r, 0), '');
    r.states.n0.scene = 'away';
    assert.equal(timelineContext(timeline, r), '');
});

test('满60轮显式throw，事件上限不静默截断回滚依赖', () => {
    let timeline = createTimeline();
    for (let index = 0; index < 60; index++) timeline = turn(timeline, `t${index}`, 0).timeline;
    const before = structuredClone(timeline);
    assert.throws(() => turn(timeline, 'overflow', 0), /60/);
    assert.deepEqual(timeline, before);
    const undo = undoTurns(timeline, 59);
    assert.equal(turn(undo.timeline, 'new', 0).timeline.turns.length, 60);
    const r = rules();
    const full = turn(createTimeline(), 's', 0, [plan([activity(1)])], r).timeline;
    full.events = Array.from({ length: 180 }, (_, index) => ({ id: `e${index}`, knownBy: [] }));
    assert.throws(() => turn(full, 'overflow-events', 1, [], r), /180/);
    assert.equal(full.events.length, 180);
});

test('delta限定0..10080整数，拒绝小数、超限、非数值与累计溢出且不改输入', () => {
    const timeline = freeze(createTimeline());
    for (const delta of [0.5, 1.1, 10080.5, 10081, Number.MAX_SAFE_INTEGER + 1, '60', NaN, Infinity, -1]) {
        assert.throws(() => turn(timeline, 'bad', delta), TypeError);
        assert.equal(timeline.clockMinutes, 0);
        assert.equal(timeline.turns.length, 0);
    }
    assert.equal(turn(timeline, 'min', 0).timeline.clockMinutes, 0);
    assert.equal(turn(timeline, 'max', 10080).timeline.clockMinutes, 10080);
    const overflow = { ...createTimeline(), clockMinutes: Number.MAX_SAFE_INTEGER };
    assert.throws(() => turn(overflow, 'overflow', 1), TypeError);
});

test('route必须返回正安全整数分钟，活动和等待也禁止小数耗时', () => {
    for (const durationMinutes of [0.5, 90.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, 0, -1, '90']) {
        const r = rules(); r.route = () => ({ durationMinutes });
        const start = turn(createTimeline(), 's', 0, [plan([travel()])], r).timeline;
        const result = turn(start, 'd', 100, [], r);
        assert.equal(result.timeline.plans[0].status, 'blocked');
        assert.deepEqual(result.projections, []);
        assert.equal(result.timeline.events.length, 0);
    }
    for (const kind of ['activity', 'wait']) {
        for (const durationMinutes of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
            const result = turn(createTimeline(), 's', 0, [plan([activity(durationMinutes, { kind })])]);
            assert.equal(result.timeline.plans[0].status, 'blocked');
        }
    }
    const r = rules();
    const start = turn(createTimeline(), 's', 0, [plan([travel()])], r).timeline;
    r.route = () => ({ durationMinutes: 90.5 });
    const blocked = turn(start, 'revalidate', 90, [], r);
    assert.equal(blocked.timeline.plans[0].steps[0].remainingMinutes, 90);
    assert.deepEqual(blocked.projections, []);
});

test('context对当前rules.npcs重新验资格，归档忽略停用及缺失成员均隐藏旧事件', () => {
    const r = rules(2); r.states.n0.scene = 'present';
    const start = turn(createTimeline(), 's', 0, [plan([activity(1, { major: false })], ['n0', 'n1'])], r).timeline;
    const done = freeze(turn(start, 'd', 1, [], r).timeline);
    assert.ok(timelineContext(done, r).includes('角色0、角色1'));
    // n0 仍在场且启用，但事件文本包含的另一成员 n1 也必须保持启用。
    for (const patch of [{ archived: true }, { ignored: true }, { tracked: false }, { confirmed: false }]) {
        const current = rules(2); current.states.n0.scene = 'present';
        Object.assign(current.npcs[1], patch);
        assert.equal(timelineContext(done, freeze(current)), '');
    }
    r.npcs = [r.npcs[0]];
    assert.equal(timelineContext(done, r), '');
    delete r.npcs;
    assert.equal(timelineContext(done, r), '');
    assert.equal(done.events.length, 1);
});

test('所有输入保持不变且返回全新clone，projection与turn内记录不共享引用', () => {
    const r = rules();
    let timeline = turn(createTimeline(), 's', 0, [plan([activity(1)])], r).timeline;
    const input = { id: 'done', sources: [{ key: '1', content: '正文', role: 'user' }], deltaMinutes: 1, plans: [], feedback: [] };
    const original = structuredClone({ timeline, input, states: r.states });
    freeze(timeline); freeze(input); freeze(r);
    const result = proposeTurn(timeline, input, r);
    assert.deepEqual({ timeline, input, states: r.states }, original);
    assert.notEqual(result.timeline, timeline);
    assert.notEqual(result.timeline.plans, timeline.plans);
    result.projections[0].value = '调用方改写';
    assert.equal(result.timeline.turns.at(-1).projections[0].value, '阅读');
    result.timeline.baselineSources.push({ key: '新值' });
    assert.equal(timeline.baselineSources.length, 0);
});

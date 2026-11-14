import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { createConsoleFeatures } from '../services.js';
import { createWorldService } from '../world-service.js';
import { timelineContext } from '../timeline.js';

// 真实 service → requestChecked 队列 → timeline；模型与宿主存储完全本地化。
mock.method(globalThis, 'fetch', () => { throw new Error('世界集成测试禁止联网'); });
after(() => mock.restoreAll());
const copy = value => structuredClone(value);
const elapsed = (timeEvidence, deltaMinutes, feedback = []) => ({
    timeEvidence, deltaMinutes, timeConfidence: 0.99, timeExplicit: true, feedback,
});
const reading = (knownEventIds = [], summary = '阅读', durationMinutes = 90) => ({
    npcIds: ['qing'], goal: '按个人安排阅读', reason: '自己的日常安排', knownEventIds,
    steps: [{ kind: 'activity', locationId: 'study', durationMinutes, summary, major: false }],
});
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function fixture(t, { scene = 'away', npcLocation = 'study', playerLocation = 'garden' } = {}) {
    const sources = [{ key: 'source:baseline', role: 'assistant', content: '虚构基线：阿青在书房。' }];
    const state = {
        store: { preferences: { autoEnabled: true, autoMode: 'world', memoryEnabled: false, contextChars: 6000 } },
        world: { catalog: {
            npcs: [{ id: 'qing', name: '阿青', confirmed: true, tracked: true }],
            locations: [{ id: 'study', name: '书房', confirmed: true }, { id: 'garden', name: '花园', confirmed: true }],
            parties: [], routes: [],
        } },
        chat: { day: 8, stateRevision: 0, npcStates: { qing: {
            npcId: 'qing', scene, locationId: npcLocation, activity: '休息', locked: false,
            relationship: { note: '虚构关系，不应受时间推进影响' },
        } }, events: [], diaries: [], conversations: {} },
    };
    let identity = 'fictional-world|chat:1', turnSequence = 0, sourceSequence = 0, activeRequests = 0, maximumRequests = 0;
    const calls = [], scripted = [], commits = [], rollbacks = [], journal = new Map(), owners = new Map();
    const signature = () => JSON.stringify(sources);
    const context = {
        generateRaw: async options => {
            const expected = scripted.shift();
            assert.ok(expected, `没有为请求准备本地响应：${options.prompt}`);
            const payload = options.prompt === 'queue-blocker' ? null : JSON.parse(options.prompt);
            const task = payload === null ? 'blocker' : Array.isArray(payload.sources) ? 'analysis' : 'simulation';
            assert.equal(task, expected.task);
            calls.push({ task, payload: copy(payload), options: copy(options) });
            activeRequests++;
            maximumRequests = Math.max(maximumRequests, activeRequests);
            try {
                expected.inspect?.(payload);
                const response = await (typeof expected.response === 'function' ? expected.response(payload) : expected.response);
                return typeof response === 'string' ? response : JSON.stringify(response);
            } finally { activeRequests--; }
        },
    };
    const common = {
        data: () => state, identity: () => identity, context: () => context,
        messageSignature: signature, transcript: () => sources.map(source => source.content).join('\n'),
        npcLore: () => '虚构角色阿青，喜爱读书。', locationName: () => '书房',
        memoryApi: () => undefined, saveView: () => {}, refresh: () => {}, id: () => `turn:${++turnSequence}`,
    };
    const features = createConsoleFeatures(common);
    const rules = () => ({ ...state.world.catalog, states: state.chat.npcStates,
        player: { locationId: playerLocation }, route: () => null });
    const read = entry => entry.npcId ? state.chat.npcStates[entry.npcId][entry.field] : state.chat.day;
    const write = (entry, value) => {
        if (entry.npcId) state.chat.npcStates[entry.npcId][entry.field] = copy(value);
        else state.chat.day = value;
    };
    const fieldKey = entry => entry.npcId ? `${entry.npcId}:${entry.field}` : 'day';
    const host = {
        ...common, sources: () => sources, rules, preferences: () => state.store.preferences,
        request: features.requestChecked,
        commit: (timeline, projections) => {
            const turnId = timeline.turns.at(-1).id;
            const changes = [...projections, { field: 'day', value: timeline.baseDay + Math.floor(timeline.clockMinutes / 1440) }]
                .map(entry => ({ ...copy(entry), before: copy(read(entry)), previousOwner: owners.get(fieldKey(entry)) }));
            for (const entry of changes) { write(entry, entry.value); owners.set(fieldKey(entry), turnId); }
            journal.set(turnId, changes);
            state.chat.timeline = timeline;
            state.chat.stateRevision++;
            commits.push({ timeline: copy(timeline), projections: copy(projections) });
        },
        rollback: (turns, timeline) => {
            // 仅撤仍归本轮拥有且值未被人工覆盖的字段，简单记录宿主条件撤销结果。
            const record = { turnIds: turns.map(turn => turn.id), restored: [], conflicts: [] };
            for (const turn of [...turns].reverse()) {
                for (const entry of [...(journal.get(turn.id) || [])].reverse()) {
                    const key = fieldKey(entry);
                    if (owners.get(key) === turn.id && JSON.stringify(read(entry)) === JSON.stringify(entry.value)) {
                        write(entry, entry.before);
                        if (entry.previousOwner) owners.set(key, entry.previousOwner); else owners.delete(key);
                        record.restored.push(key);
                    } else record.conflicts.push(key);
                }
                journal.delete(turn.id);
            }
            state.chat.timeline = timeline;
            state.chat.stateRevision++;
            rollbacks.push(record);
        },
    };
    const service = createWorldService(host);
    t.after(() => { service.destroy(); features.destroy(); });
    return {
        service, features, state, sources, calls, commits, rollbacks, rules,
        expect: (task, response, inspect) => scripted.push({ task, response, inspect }),
        add: (content, role = 'assistant') => sources.push({ key: `source:${++sourceSequence}`, role, content }),
        switchIdentity: () => { identity = 'fictional-world|chat:2'; },
        assertDrained: () => { assert.equal(scripted.length, 0); assert.equal(activeRequests, 0); assert.ok(maximumRequests <= 1); },
    };
}

async function startReading(f) {
    await f.service.run();
    f.add('连续对话，没有时间变化');
    f.expect('analysis', elapsed('连续对话，没有时间变化', 0));
    f.expect('simulation', { plans: [reading()] });
    await f.service.run();
}

async function completeReading(f) {
    await startReading(f);
    f.add('过了一小时');
    f.expect('analysis', elapsed('过了一小时', 60));
    await f.service.run();
    f.add('又过了三十分钟');
    f.expect('analysis', elapsed('又过了三十分钟', 30));
    await f.service.run();
}

test('真实串行组合：基线→0创建90分钟计划→60+30完成→事件驱动下一计划→用户取消旧计划', async t => {
    const f = fixture(t), originalNpc = copy(f.state.chat.npcStates.qing);
    await f.service.run();
    assert.equal(f.calls.length, 0);
    assert.equal(f.state.chat.timeline.sourceCursor, 1);
    assert.deepEqual(f.state.chat.timeline.baselineSources, f.sources);

    f.add('连续对话，没有时间变化');
    f.expect('analysis', elapsed('连续对话，没有时间变化', 0), payload => {
        assert.deepEqual(payload.sources, [f.sources[1]], '分析只收到新增完整来源');
    });
    f.expect('simulation', { plans: [reading()] });
    await f.service.run();
    const firstPlanId = f.state.chat.timeline.plans[0].id;
    assert.equal(f.state.chat.timeline.clockMinutes, 0);
    assert.equal(f.state.chat.timeline.plans[0].steps[0].remainingMinutes, 90);
    assert.equal(f.state.chat.timeline.plans[0].status, 'active');
    assert.equal(f.state.chat.timeline.events.length, 0);
    assert.deepEqual(f.state.chat.npcStates.qing, originalNpc);

    f.add('过了一小时');
    f.expect('analysis', elapsed('过了一小时', 60));
    await f.service.run();
    assert.equal(f.state.chat.timeline.clockMinutes, 60);
    assert.equal(f.state.chat.timeline.plans[0].steps[0].remainingMinutes, 30);
    assert.equal(f.state.chat.timeline.events.length, 0);
    assert.deepEqual(f.commits.at(-1).projections, []);
    assert.deepEqual(f.state.chat.npcStates.qing, originalNpc);

    f.add('又过了三十分钟');
    f.expect('analysis', elapsed('又过了三十分钟', 30));
    await f.service.run();
    const completedEvent = f.state.chat.timeline.events[0];
    assert.equal(f.state.chat.timeline.clockMinutes, 90);
    assert.equal(f.state.chat.timeline.plans[0].status, 'completed');
    assert.equal(f.state.chat.timeline.plans[0].steps[0].remainingMinutes, 0);
    assert.equal(f.state.chat.timeline.events.length, 1);
    assert.equal(completedEvent.summary, '阿青完成了事先计划的阅读');
    assert.equal(completedEvent.planId, firstPlanId);
    assert.equal(completedEvent.clockMinutes, 90);
    assert.deepEqual(completedEvent.knownBy, ['qing']);
    assert.deepEqual(f.commits.at(-1).projections, [{ npcId: 'qing', field: 'activity', value: '阅读' }]);
    assert.deepEqual(f.state.chat.npcStates.qing, { ...originalNpc, activity: '阅读' });

    f.add('连续对话，没有时间变化');
    f.expect('analysis', elapsed('连续对话，没有时间变化', 0));
    f.expect('simulation', { plans: [reading([completedEvent.id], '休息', 60)] }, payload => {
        assert.deepEqual(payload.characters[0].knownEvents.map(event => event.id), [completedEvent.id]);
        assert.equal(payload.characters[0].state.activity, '阅读');
    });
    await f.service.run();
    const nextPlan = f.state.chat.timeline.plans[1];
    assert.deepEqual(nextPlan.knownEventIds, [completedEvent.id]);
    assert.equal(nextPlan.steps[0].remainingMinutes, 60);
    assert.equal(nextPlan.status, 'active');

    f.add('过了一小时。取消阿青的休息计划。', 'user');
    f.expect('analysis', elapsed('过了一小时', 60, [{ npcId: 'qing', action: 'cancel', evidence: '取消阿青的休息计划' }]));
    await f.service.run();
    assert.equal(f.state.chat.timeline.plans[0].status, 'completed');
    assert.equal(f.state.chat.timeline.plans[1].status, 'cancelled');
    assert.equal(f.state.chat.timeline.plans[1].steps[0].remainingMinutes, 60, '取消先于本轮时间推进');
    assert.equal(f.state.chat.timeline.events.length, 1);
    assert.equal(f.state.chat.npcStates.qing.activity, '阅读');
    assert.equal(f.state.chat.timeline.sourceCursor, f.sources.length);
    assert.equal(f.state.chat.day, 8);
    assert.deepEqual(f.calls.map(call => call.task), ['analysis', 'simulation', 'analysis', 'analysis', 'analysis', 'simulation', 'analysis']);
    f.assertDrained();
});

test('unknown时间保留pending与未消费来源，人工确认后经真实队列完成计划请求', async t => {
    const f = fixture(t);
    await f.service.run();
    f.add('他们交谈了片刻。');
    const unknown = elapsed('片刻', null);
    f.expect('analysis', unknown);
    await f.service.run();
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.chat.timeline.pending.reason, 'time_confirmation');
    assert.deepEqual(f.state.chat.timeline.pending.analysis, unknown);
    assert.deepEqual(f.state.chat.timeline.pending.deltaSources, [f.sources[1]]);
    assert.equal(f.state.chat.timeline.sourceCursor, 1);
    assert.equal(f.state.chat.timeline.clockMinutes, 0);
    assert.equal(f.commits.length, 0);
    await f.service.run();
    assert.equal(f.calls.length, 1);

    f.state.store.preferences.autoEnabled = false;
    f.expect('simulation', { plans: [reading()] });
    await f.service.confirmTime(15);
    assert.equal(f.state.chat.timeline.pending, null);
    assert.equal(f.state.chat.timeline.clockMinutes, 15);
    assert.equal(f.state.chat.timeline.sourceCursor, 2);
    assert.equal(f.state.chat.timeline.plans[0].steps[0].remainingMinutes, 90, '确认流逝时间不倒算新计划');
    assert.equal(f.commits.length, 1);
    f.assertDrained();
});

test('编辑中间回合来源时reconcile撤回依赖后缀，安全回滚activity且不再请求', async t => {
    for (const manualOverride of [false, true]) {
        await t.test(manualOverride ? '人工覆盖保留并记录冲突' : '仍属时间线的投影恢复', async t => {
            const f = fixture(t);
            await completeReading(f);
            const keptTurnId = f.state.chat.timeline.turns[0].id;
            const revokedIds = f.state.chat.timeline.turns.slice(1).map(turn => turn.id);
            if (manualOverride) { f.state.chat.npcStates.qing.activity = '人工修订活动'; f.state.chat.stateRevision++; }
            f.sources[2] = { ...f.sources[2], key: `${f.sources[2].key}:edited`, content: '过了两小时（编辑后的虚构回合）' };
            const requestsBefore = f.calls.length, sourcesBefore = copy(f.sources);
            f.service.reconcile();
            assert.deepEqual(f.rollbacks.at(-1).turnIds, revokedIds);
            assert.deepEqual(f.state.chat.timeline.turns.map(turn => turn.id), [keptTurnId]);
            assert.equal(f.state.chat.timeline.clockMinutes, 0);
            assert.equal(f.state.chat.timeline.sourceCursor, 2);
            assert.equal(f.state.chat.timeline.events.length, 0);
            assert.equal(f.state.chat.timeline.plans[0].status, 'active');
            assert.equal(f.state.chat.timeline.plans[0].steps[0].remainingMinutes, 90);
            assert.equal(f.state.chat.npcStates.qing.activity, manualOverride ? '人工修订活动' : '休息');
            assert.ok(f.rollbacks.at(-1)[manualOverride ? 'conflicts' : 'restored'].includes('qing:activity'));
            assert.match(f.state.chat.timeline.pausedReason, /正文来源/);
            f.service.reconcile();
            await f.service.run();
            assert.equal(f.rollbacks.length, 1, '同一失效来源不重复撤回');
            assert.equal(f.calls.length, requestsBefore);
            assert.deepEqual(f.sources, sourcesBefore);
            f.assertDrained();
        });
    }
});

test('requestChecked排队期间关闭自动或切换身份，世界请求出队前取消且不外发', async t => {
    for (const mode of ['disabled', 'identity']) {
        await t.test(mode, async t => {
            const f = fixture(t), gate = deferred(), started = deferred();
            await f.service.run();
            f.expect('blocker', () => { started.resolve(); return gate.promise; });
            const blocker = f.features.request('本地队列阻塞器', 'queue-blocker');
            // 切身份会连正在等待的普通请求一起判过期，立即注册拒绝处理。
            const blockerResult = blocker.then(value => ({ value }), error => ({ error }));
            await started.promise;
            f.add('过了一小时');
            const before = copy(f.state.chat);
            const running = f.service.run();
            const rejected = assert.rejects(running, /旧结果|切换|取消|变化/);
            assert.equal(f.service.busy(), true);
            assert.equal(f.calls.length, 1);
            if (mode === 'disabled') f.state.store.preferences.autoEnabled = false;
            else f.switchIdentity();
            gate.resolve('本地阻塞器完成');
            await rejected;
            const blockerOutcome = await blockerResult;
            if (mode === 'identity') assert.match(blockerOutcome.error.message, /切换/);
            else assert.equal(blockerOutcome.value, '本地阻塞器完成');
            assert.equal(f.calls.length, 1, '只有阻塞器调用，本轮analysis与simulation均未外发');
            assert.equal(f.commits.length, 0);
            assert.equal(f.service.busy(), false);
            assert.deepEqual(f.state.chat, before);
            f.assertDrained();
        });
    }
});

test('真实完成事件只有玩家知情且NPC当前同场时可通过timelineContext注入', async t => {
    for (const sameScene of [true, false]) {
        await t.test(sameScene ? '同场完成，远离后隐藏' : '远处完成，返回同场仍无玩家知情', async t => {
            const f = fixture(t, { scene: sameScene ? 'present' : 'away', playerLocation: sameScene ? 'study' : 'garden' });
            await completeReading(f);
            const event = f.state.chat.timeline.events[0];
            assert.equal(event.knownBy.includes('player'), sameScene);
            const context = timelineContext(f.state.chat.timeline, f.rules());
            if (sameScene) {
                assert.equal(context, '[90分钟] 阿青完成了事先计划的阅读');
                assert.ok(!context.includes('个人安排'));
                assert.ok(!context.includes('自己的日常安排'));
                f.state.chat.npcStates.qing.scene = 'away';
                assert.equal(timelineContext(f.state.chat.timeline, f.rules()), '');
                f.state.chat.npcStates.qing.scene = 'present';
                f.state.chat.npcStates.qing.locationId = 'garden';
                assert.equal(timelineContext(f.state.chat.timeline, f.rules()), '');
            } else {
                assert.equal(context, '');
                f.state.chat.npcStates.qing.scene = 'present';
                const nowTogether = { ...f.rules(), player: { locationId: 'study' } };
                assert.equal(timelineContext(f.state.chat.timeline, nowTogether), '', '相遇不追授旧私密事件的知情权');
            }
            f.assertDrained();
        });
    }
});

test('宿主commit以累计分钟更新legacy day，撤回同时条件恢复day与activity', async t => {
    const f = fixture(t);
    await startReading(f);
    f.add('过了一天');
    f.expect('analysis', elapsed('过了一天', 1440));
    await f.service.run();
    assert.equal(f.state.chat.timeline.clockMinutes, 1440);
    assert.equal(f.state.chat.day, 9);
    assert.equal(f.state.chat.npcStates.qing.activity, '阅读');
    const requestCount = f.calls.length;
    f.service.undoLast();
    assert.equal(f.state.chat.timeline.clockMinutes, 0);
    assert.equal(f.state.chat.day, 8);
    assert.equal(f.state.chat.npcStates.qing.activity, '休息');
    assert.deepEqual(f.rollbacks.at(-1).conflicts, []);
    assert.equal(f.calls.length, requestCount);
    f.assertDrained();
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createWorldService, parseElapsedEvidence } from '../world-service.js';

const analysis = (timeEvidence = '一小时后', deltaMinutes = 60, extra = {}) => ({ deltaMinutes,
    timeEvidence, timeConfidence: 0.99, timeExplicit: true, feedback: [], ...extra });
const plan = (npcId = 'a') => ({ npcIds: [npcId], goal: '日常', reason: '个人安排', knownEventIds: [],
    steps: [{ kind: 'activity', locationId: 'home', durationMinutes: 30, summary: '阅读' }] });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

// mock宿主只允许commit/rollback改核心状态；正文数据独立且不暴露context接口。
function fixture({ npcs = ['a'], messages = [{ key: 'old', role: 'assistant', content: '旧历史一年后。' }] } = {}) {
    const preferences = { autoMode: 'world', autoEnabled: true, contextChars: 6000 };
    const chat = { day: 8, stateRevision: 0, npcStates: Object.fromEntries(npcs.map(id => [id,
        { npcId: id, locationId: 'home', scene: 'offscreen', activity: '休息', status: 'unknown' }])) };
    const world = {}, store = { preferences }, calls = [], commits = [], rollbacks = [];
    let identity = 'world|chat', sequence = 0, responder = task => task === 'analysis' ? analysis() : { plans: [plan()] };
    const host = {
        data: () => ({ world, chat, store }), identity: () => identity,
        sources: () => messages, messageSignature: () => JSON.stringify(messages), preferences: () => preferences,
        rules: () => ({ npcs: npcs.map(id => ({ id, name: id, confirmed: true, tracked: true })), states: chat.npcStates,
            locations: [{ id: 'home', name: '家', confirmed: true }], parties: [], player: { locationId: 'unknown' }, route: () => null }),
        request: async (system, prompt, task) => { calls.push({ system, prompt: JSON.parse(prompt), task }); return responder(task); },
        commit: (timeline, projections) => {
            commits.push({ timeline, projections }); chat.timeline = timeline; chat.stateRevision++;
            for (const projection of projections) chat.npcStates[projection.npcId][projection.field] = projection.value;
        },
        rollback: (turns, timeline) => { rollbacks.push(turns); chat.timeline = timeline; chat.stateRevision++; },
        saveView: () => {}, refresh: () => {}, id: () => `turn:${++sequence}`,
        npcLore: (npc, budget) => `个人背景:${npc.id}`.slice(0, budget),
    };
    const service = createWorldService(host);
    const add = (content = '一小时后', role = 'assistant') => messages.push({ key: `source:${messages.length}`, content, role });
    return { service, host, chat, world, messages, preferences, calls, commits, rollbacks, add,
        respond: fn => { responder = fn; }, switchIdentity: () => { identity = 'other'; } };
}

test('本地时间解析支持中文阿拉伯时长，不接受片刻或估算', () => {
    for (const [evidence, minutes] of [['一小时后', 60], ['两个小时过去了', 120], ['半小时后', 30],
        ['半天过去了', 720], ['三天后', 4320], ['1小时30分钟后', 90], ['两天又三个小时', 3060],
        ['一个半小时后', 90], ['时间没有变化', 0], ['连续对话', 0]]) assert.equal(parseElapsedEvidence(evidence), minutes, evidence);
    for (const evidence of ['片刻交谈', '一会儿后', '大约一小时', '希望一小时后到', '如果三天后', '一小时后又过两小时', '八天后']) {
        assert.equal(parseElapsedEvidence(evidence), null, evidence);
    }
});

test('首次运行只建立全部历史基线，不发模型请求', async () => {
    const f = fixture(); await f.service.run();
    assert.equal(f.calls.length, 0); assert.equal(f.chat.timeline.sourceCursor, 1);
    assert.equal(f.chat.timeline.baseDay, 8); assert.equal(f.chat.timeline.clockMinutes, 0);
    assert.deepEqual(f.chat.timeline.baselineSources, f.messages);
});

test('仅发送完整新增来源；新计划轮末创建，下轮才推进且不套正文事实', async () => {
    const f = fixture(); await f.service.run();
    f.add('一小时后，a已经成为国王。');
    const before = structuredClone(f.chat.npcStates);
    await f.service.run({ sourceKey: 'batch1' });
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].task, 'analysis');
    assert.equal(f.calls[0].prompt.sources.length, 1); assert.equal(f.calls[0].prompt.sources[0].content, f.messages[1].content);
    assert.equal(f.chat.timeline.clockMinutes, 60); assert.equal(f.chat.timeline.plans[0].steps[0].remainingMinutes, 30);
    assert.deepEqual(f.chat.npcStates, before);
    f.add(); await f.service.run();
    assert.equal(f.calls.length, 3); assert.equal(f.chat.timeline.events.length, 1);
    assert.equal(f.chat.timeline.plans[0].status, 'completed');
});

test('模糊时间保存原分析；pending阻止请求，关闭auto后玩家确认仍能收尾', async () => {
    const f = fixture(); await f.service.run(); f.add('片刻交谈');
    f.respond(task => task === 'analysis' ? analysis('片刻交谈', 0) : { plans: [plan()] });
    await f.service.run();
    assert.equal(f.calls.length, 1); assert.equal(f.chat.timeline.sourceCursor, 1);
    assert.equal(f.service.snapshot().pending.analysis.timeEvidence, '片刻交谈');
    assert.equal(f.service.snapshot().pending.timeEvidence, '片刻交谈');
    await f.service.run(); assert.equal(f.calls.length, 1);
    f.preferences.autoEnabled = false;
    await f.service.confirmTime(15);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].task, 'simulation');
    assert.equal(f.chat.timeline.clockMinutes, 15); assert.equal(f.chat.timeline.pending, null);
    assert.equal(f.chat.timeline.sourceCursor, 2);
});

test('本地分钟必须和模型相符、confidence足够且证据来自增量', async () => {
    for (const result of [analysis('三天后', 60), analysis('一小时后', 60, { timeConfidence: 0.89 }),
        analysis('旧历史一年后。', 60), analysis('一小时后', '60'), analysis('', 0), analysis('片刻交谈', 0)]) {
        const f = fixture(); await f.service.run(); f.add('三天后，一小时后，片刻交谈'); f.respond(() => result);
        await f.service.run(); assert.ok(f.chat.timeline.pending); assert.equal(f.commits.length, 0);
    }
});

test('明确无时间变化可以自动采用0', async () => {
    const f = fixture(); await f.service.run(); f.add('时间没有变化，连续对话');
    f.respond(task => task === 'analysis' ? analysis('时间没有变化', 0) : { plans: [] });
    await f.service.run(); assert.equal(f.chat.timeline.clockMinutes, 0); assert.equal(f.chat.timeline.sourceCursor, 2);
});

test('超过6000字符不默默截断、没有analysis可确认', async () => {
    const f = fixture(); await f.service.run(); f.add('x'.repeat(6001)); await f.service.run();
    assert.equal(f.calls.length, 0); assert.equal(f.chat.timeline.pending.deltaSources[0].content.length, 6001);
    assert.match(f.chat.timeline.pausedReason, /6000/); assert.equal(f.chat.timeline.sourceCursor, 1);
    await assert.rejects(f.service.confirmTime(1), /没有可确认/);
});

test('确认时间严格整数且来源、版本、mode必须仍一致', async () => {
    for (const mutation of [f => { f.messages[1].content = '被编辑'; }, f => { f.chat.stateRevision++; },
        f => { f.preferences.autoMode = 'notes'; }, f => f.switchIdentity()]) {
        const f = fixture(); await f.service.run(); f.add('片刻交谈'); f.respond(() => analysis('片刻交谈', 0));
        await f.service.run(); mutation(f); await assert.rejects(f.service.confirmTime(30), /已变化/);
        assert.equal(f.commits.length, 0); assert.equal(f.calls.length, 1);
    }
    const f = fixture();
    for (const value of [-1, 10081, 1.5, '1', NaN]) await assert.rejects(f.service.confirmTime(value), RangeError);
});

test('analysis响应后身份/核心/来源/开关/守卫变化都会丢弃结果', async () => {
    for (const mutation of [f => f.switchIdentity(), f => { f.chat.stateRevision++; }, f => { f.chat.timeline.revision++; },
        f => { f.messages[1].content = 'edit'; }, f => { f.preferences.autoEnabled = false; }, f => { f.preferences.autoMode = 'notes'; }]) {
        const f = fixture(), d = deferred(); await f.service.run(); f.add(); f.respond(() => d.promise);
        const running = f.service.run(); assert.equal(f.service.snapshot().busy, true);
        mutation(f); d.resolve(analysis()); await assert.rejects(running, /旧结果/);
        assert.equal(f.calls.length, 1); assert.equal(f.commits.length, 0); assert.equal(f.chat.timeline.pending, null);
    }
    const f = fixture(), d = deferred(); await f.service.run(); f.add(); f.respond(() => d.promise);
    let allowed = true; const running = f.service.run({ isCurrent: () => allowed }); allowed = false;
    d.resolve(analysis()); await assert.rejects(running, /旧结果/); assert.equal(f.commits.length, 0);
});

test('simulation响应后旧结果同样丢弃，重复run不会并发请求', async () => {
    const f = fixture(), d = deferred(); await f.service.run(); f.add();
    f.respond(task => task === 'analysis' ? analysis() : d.promise);
    const running = f.service.run(); await Promise.resolve(); await Promise.resolve();
    await f.service.run(); assert.equal(f.calls.length, 2);
    f.preferences.autoEnabled = false; d.resolve({ plans: [plan()] });
    await assert.rejects(running, /旧结果/); assert.equal(f.commits.length, 0); assert.equal(f.service.snapshot().busy, false);
    assert.equal(f.service.busy(), false);
});

test('feedback只接受用户已发生或明确取消证据，拒绝愿望假设和assistant', async () => {
    for (const [role, evidence, accepted] of [['user', '取消a的阅读计划', true], ['assistant', '取消a的阅读计划', false],
        ['user', '希望取消a的阅读计划', false], ['user', '如果取消a的阅读计划', false], ['user', '不要取消a的阅读计划', false]]) {
        const f = fixture(); await f.service.run(); f.add(); await f.service.run();
        f.add(`一小时后。${evidence}`, role); f.respond(task => task === 'analysis'
            ? analysis('一小时后', 60, { feedback: [{ npcId: 'a', action: 'cancel', evidence }] }) : { plans: [] });
        await f.service.run(); assert.equal(f.chat.timeline.plans[0].status, accepted ? 'cancelled' : 'completed', evidence);
    }
});

test('replace反馈才补已有计划；blocked计划不会自动替换', async () => {
    const f = fixture(); await f.service.run(); f.add(); await f.service.run();
    f.chat.timeline.plans[0].status = 'blocked';
    f.add('时间没有变化'); f.respond(task => task === 'analysis' ? analysis('时间没有变化', 0) : { plans: [] });
    await f.service.run(); assert.equal(f.calls.filter(call => call.task === 'simulation').length, 1);
    f.add('时间没有变化，我已经改为新的阅读计划', 'user');
    f.respond(task => task === 'analysis' ? analysis('时间没有变化', 0, { feedback: [
        { npcId: 'a', action: 'replace', evidence: '我已经改为新的阅读计划' }] }) : { plans: [plan()] });
    await f.service.run(); assert.equal(f.calls.filter(call => call.task === 'simulation').length, 2);
    assert.equal(f.chat.timeline.plans[0].status, 'cancelled'); assert.equal(f.chat.timeline.plans.length, 2);
});

test('计划上下文按knownBy隔离私密，拒绝跨角色借用秘密的计划', async () => {
    const f = fixture({ npcs: ['a', 'b'] }); await f.service.run();
    f.chat.timeline.events.push({ id: 'secret-a', knownBy: ['a'], summary: 'a私密', npcIds: ['a'] },
        { id: 'unknown', knownBy: ['outsider'], summary: '没人可知', npcIds: ['outsider'] });
    f.add(); f.respond(task => task === 'analysis' ? analysis() : { plans: [
        { ...plan('b'), knownEventIds: ['secret-a'] }, plan('a')] });
    await f.service.run();
    const prompt = f.calls[1].prompt;
    assert.deepEqual(prompt.characters.find(item => item.npc.id === 'a').knownEvents.map(event => event.id), ['secret-a']);
    assert.equal(prompt.characters.length, 1);
    assert.equal(prompt.characters[0].npc.id, 'a');
    assert.ok(!JSON.stringify(prompt).includes('没人可知'));
    assert.deepEqual(f.chat.timeline.plans.map(item => item.npcIds), [['a']]);
    f.add(); f.respond(task => task === 'analysis' ? analysis() : { plans: [plan('b')] });
    await f.service.run();
    const next = f.calls.filter(call => call.task === 'simulation').at(-1).prompt;
    assert.deepEqual(next.characters.map(item => item.npc.id), ['b']);
    assert.deepEqual(next.characters[0].knownEvents, []);
    assert.ok(!JSON.stringify(next).includes('a私密'));
    assert.ok(!JSON.stringify(next).includes('个人背景:a'));
    assert.ok(!JSON.stringify(next).includes('secret-a'));
});

test('每轮只规划一名独立NPC并轮转，lore总预算受限', async () => {
    const f = fixture({ npcs: Array.from({ length: 8 }, (_, i) => `n${i}`) }); await f.service.run();
    f.host.npcLore = () => 'x'.repeat(5000);
    f.respond(task => task === 'analysis' ? analysis() : { plans: [] });
    f.add(); await f.service.run(); f.add(); await f.service.run();
    const prompts = f.calls.filter(call => call.task === 'simulation').map(call => call.prompt);
    assert.equal(prompts[0].characters.length, 1);
    assert.ok(prompts[0].characters.reduce((sum, item) => sum + item.npc.lore.length, 0) <= 6000);
    assert.equal(prompts[1].characters[0].npc.id, 'n1');
});

test('完整同行组只收到共同知情事件，并按组轮转', async () => {
    const f = fixture({ npcs: ['a', 'b', 'c'] });
    const originalRules = f.host.rules;
    f.host.rules = () => ({ ...originalRules(), parties: [{ confirmed: true, members: ['a', 'b'] }] });
    await f.service.run();
    f.chat.timeline.events.push({ id: 'secret', knownBy: ['a'], summary: '仅a知道秘密', npcIds: ['a'] },
        { id: 'shared', knownBy: ['a', 'b'], summary: '共同知道', npcIds: ['a', 'b'] });
    f.respond(task => task === 'analysis' ? analysis() : { plans: [] });
    f.add(); await f.service.run(); f.add(); await f.service.run();
    const prompts = f.calls.filter(call => call.task === 'simulation').map(call => call.prompt);
    assert.deepEqual(prompts[0].characters.map(item => item.npc.id), ['a', 'b']);
    assert.ok(!JSON.stringify(prompts[0]).includes('仅a知道秘密'));
    for (const character of prompts[0].characters) assert.deepEqual(character.knownEvents.map(event => event.id), ['shared']);
    assert.deepEqual(prompts[1].characters.map(item => item.npc.id), ['c']);
    assert.ok(!JSON.stringify(prompts[1]).includes('共同知道'));
});

test('不可部分规划同行组，超过6人或有非eligible成员时跳过该组', async () => {
    for (const size of [2, 7]) {
        const ids = Array.from({ length: size }, (_, i) => `member${i}`);
        const f = fixture({ npcs: [...ids, 'solo'] });
        const originalRules = f.host.rules;
        f.host.rules = () => { const rules = originalRules();
            if (size === 2) rules.npcs.find(npc => npc.id === ids[1]).ignored = true;
            return { ...rules, parties: [{ confirmed: true, members: ids }] }; };
        await f.service.run(); f.add(); f.respond(task => task === 'analysis' ? analysis() : { plans: [] });
        await f.service.run();
        assert.deepEqual(f.calls[1].prompt.characters.map(item => item.npc.id), ['solo']);
    }
});

test('拒绝时间不消费来源并暂停，不再自动请求', async () => {
    const f = fixture(); await f.service.run(); f.add('片刻交谈'); f.respond(() => analysis('片刻交谈', 0));
    await f.service.run(); f.service.rejectTime(); await f.service.run();
    assert.equal(f.chat.timeline.pending, null); assert.match(f.chat.timeline.pausedReason, /拒绝/);
    assert.equal(f.chat.timeline.sourceCursor, 1); assert.equal(f.calls.length, 1);
});

test('undo不用API，reset先撤所有投影再建立当前来源基线', async () => {
    const f = fixture(); await f.service.run(); f.add(); await f.service.run(); f.add(); await f.service.run();
    const count = f.calls.length; f.service.undoLast();
    assert.equal(f.rollbacks.at(-1).length, 1); assert.equal(f.chat.timeline.turns.length, 1);
    assert.equal(f.calls.length, count); assert.equal(f.chat.timeline.clockMinutes, 60);
    f.chat.day = 99; f.service.resetBaseline();
    assert.equal(f.rollbacks.at(-1).length, 1); assert.equal(f.chat.timeline.baseDay, 99);
    assert.equal(f.chat.timeline.turns.length, 0); assert.equal(f.chat.timeline.sourceCursor, 3);
});

test('reconcile撤首个失效turn及依赖后缀，基线改变撤全部，不自动重跑', async () => {
    for (const changedIndex of [0, 1, 2]) {
        const f = fixture(); await f.service.run(); f.add(); await f.service.run(); f.add(); await f.service.run();
        f.messages[changedIndex].key += ':edited'; const count = f.calls.length;
        f.service.reconcile(); await f.service.run();
        assert.equal(f.rollbacks.at(-1).length, changedIndex === 2 ? 1 : 2);
        assert.equal(f.chat.timeline.turns.length, changedIndex === 2 ? 1 : 0);
        assert.match(f.chat.timeline.pausedReason, /正文来源/); assert.equal(f.calls.length, count);
    }
});

test('证据子串不能绕过同句的未来、引用、否定或假设', async () => {
    for (const [content, evidence] of [['我没有等一小时', '一小时'], ['他说“一小时后见”', '一小时后'],
        ['如果一小时后见面', '一小时后'], ['准备一小时后出发', '一小时后'], ['一千分钟过去了', '一千分钟']]) {
        const f = fixture(); await f.service.run(); f.add(content); f.respond(() => analysis(evidence, 60));
        await f.service.run(); assert.ok(f.chat.timeline.pending, content); assert.equal(f.commits.length, 0);
    }
    for (const evidence of ['我没有等一小时', '他说一小时后见', '“一小时后”', '一千分钟', '一刻钟又一小时']) {
        assert.equal(parseElapsedEvidence(evidence), null, evidence);
    }
});

test('排队请求在实际发送前复查guard，destroy使在途结果失效', async () => {
    const f = fixture(); await f.service.run(); f.add();
    let queuedCheck;
    const d = deferred();
    f.host.request = async (_system, _prompt, _task, checkCurrent) => { queuedCheck = checkCurrent; return d.promise; };
    const running = f.service.run(); assert.equal(typeof queuedCheck, 'function'); assert.equal(f.service.busy(), true);
    f.service.destroy(); assert.throws(queuedCheck, /旧结果/);
    d.resolve(analysis()); await assert.rejects(running, /旧结果/);
    await f.service.run(); assert.equal(f.commits.length, 0); assert.equal(f.service.busy(), false);
});

test('同一个无效基线不会在reconcile轮询中反复rollback保存', async () => {
    const f = fixture(); await f.service.run(); f.messages[0].key = 'edited';
    f.service.reconcile(); f.service.reconcile(); await f.service.run();
    assert.equal(f.rollbacks.length, 1);
});

test('reset基线使用撤回后的日期且保留人工冲突痕迹', async () => {
    const f = fixture(); await f.service.run(); f.add(); await f.service.run();
    f.host.rollback = (_turns, next) => { f.chat.day = 3; next.pausedReason = '人工修改冲突'; f.chat.timeline = next; };
    f.service.resetBaseline(); assert.equal(f.chat.timeline.baseDay, 3);
    assert.equal(f.chat.timeline.pausedReason, ''); assert.ok(f.chat.timeline.rollbackConflicts.length);
    assert.match(f.chat.timeline.notice, /保留人工校准/);
    f.service.resetBaseline(); assert.equal(f.chat.timeline.pausedReason, '');
    f.add(); f.respond(task => task === 'analysis' ? analysis() : { plans: [] });
    await f.service.run(); assert.equal(f.chat.timeline.turns.length, 1);
});

test('feedback缩短证据不能绕过用户愿望语境', async () => {
    const f = fixture(); await f.service.run(); f.add(); await f.service.run();
    f.add('时间没有变化。我希望取消a的阅读计划', 'user');
    f.respond(task => task === 'analysis' ? analysis('时间没有变化', 0, {
        feedback: [{ npcId: 'a', action: 'cancel', evidence: '取消a的阅读计划' }] }) : { plans: [] });
    await f.service.run(); assert.equal(f.chat.timeline.plans[0].status, 'active');
});

test('snapshot是独立副本且源码没有宿主正文直接写入或生成API', async () => {
    const f = fixture(); await f.service.run(); const snapshot = f.service.snapshot(); snapshot.timeline.sourceCursor = 42;
    assert.equal(f.chat.timeline.sourceCursor, 1);
    const code = await readFile(new URL('../world-service.js', import.meta.url), 'utf8');
    assert.ok(!/host\.context\s*\(|generateRaw|sendRequest\s*\(|\.extra\s*=|ctx\.chat\s*=/.test(code));
});

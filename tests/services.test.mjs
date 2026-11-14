import assert from 'node:assert/strict';
import { test, mock, after } from 'node:test';
import { createConsoleFeatures, normalizeConsolePreferences } from '../services.js';

// 所有请求入口均由本地 host 替身提供；若误触 fetch，立即失败，禁止联网。
mock.method(globalThis, 'fetch', () => { throw new Error('回归测试禁止联网'); });
after(() => mock.restoreAll());

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(preferences = {}) {
    let identity = 'world:chat:1', saved = 0, transcript = '阿青正在庭院读书。阿青离开了玩家身边。', signature = '正文:1', nextId = 0;
    const calls = { main: [], secondary: [], constructed: [], memory: 0 };
    const state = {
        store: { preferences: {
            secondaryProfileId: 'secondary:1', maxTokens: 1234,
            routes: { analysis: 'main' }, templates: { analysis: 'STYLE_MARKER' },
            memoryEnabled: true, ...preferences,
        } },
        world: { label: '测试世界', catalog: {
            npcs: [{ id: 'npc:1', name: '阿青', confirmed: true, tracked: true }],
            locations: [{ id: 'loc:1', name: '庭院', confirmed: true }],
            routes: [{ fromId: 'loc:1', toId: 'loc:2' }],
        } },
        chat: {
            day: 2, stateRevision: 7, npcStates: { 'npc:1': { locationId: 'loc:1', activity: '读书',
                relationship: { note: '朋友' }, activityLock: { active: true } } },
            events: [{ day: 2, npcIds: ['npc:1'], summary: '在庭院读书。' }],
            diaries: [{ id: 'old', npcId: 'npc:1', day: 1, text: '旧文章' }],
            conversations: { 'npc:1': [{ role: 'assistant', content: '旧试聊' }] },
        },
    };
    const service = {
        getSupportedProfiles: () => [{ id: 'secondary:1', name: '已保存副连接' }, { id: 'secondary:2', name: '其他副连接' }],
        constructPrompt: (messages, profileId) => {
            calls.constructed.push({ messages, profileId });
            return messages;
        },
        sendRequest: async (...args) => { calls.secondary.push(args); return { content: ' OK ' }; },
    };
    const context = {
        name1: '测试玩家', ConnectionManagerRequestService: service,
        generateRaw: async options => { calls.main.push(options); return ' 主响应 '; },
    };
    const host = {
        data: () => state, identity: () => identity, context: () => context,
        refresh: () => {}, saveView: () => { saved++; }, busy: () => false,
        npcLore: () => '本地角色设定', locationName: () => '庭院', id: () => `new:${++nextId}`,
        transcript: () => transcript, messageSignature: () => signature,
        memoryApi: () => { calls.memory++; return { ext_getAllTables: () => [{ name: '记忆', data: [['人', '事'], ['阿青', 'MEMORY_MARKER']] }] }; },
    };
    return { features: createConsoleFeatures(host), host, state, context, service, calls,
        switchIdentity: () => { identity = 'world:chat:2'; }, saved: () => saved,
        setTranscript: value => { transcript = value; }, changeSignature: () => { signature = '正文:2'; } };
}

// 自动生成的模型输出完全来自本地 JSON 替身，可分别挂起分析和侧写阶段。
function automaticResponses(f, scenes = [], notes = []) {
    let request = 0;
    f.context.generateRaw = async options => {
        f.calls.main.push(options);
        return JSON.stringify(++request === 1 ? { scenes } : { notes });
    };
}
const sceneRow = (scene, evidence = '', npcId = 'npc:1') => ({ npcId, scene, evidence });
const noteRow = (kind, value = '阿青在当前庭院安静读书。', npcId = 'npc:1') => ({ npcId, kind, text: value });

const generate = (features, kind) => kind === 'diary'
    ? features.generateDiary('npc:1', 2, 300) : features.sendChat('npc:1', '你好');

test('analysis 走主 API 时，副连接测试仍强制已保存 profile，64 tokens，无模板/记忆且不改偏好', async () => {
    const f = fixture();
    const original = structuredClone(f.state.store.preferences);
    const result = await f.features.testSecondaryProfile('secondary:1');
    assert.deepEqual(result, { profileId: 'secondary:1', name: '已保存副连接', result: 'OK' });
    assert.equal(f.calls.main.length, 0);
    assert.equal(f.calls.secondary.length, 1);
    const [profileId, payload, budget, options] = f.calls.secondary[0];
    assert.equal(profileId, 'secondary:1');
    assert.equal(budget, 64);
    assert.deepEqual(payload, [{ role: 'system', content: '你是连接测试。只回复 OK。' }, { role: 'user', content: '回复 OK。' }]);
    assert.deepEqual(options, { stream: false, extractData: true, includePreset: true, includeInstruct: true });
    assert.equal(f.calls.memory, 0);
    assert.deepEqual(f.state.store.preferences, original);
    assert.equal(f.saved(), 0);
});

test('副连接异常、空响应、已删除 profile 或服务不可用均明确失败且不 fallback', async t => {
    for (const mode of ['failure', 'empty', 'deleted', 'unavailable']) {
        await t.test(mode, async () => {
            const f = fixture();
            if (mode === 'failure') f.service.sendRequest = async () => { throw new Error('副连接失败', { cause: new Error('底层原因') }); };
            if (mode === 'empty') f.service.sendRequest = async () => ({ content: '' });
            if (mode === 'deleted') f.service.getSupportedProfiles = () => [];
            if (mode === 'unavailable') delete f.service.sendRequest;
            await assert.rejects(f.features.testSecondaryProfile('secondary:1'), mode === 'failure' ? /副连接失败；底层原因/ : /未返回有效文本|不存在|不可用/);
            assert.equal(f.calls.main.length, 0);
            assert.equal(f.features.busy(), false);
            assert.equal(f.saved(), 0);
        });
    }
});

test('未保存的 profile 不发送请求', async () => {
    const f = fixture();
    for (const profileId of ['', 'secondary:2']) await assert.rejects(f.features.testSecondaryProfile(profileId), /先保存/);
    assert.equal(f.calls.main.length + f.calls.secondary.length, 0);
});

test('正常主/副请求仍继承预算、路由、模板及明确传入的记忆，内部覆盖选项不外露', async () => {
    const f = fixture();
    assert.equal(await f.features.request('系统', '正文', 'analysis', {
        memoryText: 'MEMORY_MARKER', profileId: 'secondary:2', maxTokens: 64, skipTemplate: true,
    }), '主响应');
    assert.equal(f.calls.main[0].responseLength, 1234);
    assert.match(f.calls.main[0].systemPrompt, /STYLE_MARKER/);
    assert.match(f.calls.main[0].systemPrompt, /MEMORY_MARKER/);
    f.state.store.preferences.routes.analysis = 'secondary';
    await f.features.request('系统', '正文');
    assert.equal(f.calls.secondary[0][0], 'secondary:1');
    assert.equal(f.calls.secondary[0][2], 1234);
    assert.match(f.calls.secondary[0][1][0].content, /STYLE_MARKER/);
});

test('副连接测试与正常 request 共用串行队列，测试后预算不污染正常请求', async () => {
    const f = fixture(), gate = deferred(), started = deferred();
    f.context.generateRaw = async options => { f.calls.main.push(options); started.resolve(); return gate.promise; };
    const first = f.features.request('系统', '先发');
    await started.promise;
    const probe = f.features.testSecondaryProfile('secondary:1');
    await Promise.resolve();
    assert.equal(f.calls.secondary.length, 0);
    assert.equal(f.features.busy(), true);
    gate.resolve('完成');
    await first;
    await probe;
    assert.equal(f.calls.secondary[0][2], 64);
    f.state.store.preferences.routes.analysis = 'secondary';
    await f.features.request('系统', '后发');
    assert.equal(f.calls.secondary[1][2], 1234);
    assert.equal(f.features.busy(), false);
});

test('排队期间已保存 profile 改变时拒绝旧测试，不改用新 profile', async () => {
    const f = fixture(), gate = deferred(), started = deferred();
    f.context.generateRaw = async () => { started.resolve(); return gate.promise; };
    const first = f.features.request('系统', '阻塞');
    await started.promise;
    const rejected = assert.rejects(f.features.testSecondaryProfile('secondary:1'), /已变化/);
    f.state.store.preferences.secondaryProfileId = 'secondary:2';
    gate.resolve('完成');
    await first;
    await rejected;
    assert.equal(f.calls.secondary.length, 0);
});

test('副连接测试等待或发送期间切换身份均丢弃结果，队列随后可用', async t => {
    for (const phase of ['queued', 'inflight']) await t.test(phase, async () => {
        const f = fixture(), gate = deferred(), started = deferred();
        let blocker;
        if (phase === 'queued') {
            f.context.generateRaw = async () => { started.resolve(); return gate.promise; };
            blocker = assert.rejects(f.features.request('系统', '阻塞'), /切换/);
            await started.promise;
        } else {
            f.service.sendRequest = async (...args) => { f.calls.secondary.push(args); started.resolve(); return gate.promise; };
        }
        const rejected = assert.rejects(f.features.testSecondaryProfile('secondary:1'), /切换/);
        if (phase === 'inflight') await started.promise;
        f.switchIdentity();
        gate.resolve('旧身份响应');
        if (blocker) await blocker;
        await rejected;
        assert.equal(f.calls.secondary.length, phase === 'queued' ? 0 : 1);
        assert.equal(f.saved(), 0);
        assert.equal(f.features.busy(), false);
        f.service.sendRequest = async () => 'OK';
        assert.equal((await f.features.testSecondaryProfile('secondary:1')).result, 'OK');
    });
});

for (const kind of ['diary', 'chat']) {
    for (const flag of ['archived', 'ignored']) {
        test(`${kind}: ${flag} 在调用前、排队中、响应前均阻止生成和保存，保留历史`, async t => {
            for (const phase of ['before', 'queued', 'inflight']) await t.test(phase, async () => {
                const f = fixture(), gate = deferred(), started = deferred();
                const oldDiaries = structuredClone(f.state.chat.diaries);
                const oldConversations = structuredClone(f.state.chat.conversations);
                let blocker;
                if (phase === 'before') f.state.world.catalog.npcs[0][flag] = true;
                else {
                    f.context.generateRaw = async options => {
                        f.calls.main.push(options); started.resolve(); return gate.promise;
                    };
                    if (phase === 'queued') {
                        blocker = f.features.request('系统', '阻塞');
                        await started.promise;
                    }
                }
                const rejected = assert.rejects(generate(f.features, kind), /归档或忽略/);
                if (phase === 'inflight') await started.promise;
                // 替换目录对象，验证检查的是当前 catalog，不能只检查旧 npc 引用。
                f.state.world.catalog.npcs[0] = { ...f.state.world.catalog.npcs[0], [flag]: true };
                gate.resolve('不得保存的新内容');
                if (blocker) await blocker;
                await rejected;
                assert.equal(f.calls.main.length, phase === 'before' ? 0 : 1);
                assert.deepEqual(f.state.chat.diaries, oldDiaries);
                assert.deepEqual(f.state.chat.conversations, oldConversations);
                assert.equal(f.saved(), 0);
                assert.equal(f.features.busy(), false);
            });
        });
    }
    test(`${kind}: 正常生成继承预算并保存，切身份时不保存旧结果`, async () => {
        const f = fixture();
        assert.equal(await generate(f.features, kind), '主响应');
        assert.equal(f.calls.main[0].responseLength, 1234);
        assert.equal(f.saved(), 1);
        const before = structuredClone(f.state.chat);
        const gate = deferred(), started = deferred();
        f.context.generateRaw = async () => { started.resolve(); return gate.promise; };
        const rejected = assert.rejects(generate(f.features, kind), /切换/);
        await started.promise;
        f.switchIdentity();
        gate.resolve('旧身份结果');
        await rejected;
        assert.deepEqual(f.state.chat, before);
        assert.equal(f.saved(), 1);
    });
}

test('自动偏好默认关闭、间隔默认5并限定为1..100整数，只保存白名单字段', () => {
    const defaults = normalizeConsolePreferences();
    assert.equal(defaults.autoEnabled, false);
    assert.equal(defaults.autoEveryReplies, 5);
    for (const [input, expected] of [[0, 1], [-20, 1], [1000, 100], [6.9, 6], ['8', 8], ['invalid', 5]]) {
        assert.equal(normalizeConsolePreferences({ autoEveryReplies: input }).autoEveryReplies, expected);
    }
    assert.equal(normalizeConsolePreferences({ autoEnabled: 'true' }).autoEnabled, false);
    const f = fixture();
    f.features.savePreferences({ autoEnabled: true, autoEveryReplies: 9.9, apiKey: 'NEVER_SAVE' });
    assert.equal(f.state.store.preferences.autoEnabled, true);
    assert.equal(f.state.store.preferences.autoEveryReplies, 9);
    assert.equal(f.state.store.preferences.apiKey, undefined);
});

test('profiles 空列表是成功提示，服务缺失/异常单独报告且不读取连接密钥', () => {
    const f = fixture();
    f.service.getSupportedProfiles = () => [];
    const empty = f.features.profiles();
    assert.equal(empty.profileError, '');
    assert.equal(empty.serviceError, '');
    assert.match(empty.profileMessage, /可用.*没有/);
    const profile = { id: 'secondary:1', name: '公开名', model: '公开模型' };
    for (const secret of ['apiKey', 'key', 'url', 'connection', 'secret']) {
        Object.defineProperty(profile, secret, { enumerable: true, get() { assert.fail(`不应读取 ${secret}`); } });
    }
    f.service.getSupportedProfiles = () => [profile];
    assert.deepEqual(f.features.profiles().profiles, [{ id: 'secondary:1', name: '公开名', model: '公开模型', preset: '' }]);
    delete f.context.ConnectionManagerRequestService;
    assert.match(f.features.profiles().serviceError, /未提供/);
    f.context.ConnectionManagerRequestService = { getSupportedProfiles() { throw new Error('服务异常'); } };
    assert.match(f.features.profiles().profileError, /服务异常/);
    assert.equal(f.features.profiles().profileMessage, '');
});

test('自动札记空名单、关闭、取消或空正文不请求不保存', async t => {
    for (const mode of ['disabled', 'empty', 'untracked', 'unconfirmed', 'archived', 'ignored', 'cancelled', 'noText']) {
        await t.test(mode, async () => {
            const f = fixture({ autoEnabled: mode !== 'disabled' });
            const npc = f.state.world.catalog.npcs[0];
            if (mode === 'empty') f.state.world.catalog.npcs = [];
            if (mode === 'untracked') npc.tracked = false;
            if (mode === 'unconfirmed') npc.confirmed = false;
            if (['archived', 'ignored'].includes(mode)) npc[mode] = true;
            if (mode === 'noText') f.setTranscript('  ');
            const result = await f.features.generateAutomaticNotes({ isCurrent: () => mode !== 'cancelled' });
            assert.equal(result.generated, 0);
            assert.equal(f.calls.main.length + f.calls.secondary.length, 0);
            assert.equal(f.saved(), 0);
        });
    }
});

test('自动场景保守fallback、原文证据和present/away/unknown类型边界', async t => {
    const cases = [
        { old: 'unknown', scene: 'present', evidence: '  阿青正在庭院读书。  ', kind: 'gesture', count: 1 },
        { old: 'unknown', scene: 'present', evidence: '虚构证据', kind: 'gesture', count: 0 },
        { old: 'unknown', scene: 'unknown', kind: 'gesture', count: 0 },
        { old: 'unknown', scene: 'away', evidence: '没有提到阿青', kind: 'activity', count: 0 },
        { old: 'unknown', scene: 'away', evidence: '阿青离开了玩家身边。', kind: 'activity', count: 1 },
        { old: 'away', scene: 'unknown', kind: 'activity', count: 1 },
        { old: 'present', scene: 'unknown', kind: 'psychology', count: 1 },
        { old: 'present', scene: 'away', evidence: '没有提到阿青', kind: 'activity', count: 0 },
        { old: 'present', scene: 'away', evidence: '阿青正在庭院读书。', kind: 'gesture', count: 1 },
        { old: 'present', scene: 'away', evidence: '阿青离开了玩家身边。', kind: 'activity', count: 1 },
        { old: 'present', scene: 'away', evidence: '阿青没有离开玩家身边。', kind: 'gesture', count: 1 },
        { old: 'away', scene: 'unknown', kind: 'activity', location: 'unknown', count: 0 },
        { old: 'away', scene: 'unknown', kind: 'gesture', count: 0 },
        { old: 'present', scene: 'unknown', kind: 'activity', count: 0 },
    ];
    for (const scenario of cases) await t.test(JSON.stringify(scenario), async () => {
        const f = fixture({ autoEnabled: true });
        Object.assign(f.state.chat.npcStates['npc:1'], { scene: scenario.old, locationId: scenario.location || 'loc:1' });
        f.setTranscript('阿青正在庭院读书。阿青离开了玩家身边。没有提到阿青。阿青没有离开玩家身边。');
        const before = structuredClone(f.state.chat.npcStates);
        automaticResponses(f, [sceneRow(scenario.scene, scenario.evidence)], [noteRow(scenario.kind)]);
        const result = await f.features.generateAutomaticNotes({ sourceKey: 'reply:1' });
        assert.deepEqual(result, { generated: scenario.count, skipped: 1 - scenario.count });
        assert.deepEqual(f.state.chat.npcStates, before);
        if (scenario.count) {
            assert.equal(f.state.chat.autoNotes[0].sourceKey, 'reply:1');
            assert.equal(f.state.chat.autoNotes[0].npcName, '阿青');
            assert.equal(f.state.chat.autoNotes[0].backstage, scenario.kind === 'psychology');
        }
    });
});

test('分析/侧写独立路由，札记不写ctx.chat、不改变状态事件天数，保存只用saveView', async () => {
    const f = fixture({ autoEnabled: true, routes: { analysis: 'secondary', simulation: 'main' } });
    f.state.chat.npcStates['npc:1'].scene = 'present';
    f.state.chat.travelPlans = [{ id: 'plan:existing', npcIds: ['npc:1'], status: 'paused', targetLocationId: 'loc:2' }];
    const before = structuredClone(f.state.chat), worldBefore = structuredClone(f.state.world);
    Object.defineProperty(f.context, 'chat', { get() { assert.fail('不应访问酒馆主聊天'); } });
    f.host.saveState = () => assert.fail('不应bump state');
    f.service.sendRequest = async (...args) => { f.calls.secondary.push(args); return { content: JSON.stringify({ scenes: [sceneRow('unknown')] }) }; };
    f.context.generateRaw = async options => { f.calls.main.push(options); return JSON.stringify({ notes: [noteRow('psychology')] }); };
    assert.deepEqual(await f.features.generateAutomaticNotes({ sourceKey: 'reply:2' }), { generated: 1, skipped: 0 });
    assert.equal(f.calls.secondary.length, 1);
    assert.equal(f.calls.main.length, 1);
    assert.match(f.calls.secondary[0][1][1].content, /最近正文/);
    assert.match(f.calls.main[0].systemPrompt, /100–300.*1000/);
    assert.match(f.calls.main[0].systemPrompt, /锁定.*行程/);
    assert.match(f.calls.main[0].prompt, /既有行程.*plan:existing/);
    assert.equal(f.saved(), 1);
    const { autoNotes, autoCursor, ...afterChat } = f.state.chat;
    assert.deepEqual(afterChat, before);
    assert.deepEqual(f.state.world, worldBefore);
    assert.equal(autoNotes[0].backstage, true);
    assert.equal(autoCursor, 0);
    f.host.automationStatus = () => ({ status: 'waiting', completedReplies: 2 });
    assert.deepEqual(f.features.snapshot().automation, { status: 'waiting', completedReplies: 2 });
    assert.deepEqual(f.features.snapshot().autoNotes, autoNotes);
});

test('分析和侧写响应严格过滤名单、kind、重复和1000字上限；解析异常明确失败', async t => {
    const f = fixture({ autoEnabled: true });
    f.state.chat.npcStates['npc:1'].scene = 'present';
    automaticResponses(f, [], [noteRow('gesture', '陌生角色', 'npc:other'), noteRow('other'), noteRow('activity'),
        noteRow('gesture', ' '.repeat(5)), noteRow('gesture', '字'.repeat(1001)), noteRow('gesture', '字'.repeat(1000)), noteRow('psychology')]);
    assert.deepEqual(await f.features.generateAutomaticNotes(), { generated: 1, skipped: 0 });
    assert.equal(f.state.chat.autoNotes[0].text.length, 1000);
    for (const phase of ['analysis', 'simulation']) await t.test(phase, async () => {
        const broken = fixture({ autoEnabled: true });
        broken.state.chat.npcStates['npc:1'].scene = 'present';
        let count = 0;
        broken.context.generateRaw = async () => ++count === 1 && phase === 'simulation' ? '{"scenes":[]}' : 'not JSON';
        await assert.rejects(broken.features.generateAutomaticNotes(), /JSON|Unexpected/);
        assert.equal(broken.saved(), 0);
        assert.equal(broken.state.chat.autoNotes, undefined);
    });
});

test('自动任务在排队发送前及两阶段响应后丢弃旧身份/正文/状态/关闭/资格变化/取消', async t => {
    for (const phase of ['queued', 'analysis', 'simulation', 'simulationQueued']) {
        for (const mutation of ['identity', 'signature', 'revision', 'disabled', 'archived', 'ignored', 'tracked', 'confirmed', 'chat', 'world', 'isCurrent', 'destroy']) {
            await t.test(`${phase}:${mutation}`, async () => {
                const f = fixture({ autoEnabled: true }), gate = deferred(), started = deferred();
                f.state.chat.npcStates['npc:1'].scene = 'present';
                let active = true, blocker, queuedBlocker;
                const finishBlocker = deferred(), blockerStarted = deferred();
                let count = 0;
                f.context.generateRaw = async options => {
                    f.calls.main.push(options); count++;
                    if (phase === 'queued' || (phase === 'analysis' && count === 1) || (phase === 'simulation' && count === 2)) {
                        started.resolve(); return gate.promise;
                    }
                    if (phase === 'simulationQueued' && count === 1) {
                        // 分析尚未返回时插入普通请求，侧写必须在它后面等待。
                        queuedBlocker = f.features.request('阻塞', '阻塞');
                        return '{"scenes":[]}';
                    }
                    if (phase === 'simulationQueued' && count === 2) { blockerStarted.resolve(); return finishBlocker.promise; }
                    return count === 1 ? '{"scenes":[]}' : '{"notes":[]}';
                };
                if (phase === 'queued') { blocker = f.features.request('阻塞', '阻塞').catch(() => {}); await started.promise; }
                const pending = f.features.generateAutomaticNotes({ isCurrent: () => active });
                if (phase === 'simulationQueued') await blockerStarted.promise;
                else if (phase !== 'queued') await started.promise;
                if (mutation === 'identity') f.switchIdentity();
                if (mutation === 'signature') f.changeSignature();
                if (mutation === 'revision') f.state.chat.stateRevision++;
                if (mutation === 'disabled') f.state.store.preferences.autoEnabled = false;
                if (mutation === 'archived' || mutation === 'ignored') f.state.world.catalog.npcs[0] = { ...f.state.world.catalog.npcs[0], [mutation]: true };
                if (mutation === 'tracked' || mutation === 'confirmed') f.state.world.catalog.npcs[0][mutation] = false;
                if (mutation === 'chat') f.state.chat = structuredClone(f.state.chat);
                if (mutation === 'world') f.state.world = structuredClone(f.state.world);
                if (mutation === 'isCurrent') active = false;
                if (mutation === 'destroy') f.features.destroy();
                gate.resolve(phase === 'simulation' ? '{"notes":[{"npcId":"npc:1","kind":"gesture","text":"旧内容"}]}' : '{"scenes":[]}');
                finishBlocker.resolve('完成');
                if (blocker) await blocker;
                if (queuedBlocker) await queuedBlocker.catch(() => {});
                assert.deepEqual(await pending, { generated: 0, skipped: 1 });
                assert.equal(f.state.chat.autoNotes, undefined);
                assert.equal(f.state.chat.autoCursor, undefined);
                assert.equal(f.saved(), 0);
                assert.equal(f.calls.main.length, phase === 'simulation' || phase === 'simulationQueued' ? 2 : 1);
                assert.equal(f.features.busy(), false);
            });
        }
    }
});

test('每批最多6人按autoCursor轮转，札记只保留40条；全unknown也轮转且不发第二请求', async () => {
    const f = fixture({ autoEnabled: true });
    f.state.world.catalog.npcs = Array.from({ length: 8 }, (_, i) => ({ id: `npc:${i + 1}`, name: `角色${i + 1}`, tracked: true, confirmed: true }));
    f.state.chat.npcStates = Object.fromEntries(f.state.world.catalog.npcs.map(npc => [npc.id, { scene: 'present', locationId: 'loc:1' }]));
    f.state.chat.autoNotes = Array.from({ length: 39 }, (_, i) => ({ id: `old:${i}` }));
    const batches = [];
    f.context.generateRaw = async options => {
        f.calls.main.push(options);
        if (options.prompt.includes('名单及已有已确认场景：')) {
            const roster = JSON.parse(options.prompt.split('\n')[0].split('：')[1]);
            batches.push(roster.map(npc => npc.npcId));
            return '{"scenes":[]}';
        }
        return JSON.stringify({ notes: batches.at(-1).map(id => noteRow('gesture', '当前小动作', id)) });
    };
    assert.deepEqual(await f.features.generateAutomaticNotes(), { generated: 6, skipped: 0 });
    assert.equal(f.state.chat.autoCursor, 6);
    assert.deepEqual(await f.features.generateAutomaticNotes(), { generated: 6, skipped: 0 });
    assert.equal(f.state.chat.autoCursor, 4);
    assert.deepEqual(batches, [['npc:1', 'npc:2', 'npc:3', 'npc:4', 'npc:5', 'npc:6'], ['npc:7', 'npc:8', 'npc:1', 'npc:2', 'npc:3', 'npc:4']]);
    assert.equal(f.state.chat.autoNotes.length, 40);
    assert.equal(f.state.chat.autoNotes[0].id, 'old:11');
    for (const npc of f.state.world.catalog.npcs) f.state.chat.npcStates[npc.id].scene = 'unknown';
    const beforeCalls = f.calls.main.length;
    assert.deepEqual(await f.features.generateAutomaticNotes(), { generated: 0, skipped: 6 });
    assert.equal(f.calls.main.length - beforeCalls, 1);
    assert.equal(f.state.chat.autoCursor, 2);
});

test('snapshot 分离活跃/归档/忽略 NPC，保留全部原字段及可读历史', () => {
    const f = fixture();
    const before = f.features.snapshot();
    f.state.world.catalog.npcs.push(
        { id: 'npc:archived', name: '归档联系人', archived: true, ignored: false, archivedAt: 123 },
        { id: 'npc:ignored', name: '忽略联系人', ignored: true, tracked: true },
    );
    const snapshot = f.features.snapshot();
    assert.deepEqual(snapshot.npcs, before.npcs);
    assert.deepEqual(snapshot.archivedNpcs.map(({ id, name, archived, ignored, archivedAt }) => ({ id, name, archived, ignored, archivedAt })), [
        { id: 'npc:archived', name: '归档联系人', archived: true, ignored: false, archivedAt: 123 },
        { id: 'npc:ignored', name: '忽略联系人', archived: false, ignored: true, archivedAt: undefined },
    ]);
    for (const key of Object.keys(before).filter(key => key !== 'archivedNpcs')) assert.deepEqual(snapshot[key], before[key], key);
    assert.deepEqual(Object.keys(snapshot).sort(), [
        'identity', 'worldLabel', 'day', 'playerName', 'npcs', 'archivedNpcs', 'locations', 'routes',
        'events', 'diaries', 'conversations', 'preferences', 'profiles', 'profileError', 'profileMessage', 'serviceError',
        'memory', 'mapImage', 'busy', 'autoNotes', 'automation', 'timeline',
    ].sort());
    f.state.world.catalog.npcs[0].archived = true;
    const archived = f.features.snapshot();
    assert.deepEqual(archived.npcs, []);
    assert.equal(archived.archivedNpcs[0].id, 'npc:1');
    assert.equal(archived.archivedNpcs[0].locationId, 'loc:1');
    assert.equal(archived.archivedNpcs[0].relationship, '朋友');
    assert.equal(archived.archivedNpcs[0].locked, true);
    assert.deepEqual(archived.diaries, before.diaries);
    assert.deepEqual(archived.conversations, before.conversations);
});

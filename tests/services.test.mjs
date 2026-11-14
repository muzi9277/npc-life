import assert from 'node:assert/strict';
import { test, mock, after } from 'node:test';
import { createConsoleFeatures } from '../services.js';

// 所有请求入口均由本地 host 替身提供；若误触 fetch，立即失败，禁止联网。
mock.method(globalThis, 'fetch', () => { throw new Error('回归测试禁止联网'); });
after(() => mock.restoreAll());

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(preferences = {}) {
    let identity = 'world:chat:1', saved = 0;
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
            day: 2, npcStates: { 'npc:1': { locationId: 'loc:1', activity: '读书',
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
        npcLore: () => '本地角色设定', locationName: () => '庭院', id: () => 'new',
        memoryApi: () => { calls.memory++; return { ext_getAllTables: () => [{ name: '记忆', data: [['人', '事'], ['阿青', 'MEMORY_MARKER']] }] }; },
    };
    return { features: createConsoleFeatures(host), state, context, service, calls,
        switchIdentity: () => { identity = 'world:chat:2'; }, saved: () => saved };
}

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
        'events', 'diaries', 'conversations', 'preferences', 'profiles', 'profileError', 'memory', 'mapImage', 'busy',
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

import assert from 'node:assert/strict';
import { test, mock, after } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
    createConsoleFeatures, normalizeConsolePreferences, readMemoryTables,
    selectMemoryRows, writePublicMemory, generateRawWithBudget, resolveMemoryApi,
} from '../services.js';

mock.method(globalThis, 'fetch', () => { throw new Error('回归测试禁止联网'); });
after(() => mock.restoreAll());

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(preferences = {}) {
    let identity = 'world:chat:1', saved = 0;
    const calls = { main: [], hooks: [] };
    const bus = new EventEmitter();
    const state = {
        store: { preferences: { memoryEnabled: true, maxTokens: 1234, templates: { analysis: 'STYLE_MARKER' }, ...preferences } },
        world: { label: '测试世界', catalog: { npcs: [{ id: 'npc:1', name: '阿青', tracked: true, entityType: 'person' }], locations: [], routes: [] } },
        chat: { day: 2, stateRevision: 7, npcStates: { 'npc:1': { locationId: 'loc:1', activity: '读书', scene: 'present' } }, events: [], autoNotes: [] },
    };
    const context = {
        name1: '测试玩家', main_api: 'openai',
        eventSource: bus,
        event_types: { CHAT_COMPLETION_SETTINGS_READY: 'chat-ready', TEXT_COMPLETION_SETTINGS_READY: 'text-ready' },
        generateRaw: async options => {
            calls.main.push(options);
            const payload = { messages: [{ role: 'system', content: options.systemPrompt }, { role: 'user', content: options.prompt }], max_tokens: 20 };
            bus.emit('chat-ready', payload);
            calls.hooks.push(payload);
            return ' 主响应 ';
        },
    };
    const tables = [{ name: '记忆', data: [['人', '事'], ['阿青', 'MEMORY_MARKER'], ['路人', '无关']] }];
    const host = {
        data: () => state, identity: () => identity, context: () => context,
        refresh: () => {}, saveView: () => { saved++; }, busy: () => false,
        npcLore: () => '本地角色设定', locationName: () => '庭院',
        memoryApi: () => ({ ext_getAllTables: () => tables }),
    };
    return { features: createConsoleFeatures(host), host, state, context, bus, calls, tables,
        switchIdentity: () => { identity = 'world:chat:2'; }, saved: () => saved };
}

test('偏好默认走同步世界、每轮结算、侧写关闭；旧间隔与关闭状态保留', () => {
    const fresh = normalizeConsolePreferences({});
    assert.equal(fresh.autoMode, 'world');
    assert.equal(fresh.autoEnabled, true);
    assert.equal(fresh.autoEveryReplies, 1);
    assert.equal(fresh.autoNotesEnabled, false);
    assert.equal(fresh.memoryEnabled, false);
    assert.equal(fresh.worldBookMaxEntries, 24);
    assert.equal(fresh.worldBookMaxTurns, 8);
    assert.equal(fresh.encounterProbability, 0.08);
    assert.equal(fresh.encounterMaxPerTurn, 1);
    assert.ok(!Object.hasOwn(fresh, 'defaultSyncMinutes'));
    assert.ok(!Object.hasOwn(fresh, 'secondaryProfileId'));
    assert.ok(!Object.hasOwn(fresh, 'diaryChars'));
    const kept = normalizeConsolePreferences({ autoEnabled: false, autoEveryReplies: 5, autoMode: 'notes', autoNotesEnabled: true, password: 'secret' });
    assert.equal(kept.autoEnabled, false);
    assert.equal(kept.autoEveryReplies, 5);
    assert.equal(kept.autoMode, 'notes');
    assert.equal(kept.autoNotesEnabled, true);
    assert.ok(!Object.hasOwn(kept, 'password'));
});

test('主 API 使用 generateRaw，并在载荷事件中写入本次 max_tokens', async () => {
    const f = fixture();
    const result = await f.features.request('系统说明', '用户提示', 'analysis', { memoryText: 'MEMORY_MARKER' });
    assert.equal(result, '主响应');
    assert.equal(f.calls.main.length, 1);
    assert.match(f.calls.main[0].systemPrompt, /\[npc-life:/);
    assert.equal(f.calls.main[0].prompt, '用户提示');
    assert.match(f.calls.main[0].systemPrompt, /MEMORY_MARKER/);
    assert.match(f.calls.main[0].systemPrompt, /STYLE_MARKER/);
    assert.equal(f.calls.main[0].responseLength, 1234);
    assert.equal(f.calls.hooks[0].max_tokens, 1234);
    assert.equal(f.context.generateQuietPrompt, undefined);
});

test('未提供事件总线时仍调用 generateRaw，不因钩子缺失而失败', async () => {
    const ctx = { generateRaw: async options => options.systemPrompt + '\n' + options.prompt };
    const result = await generateRawWithBudget(ctx, { system: 's', prompt: 'p', maxTokens: 99 });
    assert.match(result, /\[npc-life:/);
    assert.match(result, /\ns\np$/);
});

test('记忆读取按关键词筛选；写回默认关闭且不调用任何写入接口；缺失插件时优雅降级', () => {
    const tables = [{ name: '记忆', data: [['人', '事'], ['阿青', 'MEMORY_MARKER'], ['路人', '无关']] }];
    const selected = selectMemoryRows(tables, ['阿青'], 400);
    assert.match(selected, /MEMORY_MARKER/);
    assert.ok(!selected.includes('无关'));
    const missing = readMemoryTables(null);
    assert.equal(missing.available, false);
    assert.equal(missing.tables.length, 0);
    const readable = readMemoryTables({ ext_getAllTables: () => tables });
    assert.equal(readable.available, true);
    assert.equal(readable.tables.length, 1);
    const skipped = writePublicMemory(null, [{ name: '阿青', summary: '完成了阅读' }]);
    assert.equal(skipped.written, false);
    const appended = [];
    const written = writePublicMemory({ ext_appendRows: (table, rows) => { appended.push({ table, rows }); } }, [{ name: '阿青', summary: '完成了阅读' }]);
    assert.equal(written.written, false);
    assert.equal(written.method, '');
    assert.deepEqual(appended, []);
    const broken = writePublicMemory({ ext_appendRows: () => { throw new Error('插件内部错误'); } }, [['阿青', '完成了阅读']]);
    assert.equal(broken.written, false);
    assert.doesNotMatch(broken.reason, /插件内部错误/);
    assert.equal(resolveMemoryApi(null), null);
});

test('requestChecked 在切换身份后丢弃结果，队列随后仍可用', async () => {
    const f = fixture();
    const gate = deferred();
    const original = f.context.generateRaw;
    f.context.generateRaw = async options => {
        const payload = { messages: [{ role: 'system', content: options.systemPrompt }, { role: 'user', content: options.prompt }], max_tokens: 20 };
        f.bus.emit('chat-ready', payload);
        await gate.promise;
        return original(options);
    };
    const running = f.features.requestChecked('系统', '第一轮', 'analysis', () => {
        if (f.host.identity() !== 'world:chat:1') throw new Error('世界或正文已变化，本次旧结果已丢弃。');
    });
    f.switchIdentity();
    gate.resolve();
    await assert.rejects(running, /变化|切换/);
    const later = await f.features.request('系统', '第二轮', 'analysis');
    assert.equal(later, '主响应');
});

test('自动侧写默认不运行；显式打开后才生成且不标为正史', async () => {
    const f = fixture();
    assert.deepEqual(await f.features.generateAutomaticNotes(), { generated: 0, skipped: 0 });
    assert.equal(f.calls.main.length, 0);
    f.features.savePreferences({ autoNotesEnabled: true });
    let request = 0;
    f.context.generateRaw = async options => {
        f.calls.main.push(options);
        const payload = { messages: [{ role: 'system', content: options.systemPrompt }, { role: 'user', content: options.prompt }], max_tokens: 20 };
        f.bus.emit('chat-ready', payload);
        return JSON.stringify(++request === 1
            ? { scenes: [{ npcId: 'npc:1', scene: 'present', evidence: '阿青正在庭院读书' }] }
            : { notes: [{ npcId: 'npc:1', kind: 'activity', text: '阿青在庭院安静读书。' }] });
    };
    f.host.transcript = () => '阿青正在庭院读书。';
    f.host.messageSignature = () => '正文:1';
    f.host.id = () => 'note:1';
    const result = await f.features.generateAutomaticNotes({ sourceKey: 'reply:1' });
    assert.equal(result.generated, 1);
    assert.equal(f.state.chat.autoNotes[0].canon, false);
    assert.equal(f.state.chat.autoNotes[0].text, '阿青在庭院安静读书。');
});

test('源码不再包含副 API、试聊、日记或 generateQuietPrompt', async () => {
    const source = await readFile(new URL('../services.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /generateQuietPrompt/);
    assert.doesNotMatch(source, /testSecondaryProfile/);
    assert.doesNotMatch(source, /generateDiary/);
    assert.doesNotMatch(source, /sendChat/);
    assert.doesNotMatch(source, /importMap/);
    assert.doesNotMatch(source, /secondaryProfileId/);
    assert.match(source, /generateRawWithBudget/);
    assert.match(source, /writePublicMemory/);
    assert.doesNotMatch(source, /target\.ext_appendRows|target\.addMemory/);
    assert.match(source, /不得覆盖当前已确认状态/);
});

test('snapshot 只列出已追踪人物，资料名单独存放', () => {
    const f = fixture();
    f.state.world.catalog.npcs.push({ id: 'npc:2', name: '资料角色', tracked: false, entityType: 'person' });
    const snap = f.features.snapshot();
    assert.deepEqual(snap.npcs.map(npc => npc.id), ['npc:1']);
    assert.deepEqual(snap.sourceNames.map(npc => npc.id), ['npc:2']);
    assert.equal(snap.preferences.autoMode, 'world');
});

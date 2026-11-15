import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, mock, after } from 'node:test';
import { createAutomationScheduler } from '../automation.js';
import { createConsoleFeatures } from '../services.js';

// 集成测试只连接真实调度器与业务层；所有模型调用都是本地替身，禁止联网。
mock.method(globalThis, 'fetch', () => { throw new Error('集成测试禁止联网'); });
after(() => mock.restoreAll());
const events = Object.fromEntries(['CHARACTER_MESSAGE_RENDERED', 'GENERATION_STARTED', 'GENERATION_ENDED',
    'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED']
    .map(name => [name, name.toLowerCase()]));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture({ enabled = true, replaceAfterAnalysis = false } = {}) {
    const bus = new EventEmitter(), requests = [], runs = [], results = [], quietEvents = [];
    const state = {
        store: { preferences: { autoEnabled: enabled, autoEveryReplies: 1, memoryEnabled: false, autoNotesEnabled: true, autoMode: 'notes' } },
        world: { label: '集成世界', catalog: {
            npcs: [{ id: 'npc:1', name: '阿青', tracked: true, confirmed: true }],
            locations: [{ id: 'loc:1', name: '庭院', confirmed: true }], routes: [],
        } },
        chat: { day: 3, stateRevision: 7, npcStates: { 'npc:1': {
            scene: 'present', locationId: 'loc:1', activity: '读书', locked: true,
        } }, events: [], diaries: [], conversations: {} },
    };
    const context = { chat: [], eventSource: bus, eventTypes: events };
    let featureSaves = 0, schedulerSaves = 0, sequence = 0, scheduler;
    const emit = (name, ...args) => bus.emit(events[name], ...args);
    const reply = value => {
        emit('GENERATION_STARTED', 'normal', {}, false);
        context.chat.push({ is_user: false, is_system: false, mes: value, extra: { untouched: true } });
        emit('CHARACTER_MESSAGE_RENDERED', context.chat.length - 1, 'normal');
        emit('GENERATION_ENDED', context.chat.length);
    };
    const features = createConsoleFeatures({
        data: () => state, identity: () => 'world|chat:1', context: () => context,
        transcript: () => context.chat.map(item => item.mes).join('\n'),
        messageSignature: () => JSON.stringify(context.chat.map(item => item.mes)),
        npcLore: () => '阿青安静好学。', locationName: () => '庭院', memoryApi: () => undefined,
        id: () => `note:${++sequence}`, saveView: () => { featureSaves++; },
        saveState: () => assert.fail('自动侧写不得保存世界状态'),
        refresh: () => {}, busy: () => false, automationStatus: () => scheduler.status(),
    });
    // 模拟宿主 generateRaw 的 quiet 生命周期，让真实调度器观察插件自身的两个生成请求。
    context.generateRaw = async options => {
        requests.push(options);
        quietEvents.push('started'); emit('GENERATION_STARTED', 'quiet', {}, false);
        await Promise.resolve();
        const response = requests.length === 1
            ? JSON.stringify({ scenes: [{ npcId: 'npc:1', scene: 'present', evidence: '阿青坐在庭院读书。' }] })
            : JSON.stringify({ notes: [{ npcId: 'npc:1', kind: 'psychology', text: '阿青把注意力放在眼前的书页上，心绪安静。' }] });
        quietEvents.push('ended'); emit('GENERATION_ENDED', context.chat.length);
        if (replaceAfterAnalysis && requests.length === 1) reply('新的主正文：阿青仍坐在庭院。');
        return response;
    };
    scheduler = createAutomationScheduler({
        data: () => state, identity: () => 'world|chat:1', context: () => context,
        preferences: () => state.store.preferences, isBusy: () => features.busy(),
        setEnabled: value => { state.store.preferences.autoEnabled = value; },
        save: () => { schedulerSaves++; }, refresh: () => {},
        run: async options => {
            runs.push(options);
            const result = await features.generateAutomaticNotes(options);
            results.push(result);
        },
    });
    return { state, context, features, scheduler, requests, runs, results, quietEvents, reply,
        featureSaves: () => featureSaves, schedulerSaves: () => schedulerSaves };
}

test('新主回复触发真实scheduler→features两阶段API，quiet事件不递归，札记独立保存', async t => {
    const f = fixture();
    t.after(() => { f.scheduler.destroy(); f.features.destroy(); });
    const { autoCounter: initialCounter, ...beforeState } = structuredClone(f.state.chat);
    assert.deepEqual(initialCounter, { count: 0 });
    f.reply('阿青坐在庭院读书。');
    const mainChat = structuredClone(f.context.chat);
    await flush();
    assert.equal(f.requests.length, 0, '事件回调不能直接请求');
    f.scheduler.tick(); await flush();
    assert.equal(f.requests.length, 2);
    assert.equal(f.runs.length, 1);
    assert.deepEqual(f.results, [{ generated: 1, skipped: 0 }]);
    assert.deepEqual(f.quietEvents, ['started', 'ended', 'started', 'ended']);
    assert.equal(f.featureSaves(), 1);
    assert.equal(f.schedulerSaves(), 1);
    assert.equal(f.state.chat.autoNotes[0].npcId, 'npc:1');
    assert.equal(f.state.chat.autoNotes[0].backstage, true);
    assert.equal(f.state.chat.autoNotes[0].sourceKey, f.runs[0].sourceKey);
    assert.deepEqual(f.context.chat, mainChat);
    const { autoNotes, autoCursor, autoCounter, ...preserved } = f.state.chat;
    assert.deepEqual(preserved, beforeState);
    for (let i = 0; i < 3; i++) { f.scheduler.tick(); await flush(); }
    assert.equal(f.requests.length, 2, 'quiet生命周期不能产生递归任务');
    assert.equal(f.scheduler.status().status, 'idle');
});

test('自动关闭时主回复不启动scheduler或features请求', async t => {
    const f = fixture({ enabled: false });
    t.after(() => { f.scheduler.destroy(); f.features.destroy(); });
    f.reply('阿青坐在庭院读书。');
    await flush(); f.scheduler.tick(); await flush();
    assert.equal(f.requests.length, 0);
    assert.equal(f.runs.length, 0);
    assert.equal(f.state.chat.autoNotes, undefined);
    assert.equal(f.featureSaves(), 0);
    assert.equal(f.scheduler.status().status, 'disabled');
});

test('分析响应后侧写前到达新主正文，真实scheduler守卫使旧批次丢弃且不发第二API', async t => {
    const f = fixture({ replaceAfterAnalysis: true });
    t.after(() => { f.scheduler.destroy(); f.features.destroy(); });
    f.reply('阿青坐在庭院读书。');
    await flush(); f.scheduler.tick(); await flush();
    assert.equal(f.context.chat.length, 2);
    assert.equal(f.requests.length, 1);
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].isCurrent(), false);
    assert.deepEqual(f.results, [{ generated: 0, skipped: 1 }]);
    assert.equal(f.state.chat.autoNotes, undefined);
    assert.equal(f.featureSaves(), 0);
    assert.equal(f.scheduler.status().error, '');
    assert.equal(f.scheduler.status().pending, true, '新主正文合并为下一次tick的独立任务');
    assert.equal(f.state.chat.day, 3);
    assert.equal(f.state.chat.stateRevision, 7);
});

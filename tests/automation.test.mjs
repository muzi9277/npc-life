import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAutomationScheduler } from '../automation.js';

// 便携替身只实现真实事件总线使用的 on/removeListener/emit，无 DOM、网络或真实 API。
class EventBus {
    listeners = new Map();
    on(name, handler) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(handler);
    }
    removeListener(name, handler) { this.listeners.get(name)?.delete(handler); }
    async emit(name, ...args) {
        for (const handler of [...(this.listeners.get(name) || [])]) await handler(...args);
    }
    size() { return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0); }
}
const EVENTS = Object.fromEntries(['CHARACTER_MESSAGE_RENDERED', 'GENERATION_STARTED', 'GENERATION_ENDED',
    'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED']
    .map(name => [name, name === 'CHAT_CHANGED' ? 'chat_id_changed' : name.toLowerCase()]));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// 每个用例独立持有宿主正文与扩展聊天存档，偏好故意返回副本以检验 pause 契约。
function fixture({ autoEnabled = true, autoEveryReplies = 1, messages = [], count = 0, alias = false, missing = '' } = {}) {
    const bus = new EventBus(), preferences = { autoEnabled, autoEveryReplies };
    const types = { ...EVENTS }; delete types[missing];
    const context = { chat: structuredClone(messages), eventSource: bus, [alias ? 'event_types' : 'eventTypes']: types };
    let data = { chat: { autoCounter: { count, custom: '保留扩展字段' } } }, identity = 'world|chat:1', busy = false;
    let saves = 0, refreshes = 0, runImpl = async () => {}, active = 0, maxActive = 0;
    const runs = [];
    const host = {
        context: () => context, data: () => data, identity: () => identity,
        preferences: () => ({ ...preferences }), isBusy: () => busy,
        setEnabled: value => { preferences.autoEnabled = value; },
        run: async options => {
            runs.push(options); active++; maxActive = Math.max(maxActive, active);
            try { await runImpl(options); } finally { active--; }
        },
        save: () => { saves++; }, refresh: () => { refreshes++; },
    };
    const scheduler = createAutomationScheduler(host);
    const emit = (name, ...args) => bus.emit(EVENTS[name], ...args);
    const render = async (type = 'normal', value = {}) => {
        context.chat.push({ is_user: false, is_system: false, mes: '新正文', ...value });
        await emit('CHARACTER_MESSAGE_RENDERED', context.chat.length - 1, type);
    };
    const pump = async () => { scheduler.tick(); await flush(); };
    return { scheduler, host, bus, context, preferences, emit, render, pump, runs,
        data: () => data, saves: () => saves, refreshes: () => refreshes, maxActive: () => maxActive,
        setBusy: value => { busy = value; }, runWith: fn => { runImpl = fn; },
        switchChat: (name, state = { autoCounter: { count: 0 } }, oldMessages = []) => {
            identity = name; data = { chat: state }; context.chat = structuredClone(oldMessages);
        },
    };
}

test('正文仅计一次，回调/microtask 不启动请求，只有 tick 启动且不改 extra', async () => {
    const f = fixture(), extra = { plugin: { private: true } };
    await f.render('normal', { extra });
    assert.equal(f.runs.length, 0);
    await f.emit('CHARACTER_MESSAGE_RENDERED', 0, 'normal');
    assert.equal(f.saves(), 1);
    assert.equal(f.data().chat.autoCounter.custom, '保留扩展字段');
    await f.pump();
    assert.equal(f.runs.length, 1);
    assert.equal(typeof f.runs[0].sourceKey, 'string');
    assert.equal(f.runs[0].isCurrent(), true);
    assert.deepEqual(f.context.chat[0].extra, extra);
    await f.pump(); assert.equal(f.runs.length, 1);
});

test('默认关闭；关闭期间新正文和开启时历史不补计，开启后的新槽才计数', async () => {
    const f = fixture({ autoEnabled: undefined });
    delete f.preferences.autoEnabled;
    f.scheduler.tick(); assert.equal(f.scheduler.status().enabled, false);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 0);
    f.preferences.autoEnabled = true; await f.pump();
    await f.emit('CHARACTER_MESSAGE_RENDERED', 0, 'normal');
    await f.pump(); assert.equal(f.runs.length, 0);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 1);
});

test('挂载/刷新保留余数，现有 chat 含首条消息不补历史', async () => {
    const f = fixture({ messages: [{ mes: '已有消息' }], count: 2, autoEveryReplies: 3 });
    await f.emit('CHARACTER_MESSAGE_RENDERED', 0, 'first_message');
    await f.emit('CHARACTER_MESSAGE_RENDERED', 0, undefined);
    await f.pump(); assert.equal(f.runs.length, 0); assert.equal(f.scheduler.status().count, 2);
    f.scheduler.destroy();
    f.scheduler = createAutomationScheduler(f.host);
    await f.emit('CHARACTER_MESSAGE_RENDERED', 0, 'normal');
    f.scheduler.tick(); await flush(); assert.equal(f.runs.length, 0);
    await f.render(); f.scheduler.tick(); await flush(); assert.equal(f.runs.length, 1);
});

test('允许 normal/undefined，排除 user/system/空白以及其他生成类型', async t => {
    for (const [type, value] of [
        ['normal', { is_user: true }], ['normal', { is_system: true }], ['normal', { mes: '  ' }],
        ['normal', { mes: '' }], ['first_message', {}], ['swipe', {}], ['continue', {}],
        ['regenerate', {}], ['quiet', {}], ['impersonate', {}], [null, {}],
    ]) await t.test(`${String(type)} ${JSON.stringify(value)}`, async () => {
        const f = fixture(); await f.render(type, value); await f.pump();
        assert.equal(f.runs.length, 0); assert.equal(f.scheduler.status().count, 0);
        await f.emit('CHARACTER_MESSAGE_RENDERED', 0, 'normal'); await f.pump();
        assert.equal(f.runs.length, 0);
    });
    const f = fixture(); f.context.chat.push({ mes: '无类型正文' });
    await f.emit('CHARACTER_MESSAGE_RENDERED', 0); await f.pump(); assert.equal(f.runs.length, 1);
});

test('按 N 回复持久计数和余数，阈值期间多个回复只合并一个任务', async () => {
    const f = fixture({ autoEveryReplies: 3 });
    for (let i = 0; i < 2; i++) { await f.render(); await f.pump(); }
    assert.equal(f.runs.length, 0); assert.equal(f.scheduler.status().count, 2);
    for (let i = 0; i < 5; i++) await f.render();
    assert.equal(f.scheduler.status().count, 1); assert.equal(f.scheduler.status().pending, true);
    await f.pump(); assert.equal(f.runs.length, 1); assert.equal(f.saves(), 7);
});

test('编辑、swipe、updated、delete 均取消在途结果与 pending，删除后同槽保守不计', async t => {
    for (const event of ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED']) {
        await t.test(event, async () => {
            const f = fixture(), gate = deferred(); f.runWith(() => gate.promise);
            await f.render(); await f.pump(); assert.equal(f.runs[0].isCurrent(), true);
            if (event === 'MESSAGE_DELETED') f.context.chat.pop();
            await f.emit(event, event === 'MESSAGE_DELETED' ? 0 : 0);
            assert.equal(f.runs[0].isCurrent(), false); assert.equal(f.scheduler.status().pending, false);
            if (event === 'MESSAGE_DELETED') {
                await f.render(); await f.pump(); assert.equal(f.saves(), 1);
            }
            gate.resolve(); await flush(); await f.pump(); assert.equal(f.runs.length, 1);
        });
    }
});

test('regenerate 删除并重建对象不能绕过槽位高水位，未来新槽仍可计数', async () => {
    const f = fixture({ messages: [{ mes: '原回复' }] });
    await f.emit('GENERATION_STARTED', 'regenerate', {}, false);
    f.context.chat.pop(); await f.emit('MESSAGE_DELETED', 0);
    await f.render('normal'); await f.emit('GENERATION_ENDED', 1); await f.pump();
    assert.equal(f.runs.length, 0);
    await f.emit('GENERATION_STARTED', 'normal', {}, false);
    await f.render(); await f.emit('GENERATION_ENDED', 2); await f.pump();
    assert.equal(f.runs.length, 1);
});

test('真实 generation type 排除 continue/swipe/quiet，即使 render 没提供 type', async t => {
    for (const type of ['continue', 'swipe', 'quiet', 'regenerate']) await t.test(type, async () => {
        const f = fixture(); await f.emit('GENERATION_STARTED', type, {}, false);
        f.context.chat.push({ mes: '正文' }); await f.emit('CHARACTER_MESSAGE_RENDERED', 0);
        await f.emit('GENERATION_ENDED', 1); await f.pump(); assert.equal(f.runs.length, 0);
    });
});

test('GENERATING 必须等待 ENDED，支持 ENDED 先于 render，dryRun 不锁住调度', async () => {
    const f = fixture(); await f.emit('GENERATION_STARTED', 'normal', {}, false);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 0);
    assert.equal(f.scheduler.status().status, 'waiting_generation');
    await f.emit('GENERATION_ENDED', 1); assert.equal(f.runs.length, 0);
    await f.pump(); assert.equal(f.runs.length, 1);
    await f.emit('GENERATION_STARTED', 'normal', {}, false); await f.emit('GENERATION_ENDED', 1);
    await f.render(); assert.equal(f.runs.length, 1); await f.pump(); assert.equal(f.runs.length, 2);
    await f.emit('GENERATION_STARTED', 'normal', {}, true);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 3);
});

test('前台 STARTED 取消旧 pending，slash 无 ENDED 不残留任务，下次真实生成正常恢复', async t => {
    for (const type of [undefined, 'normal', 'continue', 'swipe', 'regenerate']) await t.test(String(type), async () => {
        const f = fixture({ autoEveryReplies: 2 });
        await f.render(); await f.render(); await f.render();
        assert.equal(f.scheduler.status().pending, true); assert.equal(f.scheduler.status().count, 1);
        await f.emit('GENERATION_STARTED', type, {}, false);
        await f.pump(); assert.equal(f.scheduler.status().pending, false);
        assert.equal(f.scheduler.status().status, 'idle'); assert.equal(f.scheduler.status().count, 1);
        assert.equal(f.runs.length, 0);
        await f.emit('GENERATION_STARTED', 'normal', {}, false);
        await f.render(); await f.pump(); assert.equal(f.runs.length, 0);
        f.scheduler.reset(); assert.equal(f.scheduler.status().pending, false);
        await f.render(); await f.render(); await f.pump(); assert.equal(f.runs.length, 0);
        await f.emit('GENERATION_ENDED', f.context.chat.length); await f.pump();
        assert.equal(f.runs.length, 1);
    });
});

test('quiet STARTED 不取消在途守卫，前台 STARTED 则立即取消而无需等待正文', async () => {
    const f = fixture(), gate = deferred(); f.runWith(() => gate.promise);
    await f.render(); await f.pump();
    await f.emit('GENERATION_STARTED', 'quiet', {}, false); assert.equal(f.runs[0].isCurrent(), true);
    await f.emit('GENERATION_STARTED', 'normal', {}, false); assert.equal(f.runs[0].isCurrent(), false);
    await f.pump(); assert.equal(f.runs.length, 1);
    gate.resolve(); await flush(); await f.pump(); assert.equal(f.runs.length, 1);
});

test('quiet 无 ENDED 不锁住既有 pending，仍尊重 host busy 且不计 quiet 正文', async () => {
    const f = fixture(); await f.render(); f.setBusy(true);
    await f.emit('GENERATION_STARTED', 'quiet', {}, false);
    await f.pump(); assert.equal(f.scheduler.status().status, 'waiting_busy');
    f.context.chat.push({ mes: 'quiet 输出不计数' });
    await f.emit('CHARACTER_MESSAGE_RENDERED', 1); assert.equal(f.saves(), 1);
    f.setBusy(false); await f.pump(); assert.equal(f.runs.length, 1);
});

test('quiet STARTED 不能释放已有未结束的主生成门闩', async () => {
    const f = fixture(); await f.emit('GENERATION_STARTED', 'normal', {}, false);
    await f.render(); await f.emit('GENERATION_STARTED', 'quiet', {}, false);
    await f.pump(); assert.equal(f.runs.length, 0);
    await f.emit('GENERATION_ENDED', 1); await f.pump(); assert.equal(f.runs.length, 1);
});

test('同一渲染回调栈调用 tick 也必须等待 queueMicrotask', async () => {
    const f = fixture(); f.context.chat.push({ mes: '正文' });
    const callback = [...f.bus.listeners.get(EVENTS.CHARACTER_MESSAGE_RENDERED)][0];
    callback(0, 'normal'); f.scheduler.tick(); assert.equal(f.runs.length, 0);
    await flush(); assert.equal(f.runs.length, 0);
    await f.pump(); assert.equal(f.runs.length, 1);
});

test('过期 run 的 reject 不污染新批次，reset 后也保持唯一在途槽直到退出', async () => {
    const f = fixture(), gate = deferred(); f.runWith(() => gate.promise);
    await f.render(); await f.pump(); f.scheduler.reset();
    assert.equal(f.runs[0].isCurrent(), false);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 1);
    gate.reject(new Error('已经过期的失败')); await flush();
    assert.equal(f.scheduler.status().error, '');
    f.runWith(async () => {}); await f.pump();
    assert.equal(f.runs.length, 2); assert.equal(f.maxActive(), 1);
});

test('宿主 busy 由 tick 等待释放，无事件内启动或忙等', async () => {
    const f = fixture(); f.setBusy(true); await f.render();
    for (let i = 0; i < 5; i++) await f.pump();
    assert.equal(f.runs.length, 0); assert.equal(f.scheduler.status().status, 'waiting_busy');
    f.setBusy(false); await f.pump(); assert.equal(f.runs.length, 1);
});

test('在途遇更多主消息使旧守卫失效，并合并一个串行 pending，不重复计费', async () => {
    const f = fixture({ autoEveryReplies: 2 }), gate = deferred();
    f.runWith(() => gate.promise);
    await f.render(); await f.render(); await f.pump(); assert.equal(f.runs.length, 1);
    const firstKey = f.runs[0].sourceKey;
    await f.emit('GENERATION_STARTED', 'normal', {}, false);
    assert.equal(f.runs[0].isCurrent(), false);
    await f.render(); assert.equal(f.runs[0].isCurrent(), false);
    await f.render(); await f.render();
    await f.emit('GENERATION_ENDED', 5); await f.pump(); assert.equal(f.runs.length, 1);
    gate.resolve(); await flush(); await f.pump();
    assert.equal(f.runs.length, 2); assert.equal(f.maxActive(), 1);
    assert.notEqual(f.runs[1].sourceKey, firstKey); assert.equal(f.runs[1].isCurrent(), true);
    assert.equal(f.scheduler.status().count, 1); assert.equal(f.saves(), 5);
    await f.pump(); assert.equal(f.runs.length, 2);
});

test('run 失败进入 paused_error，tick/新消息不自动重试，off→on 或 reset 明确恢复', async () => {
    const f = fixture(); f.runWith(async () => { throw new Error('模拟失败'); });
    await f.render(); await f.pump();
    assert.equal(f.scheduler.status().status, 'paused_error'); assert.equal(f.scheduler.status().error, '模拟失败');
    for (let i = 0; i < 3; i++) { await f.render(); await f.pump(); }
    assert.equal(f.runs.length, 1);
    f.scheduler.pause(); assert.equal(f.preferences.autoEnabled, false);
    f.scheduler.setEnabled(true); f.runWith(async () => {});
    await f.pump(); assert.equal(f.runs.length, 1);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 2);
    f.runWith(async () => { throw new Error('再次失败'); });
    await f.render(); await f.pump(); assert.equal(f.scheduler.status().status, 'paused_error');
    f.scheduler.reset(); assert.equal(f.scheduler.status().count, 0); assert.equal(f.scheduler.status().error, '');
    f.runWith(async () => {}); await f.pump(); assert.equal(f.runs.length, 3);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 4);
});

test('切聊天/身份变动丢弃在途与 pending，重建基线且 reset 只清当前聊天', async () => {
    const f = fixture(), gate = deferred(); f.runWith(() => gate.promise);
    await f.render(); await f.pump(); const oldChat = f.data().chat;
    const newChat = { autoCounter: { count: 2 } }; f.switchChat('world|chat:2', newChat, [{ mes: '旧正文' }]);
    assert.equal(f.runs[0].isCurrent(), false);
    await f.emit('CHAT_CHANGED', 'chat:2');
    await f.emit('CHARACTER_MESSAGE_RENDERED', 0, 'first_message');
    gate.resolve(); await flush(); await f.pump(); assert.equal(f.runs.length, 1);
    f.scheduler.reset(); assert.equal(newChat.autoCounter.count, 0); assert.equal(oldChat.autoCounter.last, 0);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 2);
    f.switchChat('world|chat:3', { autoCounter: { count: 0 } }, [{ mes: '另一旧正文' }]);
    await f.pump(); await f.emit('CHARACTER_MESSAGE_RENDERED', 0, 'normal');
    await f.pump(); assert.equal(f.runs.length, 2);
});

test('偏好关闭立即令守卫失效，tick 清 pending，重新开启不补历史', async () => {
    const f = fixture(), gate = deferred(); f.runWith(() => gate.promise);
    await f.render(); await f.pump(); f.preferences.autoEnabled = false;
    assert.equal(f.runs[0].isCurrent(), false);
    await f.pump(); assert.equal(f.scheduler.status().enabled, false);
    await f.render(); gate.resolve(); await flush();
    f.preferences.autoEnabled = true; await f.pump(); assert.equal(f.runs.length, 1);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 2);
});

test('STOPPED 使部分正文与旧任务失效，下次正常生成恢复', async () => {
    const f = fixture(); await f.emit('GENERATION_STARTED', 'normal', {}, false);
    await f.emit('GENERATION_STOPPED'); await f.render(); await f.emit('GENERATION_ENDED', 1);
    await f.pump(); assert.equal(f.runs.length, 0);
    await f.emit('GENERATION_STARTED', 'normal', {}, false); await f.render();
    await f.emit('GENERATION_ENDED', 2); await f.pump(); assert.equal(f.runs.length, 1);
});

test('默认 N=5 且限制 1..100，外部保存偏好后 tick 读取新值而非旧副本', async () => {
    const f = fixture({ autoEnabled: false });
    delete f.preferences.autoEveryReplies; f.scheduler.tick();
    assert.equal(f.scheduler.status().every, 5);
    await f.render(); f.preferences.autoEnabled = true; f.preferences.autoEveryReplies = 2;
    await f.pump(); assert.equal(f.scheduler.status().every, 2);
    await f.emit('CHARACTER_MESSAGE_RENDERED', 0, 'normal'); await f.pump();
    assert.equal(f.runs.length, 0);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 0);
    await f.render(); await f.pump(); assert.equal(f.runs.length, 1);
    f.preferences.autoEveryReplies = 10000; f.scheduler.tick(); assert.equal(f.scheduler.status().every, 100);
    f.preferences.autoEveryReplies = -3; f.scheduler.tick(); assert.equal(f.scheduler.status().every, 1);
});

test('宿主 STARTED/RENDERED 的 normal 与 undefined 组合都接受，使用真实事件顺序', async t => {
    for (const type of [undefined, 'normal']) await t.test(String(type), async () => {
        const f = fixture({ autoEveryReplies: 2 });
        // 非流式先渲染再结束；流式先结束再渲染。
        await f.emit('GENERATION_STARTED', type, {}, false);
        f.context.chat.push({ mes: '非流式正文' }); await f.emit('CHARACTER_MESSAGE_RENDERED', 0, type);
        await f.pump(); assert.equal(f.runs.length, 0); await f.emit('GENERATION_ENDED', 1);
        await f.emit('GENERATION_STARTED', type, {}, false); await f.emit('GENERATION_ENDED', 1);
        f.context.chat.push({ mes: '流式正文' }); await f.emit('CHARACTER_MESSAGE_RENDERED', 1, type);
        await f.pump(); assert.equal(f.runs.length, 1);
    });
});

test('删除后重置或关闭再开启仍保留高水位，不接受重建同槽', async t => {
    for (const mode of ['reset', 'toggle']) await t.test(mode, async () => {
        const f = fixture({ messages: [{ mes: '旧消息' }] });
        f.context.chat.pop(); await f.emit('MESSAGE_DELETED', 0);
        if (mode === 'reset') f.scheduler.reset();
        else { f.scheduler.pause(); f.scheduler.setEnabled(true); }
        await f.render(); await f.pump(); assert.equal(f.runs.length, 0);
        await f.render(); await f.pump(); assert.equal(f.runs.length, 1);
    });
});

test('错误后切聊天也不隐式重启，必须显式 reset 或 off→on', async () => {
    const f = fixture(); f.runWith(async () => { throw new Error('失败需重启'); });
    await f.render(); await f.pump();
    f.switchChat('world|new'); await f.emit('CHAT_CHANGED', 'new'); await f.render(); await f.pump();
    assert.equal(f.scheduler.status().status, 'paused_error'); assert.equal(f.runs.length, 1);
    f.scheduler.reset(); f.runWith(async () => {}); await f.render(); await f.pump(); assert.equal(f.runs.length, 2);
});

test('event_types 别名可用，缺必要事件明确 unsupported 且不绑定半套监听', async () => {
    const f = fixture({ alias: true }); await f.render(); await f.pump(); assert.equal(f.runs.length, 1);
    const missing = fixture({ missing: 'GENERATION_ENDED' });
    assert.equal(missing.scheduler.status().unsupported, true); assert.equal(missing.bus.size(), 0);
    await missing.render(); await missing.pump(); assert.equal(missing.runs.length, 0);
});

test('tick 不重复重绘，destroy 清监听/微任务/在途守卫，所有后续操作无副作用', async () => {
    const f = fixture(), gate = deferred(); f.runWith(() => gate.promise);
    await f.pump(); const refreshes = f.refreshes();
    for (let i = 0; i < 5; i++) await f.pump(); assert.equal(f.refreshes(), refreshes);
    assert.equal(f.bus.size(), 9); await f.render(); await f.pump();
    f.scheduler.destroy(); f.scheduler.destroy();
    assert.equal(f.bus.size(), 0); assert.equal(f.runs[0].isCurrent(), false);
    const saves = f.saves(), refreshed = f.refreshes();
    await f.render(); await f.emit('GENERATION_ENDED', 2); gate.resolve(); await flush();
    f.scheduler.tick(); f.scheduler.reset(); f.scheduler.pause();
    assert.equal(f.saves(), saves); assert.equal(f.refreshes(), refreshed);
    assert.equal(f.scheduler.status().status, 'destroyed'); assert.equal(f.preferences.autoEnabled, true);
});

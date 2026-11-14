/* NPC Life 自动调度：只消费宿主事件，不改写正文、extra，也不直接访问模型 API。 */
const REQUIRED_EVENTS = ['CHARACTER_MESSAGE_RENDERED', 'GENERATION_STARTED', 'GENERATION_ENDED',
    'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED'];
const normalType = type => type === undefined || type === 'normal';
const countValue = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const everyValue = value => Number.isFinite(Number(value)) ? Math.max(1, Math.min(100, Math.trunc(Number(value)))) : 5;

// host.data() 返回 { chat } 扩展存档；context().chat 才是宿主正文数组，两者绝不混用。
export function createAutomationScheduler(host) {
    let destroyed = false, enabled = false, identity, chat, highWater = -1;
    let epoch = 0, pending = false, sourceKey = '', inFlight = null, error = '';
    let generating = false, generationType, stopped = false, ready = false, renderVersion = 0;
    let every = 1, lastPublished = '', unsupported = false;
    const listeners = [];
    const instanceKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const context = () => host.context() || {};
    const preferences = () => host.preferences() || {};
    const messages = () => Array.isArray(context().chat) ? context().chat : [];
    const counter = () => chat?.autoCounter;

    // 计数仅写本扩展的当前聊天存档，并保留 autoCounter 中已有的其他字段。
    function ensureCounter() {
        if (!chat) return;
        if (!chat.autoCounter || typeof chat.autoCounter !== 'object' || Array.isArray(chat.autoCounter)) {
            chat.autoCounter = { count: 0 };
        } else chat.autoCounter.count = countValue(chat.autoCounter.count);
    }

    // 取消只是使结果守卫失效；旧 Promise 未退出前仍占据唯一在途槽。
    function invalidate(clearPending = true) {
        epoch++;
        if (clearPending) { pending = false; sourceKey = ''; }
        ready = false;
        renderVersion++;
    }

    // 启用、重置和切聊天只建立现有正文基线，绝不遍历补计历史消息。
    function baseline(preserveHighWater = false) {
        const current = messages().length - 1;
        highWater = preserveHighWater ? Math.max(highWater, current) : current;
    }

    // tick 与事件都会观察偏好/身份变化，偏好即使是副本也无需原地改写。
    function synchronize() {
        if (destroyed) return true;
        const nextIdentity = host.identity(), nextChat = host.data()?.chat;
        const nextEnabled = preferences().autoEnabled === true;
        every = everyValue(preferences().autoEveryReplies);
        const switched = nextIdentity !== identity || nextChat !== chat;
        const toggled = nextEnabled !== enabled;
        if (switched || toggled) {
            invalidate();
            identity = nextIdentity; chat = nextChat; enabled = nextEnabled;
            ensureCounter(); baseline(!switched);
            if (toggled && nextEnabled) error = '';
            if (switched) { generating = false; generationType = undefined; stopped = false; }
        }
        return switched || toggled;
    }

    // 状态读取不触发任务，便于 UI 与测试安全轮询。
    function status() {
        let state = 'idle';
        if (destroyed) state = 'destroyed';
        else if (!enabled) state = 'disabled';
        else if (unsupported) state = 'unsupported';
        else if (error) state = 'paused_error';
        else if (inFlight) state = 'running';
        else if (pending) state = generating || !ready ? 'waiting_generation' : host.isBusy() ? 'waiting_busy' : 'pending';
        return { enabled, count: countValue(counter()?.count), every, status: state, error, pending, unsupported };
    }

    // 仅状态确有变化时刷新，避免宿主 700ms 轮询反复重绘控制台。
    function publish() {
        const signature = JSON.stringify(status());
        if (signature !== lastPublished) { lastPublished = signature; host.refresh?.(); }
    }

    // 渲染回调只认新的有效槽位；被排除的槽位也记入高水位，禁止稍后重复 render 补计。
    function rendered(id, type) {
        if (destroyed) return;
        if (synchronize()) { publish(); return; }
        const slot = typeof id === 'number' ? id : typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : NaN;
        const message = Number.isSafeInteger(slot) && slot >= 0 ? messages()[slot] : undefined;
        if (!message || slot <= highWater) return;
        highWater = slot;
        if (!enabled || unsupported || message.is_user || message.is_system || typeof message.mes !== 'string'
            || !message.mes.trim() || !normalType(type) || !normalType(generationType) || stopped) return;
        ensureCounter();
        if (!counter()) return;
        counter().count++;
        counter().last = slot;
        // 新主消息使正在执行的旧批次作废，并把所有需求合并为至多一个 pending。
        if (pending || inFlight) { invalidate(false); pending = true; }
        if (counter().count >= every) { counter().count %= every; pending = true; }
        if (pending) sourceKey = `auto:${instanceKey}:${epoch}:${String(identity)}:${slot}`;
        host.save();
        const version = ++renderVersion;
        ready = false;
        // 等宿主 render 的同步/异步收尾后才放行；这里永不启动 run。
        queueMicrotask(() => {
            if (!destroyed && version === renderVersion) { ready = true; publish(); }
        });
        publish();
    }

    // 开始事件记录真实生成类型；quiet、续写、重抽等即使新建正文槽也不计数。
    function started(type, _options, dryRun) {
        if (destroyed || dryRun) return;
        synchronize();
        // 前台准备阶段也可能早退且没有 ENDED：先取消旧需求，禁止旧分析与新主生成竞争。
        // 新正文再建立 pending；quiet 没有可靠结束事件，仅记录类型而不改动已有门闩。
        if (type !== 'quiet') { invalidate(); generating = true; }
        generationType = type; stopped = false;
        publish();
    }

    // 流式可能先 ENDED 后 RENDERED，因此保留生成类型直到下一次 STARTED。
    function ended() {
        if (destroyed) return;
        synchronize(); generating = false; publish();
    }

    // 用户停止生成后不接受尚未结束的部分正文，也不提交旧自动结果。
    function stoppedGeneration() {
        if (destroyed) return;
        synchronize(); generating = false; stopped = true; invalidate(); publish();
    }

    // 编辑、切候选和删除使旧结果失效；删除后的高水位永不回退。
    function changedMessage() {
        if (destroyed) return;
        synchronize(); invalidate(); baseline(true); publish();
    }

    // CHAT_CHANGED 即使身份字符串相同也建立新基线，避免首次消息补发被消费。
    function changedChat() {
        if (destroyed) return;
        synchronize(); invalidate(); baseline();
        generating = false; generationType = undefined; stopped = false;
        publish();
    }

    // 唯一的任务启动入口，由 index 的轮询调用；事件总线回调永不抢主 API。
    function tick() {
        if (destroyed) return status();
        synchronize();
        if (!enabled || unsupported || error || !pending || !ready || generating || inFlight || host.isBusy()) {
            publish(); return status();
        }
        const runEpoch = epoch, runIdentity = identity, runChat = chat;
        const ticket = { sourceKey };
        inFlight = ticket; pending = false;
        // 在真正请求和提交前由业务层再次调用守卫，切聊天/关闭/修改正文均会返回 false。
        const isCurrent = () => !destroyed && enabled && epoch === runEpoch && host.identity() === runIdentity
            && host.data()?.chat === runChat && preferences().autoEnabled === true;
        Promise.resolve().then(() => {
            if (isCurrent()) return host.run({ isCurrent, sourceKey: ticket.sourceKey });
        }).catch(failure => {
            if (isCurrent()) {
                error = String(failure?.message || failure || '自动任务失败');
                pending = false;
            }
        }).finally(() => {
            if (inFlight === ticket) inFlight = null;
            if (!destroyed) publish();
        });
        publish(); return status();
    }

    // 显式开关通过宿主保存，不依赖 preferences() 返回可变引用。
    function setEnabled(value) {
        if (destroyed) return status();
        host.setEnabled(value === true);
        synchronize(); publish(); return status();
    }

    // 暂停等同于持久关闭；再次开启是错误暂停后的明确重启操作。
    function pause() { return setEnabled(false); }

    // 仅清当前聊天计数和错误，不触碰其他聊天，也不让旧任务结果重新生效。
    function reset() {
        if (destroyed) return status();
        synchronize(); invalidate(); ensureCounter();
        if (counter()) { counter().count = 0; delete counter().last; host.save(); }
        error = ''; baseline(true); publish(); return status();
    }

    // 精确卸载本实例注册的回调，同时让所有未完成的请求守卫永久失效。
    function destroy() {
        if (destroyed) return;
        destroyed = true; invalidate();
        for (const [bus, event, listener] of listeners) {
            if (typeof bus.removeListener === 'function') bus.removeListener(event, listener);
            else bus.off(event, listener);
        }
        listeners.length = 0;
    }

    synchronize();
    const ctx = context(), bus = ctx.eventSource, types = ctx.eventTypes || ctx.event_types;
    unsupported = !bus || typeof bus.on !== 'function'
        || (typeof bus.removeListener !== 'function' && typeof bus.off !== 'function')
        || REQUIRED_EVENTS.some(name => !types?.[name]);
    if (!unsupported) {
        const handlers = { CHARACTER_MESSAGE_RENDERED: rendered, GENERATION_STARTED: started,
            GENERATION_ENDED: ended, GENERATION_STOPPED: stoppedGeneration, CHAT_CHANGED: changedChat,
            MESSAGE_SWIPED: changedMessage, MESSAGE_EDITED: changedMessage, MESSAGE_UPDATED: changedMessage,
            MESSAGE_DELETED: changedMessage };
        for (const name of REQUIRED_EVENTS) {
            bus.on(types[name], handlers[name]); listeners.push([bus, types[name], handlers[name]]);
        }
    }
    return { tick, status, setEnabled, pause, reset, destroy };
}

/* NPC Life 精简面板：名册、近期结算、跟踪开关和基本设置。 */
const VERSION = '3.3.2-sync';

function clamp(node) {
    if (node.hidden) return;
    const r = node.getBoundingClientRect(), width = Math.max(1, innerWidth - 16), height = Math.max(1, innerHeight - 16);
    node.style.resize = innerWidth < 620 ? 'none' : 'both';
    if (innerWidth < 620) {
        Object.assign(node.style, { left: '8px', top: '8px', width: `${width}px`, height: `${Math.min(height, 680, r.height || 560)}px` });
        return;
    }
    node.style.width = `${Math.min(width, Math.max(360, r.width || parseFloat(node.style.width) || 420))}px`;
    node.style.height = `${Math.min(height, Math.max(320, r.height || parseFloat(node.style.height) || 560))}px`;
    node.style.left = `${Math.max(8, Math.min(innerWidth - (node.offsetWidth || 420) - 8, r.left || parseFloat(node.style.left) || 48))}px`;
    node.style.top = `${Math.max(8, Math.min(innerHeight - (node.offsetHeight || 560) - 8, r.top || parseFloat(node.style.top) || 48))}px`;
}

export function mountConsole(adapter) {
    const $ = (typeof window !== 'undefined' ? window.jQuery : globalThis.jQuery);
    if (!$ || !adapter) throw new Error('NPC Life 面板需要 jQuery 和 adapter。');
    $('#npc-life-console').remove();
    let state = adapter.snapshot() || {}, busy = false, destroyed = false, renderedIdentity = state.identity;
    const cleanups = [];
    const root = $('<section id="npc-life-console" class="nlc" hidden aria-label="NPC Life 面板" tabindex="-1"></section>');
    root.html(`<header class="nlc-bar" data-drag><div class="nlc-bar-title"><strong>NPC Life</strong><span class="nlc-version">${VERSION}</span><span class="nlc-world"></span></div><span class="nlc-controls"><button type="button" class="menu_button" data-min title="最小化">⌄</button><button type="button" class="menu_button" data-close title="关闭">×</button></span></header><div class="nlc-status" role="status" aria-live="polite"></div><main class="nlc-pages"></main>`);
    $('body').append(root);
    const pages = root.find('.nlc-pages'), status = root.find('.nlc-status');
    function listen(target, event, fn, opts) { target.addEventListener(event, fn, opts); cleanups.push(() => target.removeEventListener(event, fn, opts)); }
    function button(label, action, attrs = {}) { return $('<button type="button" class="menu_button">').text(label).attr({ 'data-action': action, ...attrs }); }
    function field(label, name, value, type = 'text') { return $('<label class="nlc-field">').append($('<span>').text(label), $('<input class="text_pole">').attr({ 'data-field': name, type }).val(value ?? '')); }
    function card(title) { return $('<section class="nlc-card">').append($('<h3>').text(title)); }
    function setStatus(text, error = false) { status.toggleClass('nlc-error', !!error).text(text || ''); }
    function current() { try { return adapter.snapshot() || state; } catch { return state; } }

    async function run(action, fn) {
        if (busy || destroyed) return;
        busy = true; setStatus(action || '处理中…');
        try { await fn(); if (!destroyed) { state = current(); draw(); setStatus('已更新。'); } }
        catch (error) { if (!destroyed) setStatus(String(error?.message || error), true); }
        finally { busy = false; }
    }

    function draw() {
        if (destroyed) return;
        state = current();
        root.find('.nlc-world').text(state.worldLabel || '');
        const prefs = state.preferences || {};
        const auto = state.automation || {};
        pages.empty();

        const roster = card('名册（已追踪）');
        const people = state.npcs || [];
        if (!people.length) roster.append($('<p class="nlc-muted">').text('还没有追踪中的人物。已出场且有设定资料的人，或你明确指定的人，会建档追踪。未登场且资料不足的不会提前安排活动。'));
        people.forEach(npc => {
            const item = $('<article class="nlc-item">');
            item.append($('<b>').text(npc.name || npc.id));
            item.append($('<p>').text(`${npc.locationName || '地点不详'} · ${npc.activity || '计划未知'} · ${npc.scene === 'present' ? '同场' : '不在场'}`));
            if (npc.aliases?.length) item.append($('<p class="nlc-muted">').text(`亦称：${npc.aliases.join('、')}`));
            item.append($('<div class="nlc-row">').append(
                button(npc.tracked === false ? '开始追踪' : '停止追踪', 'toggle-track', { 'data-id': npc.id }),
                button('归档', 'archive', { 'data-id': npc.id }),
            ));
            roster.append(item);
        });
        pages.append(roster);

        const sources = card('资料中的其他名字');
        const names = state.sourceNames || [];
        if (!names.length) sources.append($('<p class="nlc-muted">').text('资料里暂时没有未追踪的候选名字。'));
        names.slice(0, 24).forEach(npc => {
            const row = $('<div class="nlc-row nlc-source">');
            row.append($('<span>').text(npc.name + (npc.aliases?.length ? `（${npc.aliases.join('、')}）` : '')));
            row.append(button('追踪', 'track', { 'data-id': npc.id }));
            sources.append(row);
        });
        pages.append(sources);

        const notes = state.autoNotes || [];
        if (prefs.autoNotesEnabled === true || notes.length) {
            const notesCard = card('后台侧写');
            if (!notes.length) notesCard.append($('<p class="nlc-muted">').text('还没有后台侧写。到达结算间隔后会为已追踪角色生成，只留在面板里，不会写入正史。'));
            notes.slice().reverse().forEach(note => {
                const kind = note.kind === 'activity' ? '活动' : note.kind === 'gesture' ? '动作' : note.kind === 'psychology' ? '心理' : (note.kind || '');
                notesCard.append($('<article class="nlc-item">').append(
                    $('<p>').text(`${note.npcName || note.npcId || ''}｜${kind}｜${note.text || ''}`),
                    $('<p class="nlc-muted">').text('后台记录，不进正史'),
                ));
            });
            pages.append(notesCard);
        }

        const recent = card('近期结算结果');
        const events = state.publicSettlements?.length ? state.publicSettlements : (state.timeline?.events || []).slice(-8);
        if (!events.length) recent.append($('<p class="nlc-muted">').text('还没有已提交的公开结果。结算只在正文结束后进行，最早下一轮生效。'));
        events.slice(-8).reverse().forEach(event => {
            recent.append($('<article class="nlc-item">').append(
                $('<p>').text(event.summary || event.text || '（无摘要）'),
                $('<p class="nlc-muted">').text(event.clockMinutes != null ? `世界时钟 ${event.clockMinutes} 分钟` : ''),
            ));
        });
        if (state.timeline?.pausedReason) recent.append($('<p class="nlc-error">').text(state.timeline.pausedReason));
        pages.append(recent);

        const ledgerCard = card('活动与痕迹资料库');
        const ledger = state.activityLedger || {};
        const acts = (ledger.activities || []).filter(item => item.status !== 'revoked');
        const traces = (ledger.traces || []).filter(item => item.status !== 'revoked');
        const found = (ledger.discoveries || []).filter(item => item.status === 'active' && item.knowledge === 'found');
        if (!acts.length && !traces.length) ledgerCard.append($('<p class="nlc-muted">').text('资料库还是空的。NPC 做过、正在做和准备做的事会长期留在这里。只有会留下可观察物证的行动才会生成痕迹，且先进入后台，不会在当轮写成你已经看见。'));
        acts.slice(-8).reverse().forEach(item => {
            const phase = item.phase === 'done' ? '做过' : item.phase === 'doing' ? '正在做' : '准备做';
            const src = item.source === 'story' ? '正文' : item.source === 'user' ? '用户确认' : item.source === 'claim' ? '玩家主张' : '结算';
            ledgerCard.append($('<article class="nlc-item">').append(
                $('<p>').text(`${phase}｜${item.summary || ''}`),
                $('<p class="nlc-muted">').text(`来源：${src}${item.committed ? '｜已提交' : '｜未提交'}｜${item.publicCanon ? '公开正史' : '后台记录'}`),
            ));
        });
        if (traces.length) ledgerCard.append($('<p class="nlc-muted">').text(`后台痕迹 ${traces.length} 条，其中已发现 ${found.length} 条。调查相关内容或进入相关场景、且正文写出发现后，才会从「可发现机会」变成已发现线索。`));
        pages.append(ledgerCard);

        const settings = card('基本设置');
        settings.append($('<p class="nlc-muted">').text(`自动结算：${auto.enabled ? (auto.status || '开启') : '关闭'} · 每 ${prefs.autoEveryReplies || 1} 条回复结算一轮。记忆插件${prefs.memoryEnabled ? '只读参考，不能覆盖正史，也不会写回' : '未启用读取'}。未写时间则不推进时钟。`));
        settings.append($('<div class="nlc-form-grid">').append(
            $('<label class="nlc-field nlc-check">').append($('<input type="checkbox" data-field="autoEnabled">').prop('checked', prefs.autoEnabled !== false), $('<span>').text('启用自动结算')),
            field('结算间隔（条回复）', 'autoEveryReplies', prefs.autoEveryReplies ?? 1, 'number'),
            field('称呼', 'userName', prefs.userName || '', 'text'),
            $('<label class="nlc-field nlc-check">').append($('<input type="checkbox" data-field="memoryEnabled">').prop('checked', prefs.memoryEnabled === true), $('<span>').text('读取记忆插件（只读参考，非正史，不写回）')),
            $('<label class="nlc-field nlc-check">').append($('<input type="checkbox" data-field="autoNotesEnabled">').prop('checked', prefs.autoNotesEnabled === true), $('<span>').text('启用后台侧写（默认关闭，不进正史）')),
            $('<label class="nlc-field nlc-check">').append($('<input type="checkbox" data-field="debugLog">').prop('checked', (prefs.logLevel || 'debug') !== 'silent'), $('<span>').text('控制台调试日志（可看到后台结算）')),
        ));
        const advanced = $('<details class="nlc-advanced">').append(
            $('<summary>').text('高级设置（下载即可用，一般不用改）'),
            $('<p class="nlc-muted">').text('动态世界书按条数和轮数双上限淘汰最旧条目。偶遇默认低概率，单轮最多 1 人。地点只影响权重：同地提高、异地降低，但不排除。不需要手工填写追踪名单。'),
            $('<div class="nlc-form-grid">').append(
                field('世界书条数上限', 'worldBookMaxEntries', prefs.worldBookMaxEntries ?? 24, 'number'),
                field('世界书轮数上限', 'worldBookMaxTurns', prefs.worldBookMaxTurns ?? 8, 'number'),
                field('偶遇概率（0-1）', 'encounterProbability', prefs.encounterProbability ?? 0.08, 'number'),
                field('单轮最多偶遇人数', 'encounterMaxPerTurn', prefs.encounterMaxPerTurn ?? 1, 'number'),
                field('同地偶遇权重', 'encounterSameWeight', prefs.encounterSameWeight ?? 1.6, 'number'),
                field('地点未知偶遇权重', 'encounterUncertainWeight', prefs.encounterUncertainWeight ?? 1, 'number'),
                field('异地偶遇权重', 'encounterMismatchWeight', prefs.encounterMismatchWeight ?? 0.35, 'number'),
            ),
        );
        settings.append(advanced);
        settings.append($('<div class="nlc-row">').append(
            button('保存设置', 'save-prefs'),
            button(auto.enabled ? '暂停结算' : '恢复结算', auto.enabled ? 'pause' : 'resume'),
            button('导出备份', 'export'),
            button('导入备份', 'import'),
        ));
        if ((state.npcs || []).length >= 2) {
            const ids = state.npcs.map(npc => npc.id);
            settings.append($('<p class="nlc-muted">').text('只有卡里写明“亦称”或你在这里确认，才会合并两个名字。吃不准就先分开。'));
            settings.append($('<div class="nlc-row">').append(
                $('<select data-merge-from>').append(ids.map(id => $(`<option value="${id}">`).text(state.npcs.find(n => n.id === id)?.name || id))),
                $('<select data-merge-to>').append(ids.map(id => $(`<option value="${id}">`).text(state.npcs.find(n => n.id === id)?.name || id))),
                button('确认合并', 'merge'),
            ));
        }
        pages.append(settings);
        clamp(root.get(0));
    }

    function bind() {
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        listen(root.find('[data-drag]').get(0), 'pointerdown', event => {
            if (event.target.closest('button')) return;
            dragging = true; sx = event.clientX; sy = event.clientY;
            ox = parseFloat(root.css('left')) || 48; oy = parseFloat(root.css('top')) || 48;
            event.currentTarget.setPointerCapture?.(event.pointerId);
        });
        listen(window, 'pointermove', event => {
            if (!dragging) return;
            root.css({ left: `${ox + event.clientX - sx}px`, top: `${oy + event.clientY - sy}px` });
            clamp(root.get(0));
        });
        listen(window, 'pointerup', () => { dragging = false; });
        listen(window, 'resize', () => clamp(root.get(0)));
        root.on('click', '[data-close]', () => root.attr('hidden', true));
        root.on('click', '[data-min]', () => root.toggleClass('nlc-min'));
        root.on('click', '[data-action]', event => {
            const action = event.currentTarget.getAttribute('data-action');
            const id = event.currentTarget.getAttribute('data-id');
            if (action === 'toggle-track' || action === 'track') return run('更新追踪', () => adapter.setTracked(id, action === 'track'));
            if (action === 'archive') return run('归档', () => adapter.archiveNpc(id));
            if (action === 'pause') return run('暂停', () => adapter.pauseAutomation());
            if (action === 'resume') return run('恢复', () => adapter.resumeAutomation?.() ?? adapter.savePreferences({ autoEnabled: true }));
            if (action === 'export') return adapter.exportData?.();
            if (action === 'import') {
                const input = $('<input type="file" accept="application/json">');
                input.on('change', () => { const file = input.get(0).files?.[0]; if (file) run('导入', () => adapter.importData(file)); });
                input.trigger('click');
                return;
            }
            if (action === 'save-prefs') {
                const patch = {};
                root.find('[data-field]').each((_, node) => {
                    const name = node.getAttribute('data-field');
                    patch[name] = node.type === 'checkbox' ? node.checked : node.value;
                });
                return run('保存设置', () => adapter.savePreferences(patch));
            }
            if (action === 'merge') {
                const from = root.find('[data-merge-from]').val(), to = root.find('[data-merge-to]').val();
                if (!from || !to || from === to) return setStatus('请选择两个不同的人再合并。', true);
                if (!window.confirm('确认把这两个名字合并为同一人？只有你明确确认或卡里写明“亦称”才会合并。')) return;
                return run('合并身份', () => adapter.mergeEntities(from, to));
            }
        });
    }

    bind();
    return {
        open() { if (destroyed) return; state = current(); root.removeAttr('hidden'); draw(); root.get(0).focus(); clamp(root.get(0)); },
        render() { if (!destroyed && !root.attr('hidden')) draw(); },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            cleanups.forEach(fn => fn());
            root.off(); root.remove();
        },
    };
}

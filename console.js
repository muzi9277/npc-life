/* NPC Life standalone console. Requires the host's jQuery and adapter contract. */
const CONSOLE_KEY = 'npc-life:console:v1';
const TABS = ['动态', '联系人', '地图', '档案', '设置'];

// 限制窗口几何信息在视口内，并为窄屏使用全屏壳体。
function clampConsole(node) {
    const r = node.getBoundingClientRect();
    if (innerWidth < 620) { node.style.left = '8px'; node.style.top = '8px'; node.style.width = `${Math.max(280, innerWidth - 16)}px`; node.style.height = `${Math.max(300, innerHeight - 16)}px`; return; }
    node.style.width = `${Math.min(innerWidth - 16, Math.max(360, r.width || 720))}px`;
    node.style.height = `${Math.min(innerHeight - 16, Math.max(300, r.height || 560))}px`;
    node.style.left = `${Math.max(8, Math.min(innerWidth - node.offsetWidth - 8, r.left || 48))}px`;
    node.style.top = `${Math.max(8, Math.min(innerHeight - node.offsetHeight - 8, r.top || 48))}px`;
}

// 挂载非模态控制台，内部只使用 jQuery 文本 API 插入动态数据。
export function mountConsole(adapter) {
    const $ = window.jQuery;
    if (!$ || !adapter) throw new Error('NPC Life 控制台需要 jQuery 和 adapter。');
    $('#npc-life-console').remove();
    let state = adapter.snapshot() || {}, tab = '动态', npcId = '', diaryId = '', busy = false, destroyed = false;
    let minimized = false, maximized = false, restoreRect = null, oldPanel = null, oldPanelParent = null, oldPanelNext = null, mapTag = '', archiveNpc = '', archiveDay = '', drafts = Object.create(null), draftIdentity = state.identity, priorFocus = null, sizeObserver = null;
    let renderedNpc = '', renderedIdentity = state.identity, renderedTab = '', generalDrafts = Object.create(null), identityEpoch = 0;
    const cleanups = [], root = $('<section id="npc-life-console" class="nlc" hidden aria-label="NPC Life 控制台"></section>');
    root.html(`<header class="nlc-bar" data-drag><strong>NPC Life</strong><span class="nlc-version">3.0.0-beta.1</span><span class="nlc-world"></span><span class="nlc-controls"><button class="menu_button" data-smaller aria-label="缩小窗口" title="缩小">−</button><button class="menu_button" data-larger aria-label="放大窗口" title="放大">＋</button><button class="menu_button" data-min aria-label="最小化窗口" title="最小化">⌄</button><button class="menu_button" data-max aria-label="最大化或恢复窗口" title="最大化/恢复">□</button><button class="menu_button" data-close aria-label="关闭窗口" title="关闭">×</button></span></header><nav class="nlc-tabs" role="tablist"></nav><div class="nlc-status" role="status" aria-live="polite"></div><main class="nlc-pages"></main><button type="button" class="menu_button nlc-fab" data-fab title="打开 NPC Life">NPC Life</button>`);
    $('body').append(root);
    const pages = root.find('.nlc-pages'), status = root.find('.nlc-status');
    // 统一注册可撤销的 DOM 监听器。
    function listen(target, event, fn, opts) { target.addEventListener(event, fn, opts); cleanups.push(() => target.removeEventListener(event, fn, opts)); }
    // 创建标准按钮，动态文字一律经 .text 写入。
    function button(label, action, attrs = {}) { return $('<button type="button" class="menu_button">').text(label).attr({ 'data-action': action, ...attrs }); }
    // 创建标准文本字段，重新渲染时避免覆盖焦点中的用户输入。
    function field(label, name, value, type = 'text') { const input = $('<input class="text_pole">').attr({ 'data-field': name, type }).val(value == null ? '' : value); return $('<label class="nlc-field">').append($('<span>').text(label), input); }
    // 保存窗口几何和页签至浏览器本地存储。
    function persist() { try { const r = root[0].getBoundingClientRect(); localStorage.setItem(CONSOLE_KEY, JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height, tab })); } catch (_) {} }
    // 显示本地成功或错误状态。
    function tell(value, error = false) { status.text(value || '').toggleClass('is-error', error); }
    // 切卡后清空所有指向旧身份的界面选择和草稿。
    function resetIdentity() { npcId = ''; diaryId = ''; drafts = Object.create(null); draftIdentity = state.identity; }
    // 捕获异步操作异常，并拒绝将旧卡请求结果应用到新卡。
    async function run(action, success, targets = {}) {
        if (busy) return false;
        const identity = state.identity, epoch = identityEpoch;
        busy = true; root.addClass('is-busy'); tell('处理中…');
        try {
            const result = await action();
            const fresh = adapter.snapshot() || {};
            if (result === false) { state = fresh; tell('操作已取消。'); render(); return; }
            if (fresh.identity !== identity || identityEpoch !== epoch) { state = fresh; resetIdentity(); tell('角色卡已切换，旧请求结果已忽略。', true); render(); return; }
            state = fresh; if ((!targets.npc || targets.npc === npcId) && (!targets.tab || targets.tab === tab)) success?.(result); render();
        } catch (error) { tell(error?.message || String(error), true); }
        finally { busy = false; root.removeClass('is-busy'); }
    }
    // 创建动态总览和旧工作台折叠区，工作台节点仅移动不复制。
    function overview() {
        const page = $('<div class="nlc-page">'), cards = $('<div class="nlc-grid">');
        (state.npcs || []).filter(n => n.confirmed || n.tracked).forEach(n => {
            cards.append($('<article class="nlc-item">').append($('<h3>').text(n.name || '未命名 NPC'), $('<p>').text(`${n.locationName || '地点未知'} · ${n.activity || n.status || '暂无活动'}`), n.scene ? $('<p class="nlc-muted">').text(n.scene) : '', button('查看联系人', 'select-npc', { 'data-npc': n.id })));
        });
        const workbench = $('<details class="nlc-workbench"><summary>高级世界工作台</summary><div class="nlc-workbench-body"></div></details>');
        try { const panel = oldPanel || adapter.getWorkbench?.(); if (panel?.nodeType) { if (!oldPanel) { oldPanel = panel; oldPanelParent = panel.parentNode; oldPanelNext = panel.nextSibling; } workbench.find('.nlc-workbench-body').append(panel); } }
        catch (error) { tell(error?.message || String(error), true); }
        page.append(cards, workbench); pages.append(page);
    }
    // 创建联系人详情、日记查看和独立后台试聊面板。
    function contacts() {
        const page = $('<div class="nlc-page nlc-contact">'), roster = $('<aside class="nlc-roster">'), detail = $('<section class="nlc-detail">');
        (state.npcs || []).forEach(n => roster.append(button(n.name || '未命名', 'select-npc', { 'data-npc': n.id }).toggleClass('is-active', n.id === npcId)));
        const npc = (state.npcs || []).find(n => n.id === npcId);
        if (!npc) detail.append($('<p class="nlc-muted">').text('选择联系人查看详情。'));
        else {
            detail.append($('<h2>').text(npc.name || '未命名 NPC'), $('<p>').text([npc.locationName, npc.activity || npc.status, npc.relationship].filter(Boolean).join(' · ') || '暂无动态信息'));
            const draft = drafts[npc.id] || (drafts[npc.id] = { day: state.day || 1, chars: [50, 200, 800, 1600].includes(Number(state.preferences?.diaryChars)) ? String(state.preferences.diaryChars) : 'custom', custom: state.preferences?.diaryChars || 800, chat: '' });
            const day = $('<input class="text_pole" data-field="diary-day" type="number" min="1" max="1000000">').val(draft.day);
            const chars = $('<select class="text_pole" data-field="diary-chars"><option value="50">50 字</option><option value="200">200 字</option><option value="800">800 字</option><option value="1600">1600 字</option><option value="custom">自定义</option></select>').val(draft.chars);
            detail.append($('<div class="nlc-row">').append($('<label>').append('日期', day), $('<label>').append('篇幅', chars), $('<input class="text_pole" type="number" min="1" max="10000" data-field="diary-custom" placeholder="自定义字数">').val(draft.custom), button('生成日记', 'diary')));
            detail.append($('<h3>').text('日记')); const list = $('<div class="nlc-list">');
            (state.diaries || []).filter(d => d.npcId === npc.id).slice().sort((a, b) => b.day - a.day).forEach(d => list.append($('<button type="button" class="nlc-list-row">').text(`第 ${d.day} 天 · ${(d.text || '').slice(0, 90)}`).attr('data-diary', d.id)));
            detail.append(list);
            const diary = (state.diaries || []).find(d => d.id === diaryId && d.npcId === npc.id);
            if (diary) detail.append($('<article class="nlc-reading">').append($('<h3>').text(`第 ${diary.day} 天`), $('<p>').text(diary.text || '')));
            detail.append($('<h3>').text('后台试聊')); const chat = $('<div class="nlc-chat">');
            ((state.conversations || {})[npc.id] || []).forEach(m => chat.append($('<div class="nlc-bubble">').addClass(m.role === 'user' ? 'from-user' : 'from-npc').text(m.content || '')));
            detail.append(chat, $('<div class="nlc-row">').append($('<textarea class="text_pole" data-field="chat-text" rows="2" placeholder="仅保存为后台试聊记录"></textarea>').val(draft.chat), button('发送', 'chat-send'), button('清空', 'chat-clear')));
        }
        page.append(roster, detail); pages.append(page);
    }
    // 绘制已确认地点；仅接受 PNG/JPEG/WebP data URL 图片。
    function mapPage() {
        const page = $('<div class="nlc-page">'), locations = (state.locations || []).filter(l => l.confirmed), tags = [...new Set(locations.flatMap(l => l.tags || []))];
        const filter = $('<select class="text_pole" data-field="map-tag"><option value="">全部标签</option></select>').val(mapTag); tags.forEach(t => filter.append($('<option>').val(t).text(t))); filter.val(mapTag);
        const area = $('<div class="nlc-map">');
        if (typeof state.mapImage === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(state.mapImage)) area.css('background-image', `url("${state.mapImage}")`);
        const shown = locations.filter(l => !mapTag || (l.tags || []).includes(mapTag));
        shown.forEach(l => {
            const xy = Number.isFinite(l.x) && Number.isFinite(l.y) && l.x >= 0 && l.x <= 100 && l.y >= 0 && l.y <= 100;
            if (xy) area.append($('<span class="nlc-map-node">').text(l.name || '地点').css({ left: `${l.x}%`, top: `${l.y}%` }));
        });
        const tagRows = $('<div class="nlc-locations">'); locations.forEach(l => { const occupants = (state.npcs || []).filter(n => n.locationId === l.id).map(n => `${n.name || 'NPC'}${n.status === 'unknown' ? '（未知）' : ''}`).join('、') || '暂无 NPC'; const routes = (state.routes || []).filter(r => r.fromId === l.id || r.toId === l.id).map(r => { const target = (state.locations || []).find(x => x.id === (r.fromId === l.id ? r.toId : r.fromId)); return `${target?.name || '未知地点'} · ${r.durationDays || '?'} 天`; }).join('、') || '无已确认路线'; tagRows.append($('<div class="nlc-location">').append($('<span>').text(`${l.name || '地点'} · ${(l.tags || []).join('、') || '无标签'} · ${occupants} · 路线：${routes}`), $('<input class="text_pole" data-tags>').attr('data-id', l.id).val((l.tags || []).join(', ')))); });
        page.append($('<div class="nlc-row">').append(filter, $('<label class="menu_button nlc-upload">上传地图<input type="file" data-map-file accept="image/png,image/jpeg,image/webp" hidden></label>'), $('<label class="menu_button nlc-upload">导入 JSON 文件<input type="file" data-import-file accept=".json,application/json" hidden></label>')), area, $('<p class="nlc-muted">').text(state.mapImage ? '坐标点按百分比叠加。未设置坐标的地点仅列于下方。' : '无底图时地图只绘制有坐标地点；未设置坐标的地点仅列于下方。'), $('<textarea class="text_pole" data-field="map-json" rows="3" placeholder="可粘贴 JSON 地图数据"></textarea>'), button('导入粘贴内容', 'import-map'), tagRows);
        pages.append(page);
    }
    // 按 NPC 和日期筛选事件与日记，并展示只读记忆表。
    function archive() {
        const page = $('<div class="nlc-page">'), who = $('<select class="text_pole" data-field="archive-npc"><option value="">全部联系人</option></select>'), day = $('<input class="text_pole" data-field="archive-day" type="number" min="1" placeholder="日期">');
        (state.npcs || []).forEach(n => who.append($('<option>').val(n.id).text(n.name || n.id)));
        page.append($('<div class="nlc-row">').append(who.val(archiveNpc), day.val(archiveDay)));
        const chosen = archiveNpc, chosenDay = Number(archiveDay);
        const events = $('<div class="nlc-list">'); (state.events || []).filter(e => (!chosen || (e.npcIds || []).includes(chosen)) && (!chosenDay || e.day === chosenDay)).slice().sort((a,b) => b.day-a.day).forEach(e => events.append($('<article class="nlc-item">').append($('<b>').text(`第 ${e.day} 天 · ${e.kind || '事件'}`), $('<p>').text(e.summary || ''), $('<small>').text(e.source || ''))));
        const diaries = $('<div class="nlc-list">'); (state.diaries || []).filter(d => (!chosen || d.npcId === chosen) && (!chosenDay || d.day === chosenDay)).forEach(d => diaries.append($('<article class="nlc-item">').append($('<b>').text(`第 ${d.day} 天`), $('<p>').text(d.text || ''))));
        page.append($('<h3>').text('生活事件'), events, $('<h3>').text('日记'), diaries);
        const memory = $('<details class="nlc-memory"><summary>增强记忆表</summary></details>');
        if (!state.memory?.available) memory.append($('<p class="nlc-muted">').text(state.memory?.message || '记忆存储不可用。'));
        else (state.memory.tables || []).forEach(t => { const table = $('<details><summary></summary></details>'); table.children('summary').text(t.name || '数据表'); const pre = $('<pre class="nlc-pre">').text(JSON.stringify(t.data ?? [], null, 2)); table.append(pre); memory.append(table); });
        memory.append(button('刷新记忆', 'memory-refresh')); page.append(memory); pages.append(page);
    }
    // 构建偏好、任务模型路由、模板、导入导出设置表单。
    function settings() {
        const p = state.preferences || {}, page = $('<div class="nlc-page nlc-settings">');
        page.append(field('用户称呼', 'userName', p.userName), field('日记字数', 'diaryChars', p.diaryChars, 'number'), field('上下文预算', 'contextChars', p.contextChars, 'number'));
        page.append($('<label class="checkbox_label"><input type="checkbox" data-pref="memoryEnabled"><span>启用增强记忆</span></label>').find('input').prop('checked', Boolean(p.memoryEnabled)).end(), field('记忆预算', 'memoryChars', p.memoryChars, 'number'));
        const profile = $('<select class="text_pole" data-field="secondaryProfileId"><option value="">无副 profile</option></select>'); (state.profiles || []).forEach(x => profile.append($('<option>').val(x.id).text(`${x.name || x.id} · ${x.model || '模型未知'}`))); profile.val(p.secondaryProfileId || '');
        page.append($('<label class="nlc-field"><span>副 profile</span></label>').append(profile));
        const preset = $('<div class="nlc-presets">'); (state.profiles || []).forEach(x => preset.append($('<div class="nlc-item">').append($('<b>').text(x.name || x.id), $('<p>').text(`${x.model || '模型未知'} · ${x.preset || '默认预设'}`)))); page.append(preset);
        const routes = $('<div class="nlc-routes">'); ['analysis','simulation','narrative','chat'].forEach(task => { const sel = $('<select class="text_pole" data-route>').attr('data-task', task).append('<option value="main">主 profile</option><option value="secondary">副 profile</option>').val(p.routes?.[task] || 'main'); routes.append($('<label class="nlc-field">').append($('<span>').text({ analysis:'分析', simulation:'模拟', narrative:'叙事', chat:'试聊' }[task]), sel)); });
        page.append(routes, field('最大生成 token', 'maxTokens', p.maxTokens, 'number'));
        const templates = $('<details><summary>任务附加模板</summary></details>'); ['narrative','chat','analysis','simulation'].forEach(k => templates.append(field({narrative:'叙事',chat:'试聊',analysis:'分析',simulation:'模拟'}[k], `template-${k}`, p.templates?.[k] || '').find('input').attr('data-template', k).end()));
        page.append(templates, button('保存偏好', 'save-preferences'), $('<div class="nlc-row">').append(button('导出数据', 'export'), $('<label class="menu_button nlc-upload">导入数据<input type="file" data-data-file accept=".json,application/json" hidden></label>')));
        if (state.profileError) page.append($('<p class="nlc-error">').text(state.profileError)); pages.append(page);
    }
    // 渲染当前快照而不覆盖焦点字段，且在卡片身份变化时清空临时选择。
    function render() {
        if (destroyed) return;
        const fresh = adapter.snapshot() || {};
        if (fresh.identity !== state.identity) { identityEpoch++; state = fresh; resetIdentity(); }
        else state = fresh;
        const focused = root[0].querySelector(':focus[data-field]'), focusName = focused?.getAttribute('data-field'), focusValue = focused ? $(focused).val() : undefined, start = focused?.selectionStart, end = focused?.selectionEnd, focusIdentity = state.identity, focusTab = tab;
        if (focused && tab === '联系人' && npcId) { const draft = drafts[npcId] || (drafts[npcId] = {}); if (focusName === 'chat-text') draft.chat = focusValue; if (focusName === 'diary-day') draft.day = focusValue; if (focusName === 'diary-chars') draft.chars = focusValue; if (focusName === 'diary-custom') draft.custom = focusValue; }
        if (oldPanel?.parentNode) $(oldPanel).detach();
        root.find('.nlc-world').text(`${state.worldLabel || ''}${state.day ? ` · 第 ${state.day} 天` : ''}`);
        const nav = root.find('.nlc-tabs').empty(); TABS.forEach(name => nav.append(button(name, 'tab', { 'data-tab': name, role: 'tab', 'aria-selected': String(tab === name) }).toggleClass('is-active', tab === name)));
        pages.empty(); ({ '动态': overview, '联系人': contacts, '地图': mapPage, '档案': archive, '设置': settings })[tab]();
        if (focusName && focusIdentity === state.identity && focusTab === tab) { const next = [...root[0].querySelectorAll('[data-field]')].find(el => el.getAttribute('data-field') === focusName); if (next && !['chat-text','diary-day','diary-chars','diary-custom'].includes(focusName)) { $(next).val(focusValue); next.focus({ preventScroll: true }); if (Number.isInteger(start) && next.setSelectionRange && (next.tagName === 'TEXTAREA' || next.type === 'text' || next.type === 'search')) next.setSelectionRange(start, end); } }
        root.toggleClass('has-global-busy', Boolean(busy || state.busy));
    }
    // 保存设置表单内容并由 adapter 持久化。
    function savePrefs() {
        const patch = { userName: root.find('[data-field="userName"]').val(), diaryChars: Number(root.find('[data-field="diaryChars"]').val()), contextChars: Number(root.find('[data-field="contextChars"]').val()), memoryEnabled: root.find('[data-pref="memoryEnabled"]').prop('checked'), memoryChars: Number(root.find('[data-field="memoryChars"]').val()), secondaryProfileId: root.find('[data-field="secondaryProfileId"]').val(), maxTokens: Number(root.find('[data-field="maxTokens"]').val()), routes: {}, templates: {} };
        root.find('[data-route]').each(function () { patch.routes[$(this).attr('data-task')] = $(this).val(); }); root.find('[data-template]').each(function () { patch.templates[$(this).attr('data-template')] = $(this).val(); });
        return adapter.savePreferences(patch);
    }
    // 安全读取图片并仅接受 PNG、JPEG 或 WebP 文件。
    function validateImage(file) { if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('地图只支持 PNG、JPEG 或 WebP 图片。'); return file; }
    // 将用户选择文件导入 adapter，捕获文件解析和宿主错误。
    async function importFile(file) { if (!file) return; return run(() => adapter.importData(file), () => tell('导入完成。')); }
    // 处理窗口控制和卡片操作的事件委托。
    root.on('click.nlc', '[data-action],[data-tab],[data-close],[data-min],[data-max],[data-fab]', function (event) {
        const el = $(this), action = el.attr('data-action');
        if (el.is('[data-tab]')) { tab = el.attr('data-tab'); persist(); render(); return; }
        if (el.is('[data-close]')) { root.prop('hidden', true); persist(); priorFocus?.focus?.(); return; }
        if (el.is('[data-fab]')) { open(); return; }
        if (el.is('[data-min]')) { minimized = !minimized; root.toggleClass('is-minimized', minimized); persist(); return; }
        if (el.is('[data-max]')) { if (!maximized) { const r = root[0].getBoundingClientRect(); restoreRect = { left:r.left, top:r.top, width:r.width, height:r.height }; maximized = true; root.addClass('is-maximized'); } else { maximized = false; root.removeClass('is-maximized'); if (restoreRect) Object.assign(root[0].style, { left:`${restoreRect.left}px`, top:`${restoreRect.top}px`, width:`${restoreRect.width}px`, height:`${restoreRect.height}px` }); } persist(); return; }
        if (action === 'select-npc') { npcId = el.attr('data-npc'); diaryId = ''; tab = '联系人'; render(); return; }
        if (action === 'diary') { const id = npcId, identity = state.identity, day = Number(root.find('[data-field="diary-day"]').val()), selected = root.find('[data-field="diary-chars"]').val(), chars = selected === 'custom' ? Number(root.find('[data-field="diary-custom"]').val()) : Number(selected); if (!Number.isInteger(day) || day < 1 || !Number.isInteger(chars) || chars < 1) { tell('日期和字数必须为正整数。', true); return; } run(() => adapter.generateDiary(id, day, chars), result => { if (typeof result === 'string') diaryId = (state.diaries || []).find(d => d.npcId === id && d.day === day && d.text === result)?.id || ''; tell('日记已生成。'); }, { npc: id, tab: '联系人' }); return; }
        if (action === 'chat-send') { const input = root.find('[data-field="chat-text"]'), text = String(input.val() || '').trim(), id = npcId; if (!text) return; run(() => adapter.sendChat(id, text), () => { const d = drafts[id]; if (d) d.chat = ''; tell('试聊回复已记录。'); }, { npc: id, tab: '联系人' }); return; }
        if (action === 'chat-clear') { const id = npcId; run(() => adapter.clearChat(id), () => tell('试聊记录已清空。')); return; }
        if (action === 'import-map') { const raw = root.find('[data-field="map-json"]').val(); run(async () => { const result = await adapter.importMap(String(raw || '')); if (result === false) return false; return result; }, result => { if (result === false) tell('已取消地图导入。'); else tell('地图数据已导入。'); }); return; }
        if (action === 'save-preferences') { run(savePrefs, () => tell('设置已保存。')); return; }
        if (action === 'memory-refresh') { run(() => adapter.refreshMemory(), result => { if (result) state.memory = result; tell('记忆表已刷新。'); }); return; }
        if (action === 'export') { run(() => adapter.exportData(), () => tell('数据已导出。')); }
    });
    // 处理标签、文件、地图图片、标签编辑和独立试聊提交。
    root.on('change.nlc', '[data-field="map-tag"]', function () { mapTag = $(this).val() || ''; render(); });
    root.on('change.nlc', '[data-field="archive-npc"]', function () { archiveNpc = $(this).val() || ''; render(); });
    root.on('change.nlc', '[data-field="archive-day"]', function () { archiveDay = $(this).val() || ''; render(); });
    root.on('click.nlc', '[data-diary]', function () { diaryId = $(this).attr('data-diary'); render(); });
    root.on('change.nlc', '[data-tags]', function () { const id = $(this).attr('data-id'), value = this.value; run(() => adapter.setLocationTags(id, value), () => tell('地点标签已更新。')); });
    root.on('change.nlc', '[data-map-file]', function () { const file = this.files?.[0]; const input = this; run(() => adapter.setMapImage(validateImage(file)), () => tell('地图图片已更新。')).finally(() => { input.value = ''; }); });
    root.on('change.nlc', '[data-import-file]', function () { const file = this.files?.[0], input = this; if (!file) return; run(() => file.text().then(text => adapter.importMap(text)), () => tell('地图数据已导入。')).finally(() => { input.value = ''; }); });
    root.on('change.nlc', '[data-data-file]', function () { const file = this.files?.[0], input = this; importFile(file).finally(() => { input.value = ''; }); });
    root.on('input.nlc change.nlc', '[data-field="chat-text"],[data-field="diary-day"],[data-field="diary-chars"],[data-field="diary-custom"]', function () { if (!npcId) return; const d = drafts[npcId] || (drafts[npcId] = {}), key = $(this).attr('data-field'); d[{ 'chat-text':'chat', 'diary-day':'day', 'diary-chars':'chars', 'diary-custom':'custom' }[key]] = $(this).val(); });
    root.on('keydown.nlc', '[data-field="chat-text"]', function (event) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); root.find('[data-action="chat-send"]').trigger('click'); } });
    // 支持在标题栏拖动窗口，且不拦截标题栏控制按钮。
    const bar = root.find('[data-drag]')[0]; let drag = null;
    listen(bar, 'pointerdown', event => { if (event.target.closest('button') || innerWidth < 620 || maximized) return; const r = root[0].getBoundingClientRect(); drag = { x:event.clientX, y:event.clientY, left:r.left, top:r.top }; bar.setPointerCapture(event.pointerId); });
    listen(bar, 'pointermove', event => { if (!drag) return; root[0].style.left = `${drag.left + event.clientX - drag.x}px`; root[0].style.top = `${drag.top + event.clientY - drag.y}px`; clampConsole(root[0]); });
    listen(bar, 'pointerup', () => { if (drag) persist(); drag = null; });
    listen(bar, 'pointercancel', () => { if (drag) persist(); drag = null; });
    listen(document, 'keydown', event => { if (event.key === 'Escape' && !root.prop('hidden')) { root.prop('hidden', true); persist(); priorFocus?.focus?.(); } });
    if (window.ResizeObserver) { sizeObserver = new window.ResizeObserver(() => { if (!root.prop('hidden') && !maximized && !minimized) persist(); }); sizeObserver.observe(root[0]); cleanups.push(() => sizeObserver?.disconnect()); }
    root.on('click.nlc', '[data-smaller],[data-larger]', function () { if (innerWidth < 620) return; const delta = $(this).is('[data-smaller]') ? -60 : 60; root[0].style.width = `${Math.max(360, Math.min(innerWidth - 16, root[0].offsetWidth + delta))}px`; root[0].style.height = `${Math.max(300, Math.min(innerHeight - 16, root[0].offsetHeight + delta * .65))}px`; clampConsole(root[0]); persist(); });
    listen(window, 'resize', () => { if (!root.prop('hidden') && !maximized) { clampConsole(root[0]); persist(); } });
    // 添加宿主入口和 body 常驻入口并记住入口清理函数。
    const topHolder = document.getElementById('top-settings-holder');
    if (topHolder) { const launcher = $('<div class="drawer"><div class="drawer-toggle drawer-header" role="button" tabindex="0" title="NPC Life"><i class="fa-solid fa-address-card" aria-label="NPC Life"></i></div></div>'); $(topHolder).append(launcher); launcher.on('click.nlc keydown.nlc', function (e) { if (e.type === 'click' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }); cleanups.push(() => launcher.remove()); }
    const bodyEntry = $('<button type="button" class="menu_button nlc-body-entry" title="打开 NPC Life">NPC Life</button>'); $('body').append(bodyEntry); bodyEntry.on('click.nlc', open); cleanups.push(() => bodyEntry.remove());
    // 从旧设置区入口打开指定页签。
    function open(nextTab) { if (typeof nextTab !== 'string') nextTab = undefined; priorFocus = document.activeElement; if (typeof nextTab === 'string') { const mapped = { dynamic: '动态', overview: '动态', contacts: '联系人', map: '地图', archive: '档案', settings: '设置' }[nextTab.toLowerCase()] || nextTab; if (TABS.includes(mapped)) tab = mapped; } minimized = false; root.removeClass('is-minimized').prop('hidden', false); if (!root[0].style.width) clampConsole(root[0]); render(); persist(); }
    // 销毁实例、恢复移动的原工作台节点并移除全部注册监听器。
    function destroy() { if (destroyed) return; destroyed = true; root.off('.nlc'); cleanups.splice(0).forEach(fn => { try { fn(); } catch (_) {} }); if (oldPanel && oldPanelParent?.isConnected) oldPanelParent.insertBefore(oldPanel, oldPanelNext?.parentNode === oldPanelParent ? oldPanelNext : null); root.remove(); }
    // 初始化持久化几何和页签。
    try { const saved = JSON.parse(localStorage.getItem(CONSOLE_KEY) || 'null'); if (saved && typeof saved === 'object') { if (TABS.includes(saved.tab)) tab = saved.tab; for (const key of ['left','top','width','height']) if (Number.isFinite(saved[key])) root[0].style[key] = `${saved[key]}px`; } } catch (_) {}
    root.css('resize', innerWidth < 620 ? 'none' : 'both'); clampConsole(root[0]); render();
    return { render, destroy, open, isOpen: () => !destroyed && !root.prop('hidden') };
}

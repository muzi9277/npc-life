/* NPC Life standalone console. Requires the host's jQuery and adapter contract. */
const CONSOLE_KEY = 'npc-life:console:v1';
const TABS = ['动态', '联系人', '地图', '档案', '设置'];

// 仅在窗口可见时测量，并将几何信息限制在视口内。
function clampConsole(node) {
    if (node.hidden) return;
    const r = node.getBoundingClientRect(), width = Math.max(1, innerWidth - 16), height = Math.max(1, innerHeight - 16);
    node.style.resize = innerWidth < 620 ? 'none' : 'both';
    if (innerWidth < 620) { Object.assign(node.style, { left: '8px', top: '8px', width: `${width}px`, height: `${Math.min(height, 680, r.height || parseFloat(node.style.height) || 640)}px` }); return; }
    node.style.width = `${Math.min(width, Math.max(360, r.width || parseFloat(node.style.width) || 560))}px`;
    node.style.height = `${Math.min(height, Math.max(300, r.height || parseFloat(node.style.height) || 640))}px`;
    node.style.left = `${Math.max(8, Math.min(innerWidth - (node.offsetWidth || parseFloat(node.style.width)) - 8, r.left || parseFloat(node.style.left) || 48))}px`;
    node.style.top = `${Math.max(8, Math.min(innerHeight - (node.offsetHeight || parseFloat(node.style.height)) - 8, r.top || parseFloat(node.style.top) || 48))}px`;
}

// 挂载非模态控制台，动态文字只经文本 API 插入。
export function mountConsole(adapter) {
    const $ = window.jQuery;
    if (!$ || !adapter) throw new Error('NPC Life 控制台需要 jQuery 和 adapter。');
    $('#npc-life-console').remove();
    let state = adapter.snapshot() || {}, tab = '动态', npcId = '', diaryId = '', busy = false, destroyed = false;
    let minimized = false, maximized = false, restoreRect = null, oldPanel = null, oldPanelParent = null, oldPanelNext = null, automationBusy = false;
    let drafts = Object.create(null), generalDrafts = Object.create(null), renderedIdentity = state.identity, renderedTab = '', renderedNpc = '', identityEpoch = 0;
    let priorFocus = null, sizeObserver = null, modalFocus = null, modalKind = '', modalProfileId = '', modalEpoch = 0, modalBusy = false;
    const cleanups = [], root = $('<section id="npc-life-console" class="nlc" hidden aria-label="NPC Life 控制台" tabindex="-1"></section>');
    root.html(`<header class="nlc-bar" data-drag><strong>NPC Life</strong><span class="nlc-version">3.0.0-beta.3</span><span class="nlc-world"></span><span class="nlc-controls"><button type="button" class="menu_button" data-smaller aria-label="缩小窗口" title="缩小">−</button><button type="button" class="menu_button" data-larger aria-label="放大窗口" title="放大">＋</button><button type="button" class="menu_button" data-min aria-label="最小化窗口" title="最小化">⌄</button><button type="button" class="menu_button" data-max aria-label="最大化或恢复窗口" title="最大化/恢复">□</button><button type="button" class="menu_button" data-close aria-label="关闭窗口" title="关闭">×</button></span></header><nav class="nlc-tabs" role="tablist" aria-label="控制台页面"></nav><div class="nlc-status" role="status" aria-live="polite"></div><main class="nlc-pages" role="tabpanel"></main>`);
    $('body').append(root);
    const channelDialog = $(`<div class="nlc-channel-overlay" hidden><section class="nlc-channel-dialog" role="dialog" aria-modal="true" aria-labelledby="nlc-channel-title" tabindex="-1"><header><b id="nlc-channel-title"></b><button type="button" class="menu_button" data-channel-close aria-label="关闭对话框">×</button></header><div class="nlc-channel-body"></div></section></div>`);
    $('body').append(channelDialog);
    const pages = root.find('.nlc-pages'), status = root.find('.nlc-status');
    // 统一注册可撤销的 DOM 监听器。
    function listen(target, event, fn, opts) { target.addEventListener(event, fn, opts); cleanups.push(() => target.removeEventListener(event, fn, opts)); }
    // 创建不收缩的标准按钮。
    function button(label, action, attrs = {}) { return $('<button type="button" class="menu_button">').text(label).attr({ 'data-action': action, ...attrs }); }
    // 创建带可访问标签的标准字段。
    function field(label, name, value, type = 'text') { return $('<label class="nlc-field">').append($('<span>').text(label), $('<input class="text_pole">').attr({ 'data-field': name, type }).val(value ?? '')); }
    // 将关联内容放在统一的圆角分组卡片内。
    function card(title) { return $('<section class="nlc-card">').append($('<h3>').text(title)); }
    // 用紧凑文字显示空态。
    function empty(text) { return $('<p class="nlc-empty">').text(text); }
    // 保存可见窗口几何，避免隐藏或最小化尺寸污染正常尺寸。
    function persist() {
        if (root.prop('hidden')) return;
        try { const r = maximized ? restoreRect : root[0].getBoundingClientRect(); if (!r) return; const previous = JSON.parse(localStorage.getItem(CONSOLE_KEY) || '{}'); localStorage.setItem(CONSOLE_KEY, JSON.stringify({ left: r.left, top: r.top, width: r.width || parseFloat(root[0].style.width), height: minimized ? (previous.height || 640) : (r.height || parseFloat(root[0].style.height)), tab })); } catch (_) {}
    }
    // 显示本地成功或错误状态。
    function tell(value, error = false) { status.text(value || '').toggleClass('is-error', error); }
    // 为全部控制台字段生成稳定且互不冲突的草稿键。
    function draftKey(el) {
        if (el.hasAttribute('data-field')) return `field:${el.getAttribute('data-field')}`;
        for (const name of ['pref', 'route', 'template', 'tags']) if (el.hasAttribute(`data-${name}`)) return `${name}:${el.getAttribute(name === 'route' ? 'data-task' : name === 'tags' ? 'data-id' : `data-${name}`)}`;
        return '';
    }
    // 在切页或刷新前保存全部表单草稿，旧工作台继续使用原来的监听器。
    function captureDrafts() {
        if (renderedIdentity !== state.identity || !renderedTab) return;
        const bucket = renderedTab === '联系人' ? (drafts[renderedNpc] ||= Object.create(null)) : (generalDrafts[renderedTab] ||= Object.create(null));
        pages.find('[data-field],[data-pref],[data-route],[data-template],[data-tags]').each(function () {
            if ($(this).closest('.nlc-workbench-body').length) return;
            const key = draftKey(this); if (key) bucket[key] = this.type === 'checkbox' ? this.checked : this.tagName === 'SELECT' ? this.value : $(this).val();
        });
        pages.find('details[data-draft-details]').each(function () { bucket[`details:${this.getAttribute('data-draft-details')}`] = this.open; });
    }
    // 恢复当前身份及页面的表单草稿。
    function restoreDrafts() {
        const bucket = tab === '联系人' ? drafts[npcId] : generalDrafts[tab];
        if (bucket) {
            pages.find('[data-field],[data-pref],[data-route],[data-template],[data-tags]').each(function () { if ($(this).closest('.nlc-workbench-body').length) return; const key = draftKey(this); if (Object.hasOwn(bucket, key)) { if (this.type === 'checkbox') this.checked = bucket[key]; else $(this).val(bucket[key]); } });
            pages.find('details[data-draft-details]').each(function () { const key = `details:${this.getAttribute('data-draft-details')}`; if (Object.hasOwn(bucket, key)) this.open = bucket[key]; });
        }
        updateCustomChars();
    }
    // 仅在选择自定义篇幅时显示自定义字数字段。
    function updateCustomChars() { root.find('[data-custom-chars]').prop('hidden', root.find('[data-field="diary-chars"]').val() !== 'custom'); }
    // 切换身份时丢弃旧身份草稿和所有临时选择。
    function resetIdentity() { npcId = ''; diaryId = ''; drafts = Object.create(null); generalDrafts = Object.create(null); renderedTab = ''; closeDialog(false); tell(''); }
    // 捕获异步异常并拒绝把旧身份的结果应用到新身份。
    async function run(action, success, targets = {}) {
        if (busy || state.busy || destroyed) return false;
        captureDrafts();
        const identity = state.identity, epoch = identityEpoch;
        busy = true; root.addClass('is-busy'); tell('处理中…');
        try {
            const result = await action();
            if (destroyed) return false;
            const fresh = adapter.snapshot() || {};
            if (fresh.identity !== identity || identityEpoch !== epoch) { if (fresh.identity !== state.identity) { state = fresh; identityEpoch++; resetIdentity(); } tell('角色卡已切换，旧请求结果已忽略。', true); render(false); return false; }
            state = fresh;
            if (result === false) tell('操作已取消。');
            else if ((!targets.npc || targets.npc === npcId) && (!targets.tab || targets.tab === tab)) success?.(result);
            render(false); return result !== false;
        } catch (error) { if (!destroyed && epoch === identityEpoch) tell(error?.message || String(error), true); return false; }
        finally { busy = false; root.removeClass('is-busy'); root.toggleClass('has-global-busy', Boolean(state.busy)); }
    }
    // 后台自动记录仅以文本展示，心理侧写不作为角色事实。
    function autoNotesCard(npc = null) {
        const notes = (state.autoNotes || []).filter(n => !npc || n.npcId === npc.id).slice().sort((a,b) => (Number(b.ts) || Date.parse(b.ts) || 0) - (Number(a.ts) || Date.parse(a.ts) || 0)).slice(0, npc ? 12 : 20);
        const section = card(npc ? '相关自动记录' : '最新自动记录').attr('data-auto-notes', npc ? npc.id : 'latest');
        section.append($('<p class="nlc-muted">').text('后台生成的动作、活动与心理侧写仅供参考；心理侧写不权威。'));
        notes.forEach(n => section.append($('<article class="nlc-item nlc-auto-note">').attr('data-note-id',n.id).append($('<b>').text(`${n.npcName || npc?.name || n.npcId || '未知联系人'} · 第 ${n.day ?? '?'} 天 · ${{ gesture:'动作', psychology:'心理侧写（仅供参考）', activity:'活动' }[n.kind] || '记录'}`), $('<p>').text(n.text || ''))));
        if (!notes.length) section.append(empty(npc ? '此联系人暂无自动记录。' : '暂无自动记录。自动运转默认关闭，可在设置中启用。'));
        return section;
    }
    // 自动状态来自核心快照；暂停与重置不修改其他表单草稿。
    function automationCard() {
        const a = state.automation || {}, every = a.every ?? state.preferences?.autoEveryReplies ?? 5;
        const labels = { idle:'等待新 AI 正文', paused:'已暂停', disabled:'已关闭', running:'运行中', pending:'等待处理', waiting_generation:'等待正文生成结束', waiting_busy:'等待其他任务结束', paused_error:'出错后已暂停', unsupported:'当前宿主不支持自动运转', destroyed:'已停止' };
        const section = card('自动运转').attr('data-automation','');
        section.append($('<p data-automation-status role="status" aria-live="polite">').text(`${a.enabled ? '已启用' : '已关闭'} · ${labels[a.status] || a.status || '等待新 AI 正文'} · 新 AI 正文 ${a.count ?? 0} / ${every}${a.pending ? ' · 有待处理任务' : ''}`));
        if (a.unsupported) section.append($('<p class="nlc-muted">').text(typeof a.unsupported === 'string' ? a.unsupported : '当前宿主不支持自动运转事件，请使用手动操作。'));
        if (a.error) section.append($('<p class="nlc-error">').text(a.error));
        section.append($('<div class="nlc-row">').append(button('暂停自动运转', 'pause-automation').prop('disabled', !a.enabled || typeof adapter.pauseAutomation !== 'function'), button('重置计数', 'reset-automation').prop('disabled', typeof adapter.resetAutomation !== 'function')), $('<p class="nlc-muted">').text('仅按新 AI 正文计数；达到间隔后每轮最多轮转 6 位联系人，每轮 2 次请求（analysis + simulation）。不推进日期，不向主聊天写正文；心理侧写不权威。'));
        return section;
    }
    // 暂停应在自动任务占用核心时仍可执行，单独防止重复点击。
    async function controlAutomation(reset = false) {
        if (automationBusy || destroyed) return;
        captureDrafts(); automationBusy = true; const epoch = identityEpoch;
        try { await (reset ? adapter.resetAutomation() : adapter.pauseAutomation()); if (!destroyed && epoch === identityEpoch) { render(false); tell(reset ? '自动运转计数已重置。' : '自动运转已暂停。'); } }
        catch (error) { if (!destroyed && epoch === identityEpoch) tell(error?.message || String(error),true); }
        finally { automationBusy = false; }
    }
    // 创建动态总览并只移动旧工作台节点以保留监听器。
    function overview() {
        const page = $('<div class="nlc-page">'), cards = $('<div class="nlc-grid">');
        (state.npcs || []).filter(n => n.confirmed || n.tracked).forEach(n => cards.append($('<article class="nlc-item">').append($('<h3>').text(n.name || '未命名 NPC'), $('<p>').text(`${n.locationName || '地点未知'} · ${n.activity || n.status || '暂无活动'}`), n.scene ? $('<p class="nlc-muted">').text(n.scene) : '', button('查看联系人', 'select-npc', { 'data-npc': n.id }))));
        if (!cards.children().length) cards.append(empty('暂无联系人动态。可在高级世界工作台中确认角色与地点。'));
        const workbench = $('<details class="nlc-workbench"><summary>高级世界工作台</summary><div class="nlc-workbench-body"></div></details>');
        try { const panel = oldPanel || adapter.getWorkbench?.(); if (panel?.nodeType) { if (!oldPanel) { oldPanel = panel; oldPanelParent = panel.parentNode; oldPanelNext = panel.nextSibling; } workbench.find('.nlc-workbench-body').append(panel); } }
        catch (error) { tell(error?.message || String(error), true); }
        page.append(automationCard(), autoNotesCard(), cards, workbench); pages.append(page);
    }
    // 创建联系人资料、日记和独立后台试聊分组。
    function contacts() {
        const page = $('<div class="nlc-page nlc-contact">'), roster = $('<aside class="nlc-roster" aria-label="联系人列表">'), detail = $('<section class="nlc-detail">');
        (state.npcs || []).forEach(n => roster.append(button(n.name || '未命名', 'select-npc', { 'data-npc': n.id, 'aria-pressed': String(n.id === npcId), title: n.name || '未命名' }).toggleClass('is-active', n.id === npcId)));
        const npc = (state.npcs || []).find(n => n.id === npcId);
        if (!npc) detail.append(empty((state.npcs || []).length ? '选择联系人查看详情、日记与试聊。' : '暂无活跃联系人。已归档联系人可在档案页恢复。'));
        else {
            const info = card(npc.name || '未命名 NPC').append($('<p>').text([npc.locationName, npc.activity || npc.status, npc.relationship].filter(Boolean).join(' · ') || '暂无动态信息'));
            info.append($('<div class="nlc-row">').append(button('删除联系人', 'archive-npc'), button('永久忽略', 'ignore-npc')), $('<p class="nlc-muted">').text('删除或忽略后仍保留历史，可在档案页恢复。'));
            const diaryCard = card('日记'), charsValue = Number(state.preferences?.diaryChars || 800);
            const chars = $('<select class="text_pole" data-field="diary-chars"><option value="50">50 字</option><option value="200">200 字</option><option value="800">800 字</option><option value="1600">1600 字</option><option value="custom">自定义</option></select>').val([50,200,800,1600].includes(charsValue) ? String(charsValue) : 'custom');
            diaryCard.append($('<div class="nlc-form-grid">').append(field('日期', 'diary-day', state.day || 1, 'number').find('input').attr({ min:1, max:1000000 }).end(), $('<label class="nlc-field">').append($('<span>').text('篇幅'), chars), field('自定义字数', 'diary-custom', charsValue, 'number').attr('data-custom-chars', '').find('input').attr({ min:1, max:10000 }).end()), $('<div class="nlc-row">').append(button('生成日记', 'diary'), button('取消草稿', 'cancel-contact')));
            const list = $('<div class="nlc-list">');
            (state.diaries || []).filter(d => d.npcId === npc.id).slice().sort((a,b) => b.day-a.day).forEach(d => list.append($('<button type="button" class="nlc-list-row">').text(`第 ${d.day} 天 · ${(d.text || '').slice(0,90)}`).attr('data-diary', d.id)));
            diaryCard.append(list.children().length ? list : empty('还没有日记，选择日期与篇幅后生成。'));
            const diary = (state.diaries || []).find(d => d.id === diaryId && d.npcId === npc.id);
            if (diary) diaryCard.append($('<article class="nlc-reading">').append($('<h3>').text(`第 ${diary.day} 天`), $('<p>').text(diary.text || '')));
            const chatCard = card('后台试聊'), chat = $('<div class="nlc-chat" role="log" aria-label="试聊记录">');
            ((state.conversations || {})[npc.id] || []).forEach(m => chat.append($('<div class="nlc-bubble">').addClass(m.role === 'user' ? 'from-user' : 'from-npc').text(m.content || '')));
            chatCard.append(chat, chat.children().length ? '' : empty('还没有试聊记录。此处独立保存，不发送到酒馆主聊天。'), $('<label class="nlc-field">').append($('<span>').text('试聊消息'), $('<textarea class="text_pole" data-field="chat-text" rows="3" placeholder="Enter 发送，Shift+Enter 换行"></textarea>')), $('<div class="nlc-row">').append(button('发送', 'chat-send'), button('清空记录', 'chat-clear')));
            detail.append(info, autoNotesCard(npc), diaryCard, chatCard);
        }
        page.append(roster, detail); pages.append(page);
    }
    // 绘制有坐标的已确认地点，空地图不占据大块区域。
    function mapPage() {
        const page = $('<div class="nlc-page">'), locations = (state.locations || []).filter(l => l.confirmed), tags = [...new Set(locations.flatMap(l => l.tags || []))];
        const filter = $('<select class="text_pole" data-field="map-tag"><option value="">全部标签</option></select>'); tags.forEach(t => filter.append($('<option>').val(t).text(t)));
        const mapTag = generalDrafts['地图']?.['field:map-tag'] || '', area = $('<div class="nlc-map">');
        const hasImage = typeof state.mapImage === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(state.mapImage);
        if (hasImage) area.css('background-image', `url("${state.mapImage}")`);
        locations.filter(l => !mapTag || (l.tags || []).includes(mapTag)).forEach(l => { if (Number.isFinite(l.x) && Number.isFinite(l.y) && l.x >= 0 && l.x <= 100 && l.y >= 0 && l.y <= 100) area.append($('<span class="nlc-map-node">').text(l.name || '地点').css({ left:`${l.x}%`, top:`${l.y}%` })); });
        const tagRows = $('<div class="nlc-locations">');
        locations.filter(l => !mapTag || (l.tags || []).includes(mapTag)).forEach(l => {
            const occupants = (state.npcs || []).filter(n => n.locationId === l.id).map(n => `${n.name || 'NPC'}${n.status === 'unknown' ? '（未知）' : ''}`).join('、') || '暂无 NPC';
            const routes = (state.routes || []).filter(r => r.fromId === l.id || r.toId === l.id).map(r => { const target = (state.locations || []).find(x => x.id === (r.fromId === l.id ? r.toId : r.fromId)); return `${target?.name || '未知地点'} · ${r.durationDays || '?'} 天`; }).join('、') || '无已确认路线';
            tagRows.append($('<div class="nlc-item">').append($('<b>').text(l.name || '地点'), $('<p>').text(`${occupants} · 路线：${routes}`), $('<label class="nlc-field">').append($('<span>').text('标签（逗号分隔）'), $('<input class="text_pole" data-tags>').attr('data-id', l.id).val((l.tags || []).join(', '))), $('<div class="nlc-row">').append(button('保存标签', 'save-tags', { 'data-id':l.id }), button('取消', 'cancel-tags', { 'data-id':l.id }))));
        });
        const imports = card('地图导入').append($('<div class="nlc-row">').append($('<label class="menu_button nlc-upload">上传地图<input type="file" data-map-file accept="image/png,image/jpeg,image/webp" hidden></label>'), $('<label class="menu_button nlc-upload">导入 JSON 文件<input type="file" data-import-file accept=".json,application/json" hidden></label>')), $('<label class="nlc-field">').append($('<span>').text('JSON 地图数据'), $('<textarea class="text_pole" data-field="map-json" rows="3" placeholder="粘贴 JSON 地图数据"></textarea>')), $('<div class="nlc-row">').append(button('导入粘贴内容', 'import-map'), button('取消草稿', 'cancel-map')));
        page.append($('<label class="nlc-field">').append($('<span>').text('地点标签筛选'), filter), hasImage || area.children().length ? area : empty('暂无底图或有坐标的地点，可上传地图或导入地点坐标。'), tagRows.children().length ? tagRows : empty('暂无符合筛选的已确认地点。'), imports); pages.append(page);
    }
    // 展示历史筛选、归档联系人恢复入口和只读记忆表。
    function archive() {
        const page = $('<div class="nlc-page">'), who = $('<select class="text_pole" data-field="archive-npc"><option value="">全部联系人</option></select>'), filterDraft = generalDrafts['档案'] || {};
        const allNpcs = [...(state.npcs || []), ...(state.archivedNpcs || [])];
        allNpcs.forEach(n => who.append($('<option>').val(n.id).text(n.name || n.id)));
        page.append($('<div class="nlc-form-grid">').append($('<label class="nlc-field">').append($('<span>').text('联系人'), who), field('日期', 'archive-day', '', 'number').find('input').attr('min',1).end()));
        const chosen = filterDraft['field:archive-npc'] || '', chosenDay = Number(filterDraft['field:archive-day']);
        const events = card('生活事件'); (state.events || []).filter(e => (!chosen || (e.npcIds || []).includes(chosen)) && (!chosenDay || e.day === chosenDay)).slice().sort((a,b) => b.day-a.day).forEach(e => events.append($('<article class="nlc-item">').append($('<b>').text(`第 ${e.day} 天 · ${e.kind || '事件'}`), $('<p>').text(e.summary || ''), $('<small>').text(e.source || ''))));
        const diaries = card('日记'); (state.diaries || []).filter(d => (!chosen || d.npcId === chosen) && (!chosenDay || d.day === chosenDay)).forEach(d => diaries.append($('<article class="nlc-item">').append($('<b>').text(`第 ${d.day} 天`), $('<p>').text(d.text || ''))));
        if (events.children().length === 1) events.append(empty('暂无符合筛选的生活事件。')); if (diaries.children().length === 1) diaries.append(empty('暂无符合筛选的日记。'));
        const archived = card('已归档联系人');
        (state.archivedNpcs || []).forEach(n => archived.append($('<article class="nlc-item">').append($('<b>').text(n.name || n.id), $('<p>').text(n.ignored ? '永久忽略中：不会自动重新加入，恢复后解除忽略。' : '已从联系人移除，历史记录保留。'), button('恢复联系人', 'restore-npc', { 'data-npc': n.id }))));
        if (archived.children().length === 1) archived.append(empty('暂无归档联系人。'));
        const memory = $('<details class="nlc-memory nlc-card" data-draft-details="memory"><summary>增强记忆表</summary></details>');
        if (!state.memory?.available) memory.append($('<p class="nlc-muted">').text(state.memory?.message || '记忆存储不可用。'));
        else (state.memory.tables || []).forEach((t,i) => { const table = $('<details>').attr('data-draft-details', `memory-${i}`).append($('<summary>').text(t.name || '数据表')); table.append($('<pre class="nlc-pre">').text(JSON.stringify(t.data ?? [], null, 2))); memory.append(table); });
        memory.append(button('刷新记忆', 'memory-refresh')); page.append(archived, events, diaries, memory); pages.append(page);
    }
    // 原生 Connection Manager 的配置流程，不在控制台伪造参数输入。
    function connectionGuide() {
        const guide = $('<details class="nlc-connection-guide" data-draft-details="connection-guide"><summary>如何新增副连接（原生 Connection Manager）</summary></details>'), steps = $('<ol>');
        ['先在酒馆 Connection Manager 中将当前主连接保存为主 profile。', '打开酒馆 API 抽屉，配置副连接的供应商、地址、模型与密钥。', '在 Connection Manager 中为这套副连接创建并保存一个 profile。', '切回原来的主 profile，确认主聊天仍使用主连接。', '重新打开 NPC Life 设置，点击“刷新列表”，选择副 profile，再保存偏好及任务路由。'].forEach(text => steps.append($('<li>').text(text)));
        return guide.append(steps, $('<p class="nlc-muted">').text('打开管理器时会暂时隐藏控制台，草稿保留。Profile 与密钥的保存方式由酒馆决定，不能保证同一供应商的不同 profile 使用独立密钥；请在原生 API 抽屉核对实际密钥。'));
    }
    // 按用途分组展示偏好、模型路由、模板与数据管理。
    function settings() {
        const p = state.preferences || {}, page = $('<div class="nlc-page nlc-settings">');
        const basic = card('基础偏好').append($('<div class="nlc-form-grid">').append(field('用户称呼', 'userName', p.userName), field('日记字数', 'diaryChars', p.diaryChars, 'number'), field('上下文预算', 'contextChars', p.contextChars, 'number')));
        const memory = card('增强记忆').append($('<label class="checkbox_label"><input type="checkbox" data-pref="memoryEnabled"><span>启用增强记忆</span></label>').find('input').prop('checked', Boolean(p.memoryEnabled)).end(), field('记忆预算', 'memoryChars', p.memoryChars, 'number'));
        const auto = card('自动运转').append($('<label class="checkbox_label"><input type="checkbox" data-pref="autoEnabled"><span>启用自动运转（默认关闭）</span></label>').find('input').prop('checked', p.autoEnabled === true).end(), field('每多少条新 AI 正文运行一次', 'autoEveryReplies', p.autoEveryReplies ?? 5, 'number').find('input').attr({ min:1, max:100, step:1 }).end(), $('<p class="nlc-muted">').text('仅按新 AI 正文计数；每轮最多轮转 6 位联系人，每轮 2 次请求（analysis + simulation）。不推进日期，不向主聊天写正文；心理侧写仅供参考，不权威。保存偏好后生效，可在动态页暂停或重置计数。'));
        const profile = $('<select class="text_pole" data-field="secondaryProfileId"><option value="">无副 profile</option></select>'), profiles = state.profiles || [];
        profiles.forEach(x => profile.append($('<option>').val(x.id).text(`${x.name || x.id} · ${x.model || '模型未知'}`)));
        // 失效的已保存选择及刷新前的草稿都保留，disabled option 不能由 jQuery.val() 读取。
        const selected = generalDrafts['设置']?.['field:secondaryProfileId'] ?? p.secondaryProfileId ?? '';
        new Set([p.secondaryProfileId, selected].filter(Boolean)).forEach(id => { if (!profiles.some(x => x.id === id)) profile.append($('<option disabled>').val(id).text(`不可用 profile：${id}（保留选择，请刷新或重新选择）`)); });
        profile.val(selected);
        const connection = card('模型与任务路由').append($('<label class="nlc-field">').append($('<span>').text('副 API profile'), profile), $('<div class="nlc-row">').append(button('新增/管理连接', 'manage-connections'), button('刷新列表', 'refresh-profiles'), button('查看 profile / 测试连接', 'edit-secondary-profile')), $('<p class="nlc-muted">').text('渠道由酒馆 Connection Manager 管理。保存偏好后可测试副连接，路由随保存生效。'), connectionGuide());
        if (state.profileError) connection.append($('<p class="nlc-error" data-profile-error role="alert">').text(`连接列表读取失败：${state.profileError}`));
        else if (!profiles.length) connection.append(empty(state.profileMessage || '连接列表已读取，暂无可用 profile。请先新增连接，再刷新列表。').attr('data-profile-empty',''));
        const routes = $('<div class="nlc-form-grid">'); ['analysis','simulation','narrative','chat'].forEach(task => { const sel = $('<select class="text_pole" data-route>').attr('data-task',task).append('<option value="main">主 profile</option><option value="secondary">副 profile</option>').val(p.routes?.[task] || 'main'); routes.append($('<label class="nlc-field">').append($('<span>').text({ analysis:'分析', simulation:'模拟', narrative:'叙事', chat:'试聊' }[task]), sel)); });
        connection.append(routes, field('最大生成 token', 'maxTokens', p.maxTokens, 'number'));
        const templates = $('<details class="nlc-card" data-draft-details="templates"><summary>任务附加模板</summary></details>'); ['narrative','chat','analysis','simulation'].forEach(k => templates.append($('<label class="nlc-field">').append($('<span>').text({narrative:'叙事',chat:'试聊',analysis:'分析',simulation:'模拟'}[k]), $('<textarea class="text_pole" rows="3" data-template>').attr('data-template', k).val(p.templates?.[k] || ''))));
        const data = card('数据管理').append($('<div class="nlc-row">').append(button('导出数据', 'export'), $('<label class="menu_button nlc-upload">导入数据<input type="file" data-data-file accept=".json,application/json" hidden></label>')));
        page.append(basic, memory, auto, connection, templates, $('<div class="nlc-row nlc-save-row">').append(button('保存偏好', 'save-preferences'), button('取消修改', 'cancel-preferences')), data);
        pages.append(page);
    }
    // 刷新视图前保留草稿、输入焦点、光标和滚动位置。
    function render(capture = true) {
        if (destroyed) return;
        if (capture !== false) captureDrafts();
        const fresh = adapter.snapshot() || {}, changedIdentity = fresh.identity !== state.identity;
        if (changedIdentity) { identityEpoch++; state = fresh; resetIdentity(); } else state = fresh;
        const focused = document.activeElement, key = focused && pages[0].contains(focused) ? draftKey(focused) : '', start = focused?.selectionStart, end = focused?.selectionEnd;
        const canFocus = !changedIdentity && renderedTab === tab && renderedNpc === npcId, scroll = canFocus ? pages.scrollTop() : 0;
        if (oldPanel?.parentNode) $(oldPanel).detach();
        root.find('.nlc-world').text(`${state.worldLabel || ''}${state.day ? ` · 第 ${state.day} 天` : ''}`);
        const nav = root.find('.nlc-tabs').empty(); TABS.forEach((name,i) => nav.append(button(name, 'tab', { 'data-tab':name, role:'tab', id:`nlc-tab-${i}`, 'aria-controls':'nlc-current-page', 'aria-selected':String(tab === name), tabindex:tab === name ? '0' : '-1' }).toggleClass('is-active',tab === name)));
        pages.attr({ id:'nlc-current-page', 'aria-labelledby':`nlc-tab-${TABS.indexOf(tab)}` }).empty(); ({ '动态':overview, '联系人':contacts, '地图':mapPage, '档案':archive, '设置':settings })[tab]();
        restoreDrafts(); pages.scrollTop(scroll); renderedIdentity = state.identity; renderedTab = tab; renderedNpc = npcId;
        if (canFocus && key && !modalKind) { const next = [...pages[0].querySelectorAll('input,select,textarea')].find(el => draftKey(el) === key); if (next) { next.focus({ preventScroll:true }); if (Number.isInteger(start) && next.setSelectionRange && (next.tagName === 'TEXTAREA' || ['text','search'].includes(next.type))) next.setSelectionRange(start,end); } }
        root.toggleClass('has-global-busy', Boolean(busy || state.busy));
    }
    // 将设置表单转换为 adapter 接受的偏好补丁。
    function preferencePatch() {
        const patch = { userName:root.find('[data-field="userName"]').val(), diaryChars:Number(root.find('[data-field="diaryChars"]').val()), contextChars:Number(root.find('[data-field="contextChars"]').val()), memoryEnabled:root.find('[data-pref="memoryEnabled"]').prop('checked'), memoryChars:Number(root.find('[data-field="memoryChars"]').val()), secondaryProfileId:root.find('[data-field="secondaryProfileId"]')[0]?.value || '', autoEnabled:root.find('[data-pref="autoEnabled"]').prop('checked'), autoEveryReplies:Number(root.find('[data-field="autoEveryReplies"]').val()), maxTokens:Number(root.find('[data-field="maxTokens"]').val()), routes:{}, templates:{} };
        root.find('[data-route]').each(function () { patch.routes[$(this).attr('data-task')] = $(this).val(); }); root.find('[data-template]').each(function () { patch.templates[$(this).attr('data-template')] = $(this).val(); }); return patch;
    }
    // 只接受明确支持的地图图片格式。
    function validateImage(file) { if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('地图只支持 PNG、JPEG 或 WebP 图片。'); return file; }
    // 打开对话框并将焦点移入对话框。
    function showDialog(title, kind) { closeDialog(false); modalFocus = document.activeElement; modalKind = kind; modalEpoch++; channelDialog.find('#nlc-channel-title').text(title); channelDialog.find('.nlc-channel-body').empty(); channelDialog.prop('hidden',false); root.attr('inert',''); }
    // 关闭对话框并尽可能恢复触发控件焦点。
    function closeDialog(restore = true) { const focus = modalFocus; modalEpoch++; modalKind = ''; modalBusy = false; modalProfileId = ''; channelDialog.prop('hidden',true); root.removeAttr('inert'); if (restore && !root.prop('hidden')) { if (focus?.isConnected) focus.focus(); else (root.find('[data-action="edit-secondary-profile"]')[0] || root[0]).focus(); } }
    // 管理器由宿主显示；先撤掉本地遮罩，失败时恢复控制台并显示错误。
    async function openConnectionManager(event) {
        event?.preventDefault(); event?.stopPropagation(); captureDrafts();
        const wasHidden = root.prop('hidden'); closeDialog(false); persist(); root.prop('hidden',true);
        try { if (typeof adapter.openConnectionManager !== 'function') throw new Error('当前核心尚未提供 Connection Manager 入口。'); await adapter.openConnectionManager(); }
        catch (error) { if (!destroyed) { root.prop('hidden',wasHidden); tell(error?.message || String(error),true); if (!wasHidden) (root.find('[data-action="manage-connections"]')[0] || root[0]).focus(); } }
    }
    // 展示真实 profile 的只读详情，不伪装可编辑连接参数。
    function openChannelDialog() {
        captureDrafts(); const id = String(root.find('[data-field="secondaryProfileId"]')[0]?.value || ''), current = state.profiles?.find(item => item.id === id);
        showDialog('副 API profile 详情', 'profile'); modalProfileId = current?.id || '';
        const body = channelDialog.find('.nlc-channel-body'), details = $('<dl class="nlc-profile-details">');
        [['名称',current?.name || current?.id || '未选择'],['Profile ID',current?.id || '—'],['模型',current?.model || '未知'],['预设',current?.preset || '默认']].forEach(([label,value]) => details.append($('<dt>').text(label), $('<dd>').text(value)));
        const canTest = current && current.id === state.preferences?.secondaryProfileId;
        body.append(details, $('<p class="nlc-muted">').text('此处显示当前选择的 profile。地址、密钥及连接参数请在酒馆内置 Connection Manager 中管理。'), connectionGuide(), $('<div class="nlc-channel-actions">').append($('<button type="button" class="menu_button" data-channel-manager>新增/管理连接</button>'), $('<button type="button" class="menu_button" data-channel-test>测试此 profile</button>').prop('disabled',!canTest || typeof adapter.testSecondaryProfile !== 'function'), $('<button type="button" class="menu_button" data-channel-done>关闭</button>')), $('<div class="nlc-status" data-channel-status role="status" aria-live="polite">').text(!current ? '请先选择一个可用的副 API profile。' : !canTest ? '此 profile 尚未保存，请关闭弹窗并保存偏好后再测试。' : '测试会向此已保存的 profile 发起真实请求。'));
        channelDialog.find('[data-channel-close]')[0].focus();
    }
    // 在对话框内执行真实连接测试，并隔离已关闭或旧身份的结果。
    async function testProfile() {
        if (modalBusy || busy || state.busy || !modalProfileId || modalProfileId !== state.preferences?.secondaryProfileId) return;
        const id = modalProfileId, epoch = modalEpoch, identity = state.identity;
        modalBusy = true; channelDialog.find('[data-channel-test]').prop('disabled',true); channelDialog.find('[data-channel-status]').text('正在测试连接…').removeClass('is-error');
        try { const result = await adapter.testSecondaryProfile(id); if (epoch !== modalEpoch || destroyed) return; if ((adapter.snapshot() || {}).identity !== identity) { render(); return; } if (result === false) throw new Error('连接测试未通过或已取消。'); channelDialog.find('[data-channel-status]').text(`测试通过：${result?.name || id}，返回：${String(result?.result ?? result ?? '').slice(0,120)}`); }
        catch (error) { if (epoch === modalEpoch && !destroyed) channelDialog.find('[data-channel-status]').text(error?.message || String(error)).addClass('is-error'); }
        finally { if (epoch === modalEpoch) { modalBusy = false; channelDialog.find('[data-channel-test]').prop('disabled',false); } }
    }
    // 删除与永久忽略均明确说明保留历史且可从档案恢复。
    function confirmArchive(ignored) {
        const npc = (state.npcs || []).find(n => n.id === npcId); if (!npc) return;
        const id = npc.id, identity = state.identity; showDialog(ignored ? '确认永久忽略联系人' : '确认删除联系人', 'confirm');
        const message = ignored ? `永久忽略「${npc.name || id}」后，该角色将移出活跃联系人，并阻止后续自动重新加入。已有日记、事件、试聊和其他历史记录保留；可在档案页恢复并解除忽略。` : `删除「${npc.name || id}」会将该角色移出活跃联系人并归档，不会删除已有日记、事件、试聊和其他历史记录。可在档案页恢复；扫描不会自动恢复已删除的联系人。`;
        const body = channelDialog.find('.nlc-channel-body'); body.append($('<p>').text(message), $('<div class="nlc-channel-actions">').append($('<button type="button" class="menu_button" data-channel-done>取消</button>'), $('<button type="button" class="menu_button" data-confirm-archive>').text(ignored ? '确认永久忽略' : '确认删除')));
        body.find('[data-confirm-archive]').on('click.nlcConfirm', () => { if (identity !== (adapter.snapshot() || {}).identity) { render(); return; } closeDialog(); run(() => { if (typeof adapter.archiveNpc !== 'function') throw new Error('当前核心尚未提供联系人归档接口。'); return adapter.archiveNpc(id,ignored); }, () => { delete drafts[id]; if (npcId === id) { npcId = ''; diaryId = ''; } tell(ignored ? '联系人已永久忽略，历史保留，可在档案恢复。' : '联系人已归档，历史保留。'); }); });
        body.find('[data-channel-done]')[0].focus();
    }
    // 处理窗口控制和业务按钮，并在切换前保存草稿。
    root.on('click.nlc', '[data-action],[data-tab],[data-close],[data-min],[data-max]', function (event) {
        const el = $(this), action = el.attr('data-action'); captureDrafts();
        if (action === 'manage-connections') { openConnectionManager(event); return; }
        if (action === 'refresh-profiles') { try { render(false); tell('连接列表已刷新，未保存的草稿已保留。'); } catch (error) { tell(error?.message || String(error),true); } return; }
        if (action === 'pause-automation') { controlAutomation(); return; }
        if (action === 'reset-automation') { controlAutomation(true); return; }
        if (el.is('[data-tab]')) { tab = el.attr('data-tab'); persist(); render(false); root.find(`[data-tab="${tab}"]`)[0]?.focus(); return; }
        if (el.is('[data-close]')) { persist(); root.prop('hidden',true); priorFocus?.focus?.(); return; }
        if (el.is('[data-min]')) { if (!minimized) persist(); minimized = !minimized; root.toggleClass('is-minimized',minimized); if (!minimized) { clampConsole(root[0]); persist(); } return; }
        if (el.is('[data-max]')) { if (!maximized) { const r = root[0].getBoundingClientRect(); restoreRect = { left:r.left, top:r.top, width:r.width, height:minimized ? parseFloat(root[0].style.height) : r.height }; maximized = true; root.addClass('is-maximized'); } else { maximized = false; root.removeClass('is-maximized'); if (restoreRect) Object.assign(root[0].style,{ left:`${restoreRect.left}px`,top:`${restoreRect.top}px`,width:`${restoreRect.width}px`,height:`${restoreRect.height}px` }); clampConsole(root[0]); } persist(); return; }
        if (action === 'select-npc') { npcId = el.attr('data-npc'); diaryId = ''; tab = '联系人'; render(false); return; }
        if (action === 'cancel-contact') { delete drafts[npcId]; render(false); tell('联系人表单草稿已取消。'); return; }
        if (action === 'cancel-preferences') { delete generalDrafts['设置']; render(false); tell('已恢复保存的偏好。'); return; }
        if (action === 'cancel-map') { if (generalDrafts['地图']) delete generalDrafts['地图']['field:map-json']; render(false); tell('地图导入草稿已取消。'); return; }
        if (action === 'edit-secondary-profile') { openChannelDialog(); return; }
        if (action === 'archive-npc' || action === 'ignore-npc') { if (!busy && !state.busy) confirmArchive(action === 'ignore-npc'); return; }
        if (action === 'restore-npc') { const id = el.attr('data-npc'); run(() => { if (typeof adapter.restoreNpc !== 'function') throw new Error('当前核心尚未提供联系人恢复接口。'); return adapter.restoreNpc(id); }, () => tell('联系人已恢复，历史记录继续保留。')); return; }
        if (action === 'diary') { const id = npcId, day = Number(root.find('[data-field="diary-day"]').val()), selected = root.find('[data-field="diary-chars"]').val(), chars = selected === 'custom' ? Number(root.find('[data-field="diary-custom"]').val()) : Number(selected); if (!Number.isInteger(day) || day < 1 || day > 1000000 || !Number.isInteger(chars) || chars < 1 || chars > 10000) { tell('日期须为 1–1000000 的整数，字数须为 1–10000 的整数。',true); return; } run(() => adapter.generateDiary(id,day,chars), result => { if (typeof result === 'string') diaryId = (state.diaries || []).find(d => d.npcId === id && d.day === day && d.text === result)?.id || ''; tell('日记已生成并保存。'); }, { npc:id, tab:'联系人' }); return; }
        if (action === 'chat-send') { const text = String(root.find('[data-field="chat-text"]').val() || '').trim(), id = npcId; if (!text) return; run(() => adapter.sendChat(id,text), () => { if (drafts[id]?.['field:chat-text']?.trim() === text) drafts[id]['field:chat-text'] = ''; tell('试聊回复已记录。'); }, { npc:id, tab:'联系人' }); return; }
        if (action === 'chat-clear') { const id = npcId; run(() => adapter.clearChat(id), () => tell('试聊记录已清空。')); return; }
        if (action === 'import-map') { const raw = String(root.find('[data-field="map-json"]').val() || ''); run(() => adapter.importMap(raw), () => { if (generalDrafts['地图']?.['field:map-json'] === raw) delete generalDrafts['地图']['field:map-json']; tell('地图数据已导入。'); }); return; }
        if (action === 'save-preferences') { const patch = preferencePatch(), submitted = JSON.stringify(generalDrafts['设置']); if (!Number.isInteger(patch.autoEveryReplies) || patch.autoEveryReplies < 1 || patch.autoEveryReplies > 100) { tell('自动运转间隔须为 1–100 的整数。',true); return; } run(() => adapter.savePreferences(patch), () => { if (JSON.stringify(generalDrafts['设置']) === submitted) delete generalDrafts['设置']; tell('设置已保存。'); }); return; }
        if (action === 'save-tags') { const id = el.attr('data-id'), input = root.find('[data-tags]').filter(function () { return this.getAttribute('data-id') === id; }), value = String(input.val() || ''); run(() => adapter.setLocationTags(id,value), () => { if (generalDrafts['地图']?.[`tags:${id}`] === value) delete generalDrafts['地图'][`tags:${id}`]; tell('地点标签已保存。'); }); return; }
        if (action === 'cancel-tags') { const id = el.attr('data-id'); if (generalDrafts['地图']) delete generalDrafts['地图'][`tags:${id}`]; render(false); return; }
        if (action === 'memory-refresh') { run(() => adapter.refreshMemory(), () => tell('记忆表已刷新。')); return; }
        if (action === 'export') run(() => adapter.exportData(), () => tell('数据已导出。'));
    });
    channelDialog.on('click.nlcChannel','[data-channel-close],[data-channel-done]', () => closeDialog());
    channelDialog.on('click.nlcChannel','[data-channel-test]', testProfile);
    channelDialog.on('click.nlcChannel','[data-channel-manager]', openConnectionManager);
    // 每次输入立即保存草稿，筛选修改再刷新对应页面。
    root.on('input.nlc change.nlc','[data-field],[data-pref],[data-route],[data-template],[data-tags]', function () { if ($(this).closest('.nlc-workbench-body').length) return; captureDrafts(); if (this.getAttribute('data-field') === 'diary-chars') updateCustomChars(); });
    root.on('change.nlc','[data-field="map-tag"],[data-field="archive-npc"],[data-field="archive-day"]', () => render());
    root.on('click.nlc','[data-diary]', function () { diaryId = $(this).attr('data-diary'); render(); });
    root.on('change.nlc','[data-map-file]', function () { const file = this.files?.[0], input = this; if (file) run(() => adapter.setMapImage(validateImage(file)), () => tell('地图图片已更新。')).finally(() => { input.value = ''; }); });
    root.on('change.nlc','[data-import-file]', function () { const file = this.files?.[0], input = this; if (file) run(() => file.text().then(text => adapter.importMap(text)), () => tell('地图数据已导入。')).finally(() => { input.value = ''; }); });
    root.on('change.nlc','[data-data-file]', function () { const file = this.files?.[0], input = this; if (file) run(() => adapter.importData(file), () => tell('导入完成。')).finally(() => { input.value = ''; }); });
    root.on('keydown.nlc','[data-field="chat-text"]', function (event) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.originalEvent?.isComposing !== true) { event.preventDefault(); root.find('[data-action="chat-send"]').trigger('click'); } });
    // 为页签提供方向键和首尾键导航。
    root.on('keydown.nlc','[role="tab"]', function (event) { const i = TABS.indexOf(this.getAttribute('data-tab')); let next; if (event.key === 'ArrowRight') next = (i+1)%TABS.length; if (event.key === 'ArrowLeft') next = (i+TABS.length-1)%TABS.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = TABS.length-1; if (next !== undefined) { event.preventDefault(); root.find(`[data-tab="${TABS[next]}"]`).trigger('click'); } });
    // 拖动标题栏时保持窗口在屏幕内且不拦截按钮。
    const bar = root.find('[data-drag]')[0]; let drag = null;
    listen(bar,'pointerdown',event => { if (event.target.closest('button') || innerWidth < 620 || maximized) return; const r = root[0].getBoundingClientRect(); drag = { x:event.clientX,y:event.clientY,left:r.left,top:r.top }; bar.setPointerCapture(event.pointerId); });
    listen(bar,'pointermove',event => { if (!drag) return; root[0].style.left = `${drag.left+event.clientX-drag.x}px`; root[0].style.top = `${drag.top+event.clientY-drag.y}px`; clampConsole(root[0]); });
    listen(bar,'pointerup',() => { if (drag) persist(); drag = null; });
    listen(bar,'pointercancel',() => { if (drag) persist(); drag = null; });
    // 对话框优先处理 ESC 和焦点循环，下一次 ESC 才关闭控制台。
    listen(document,'keydown',event => {
        if (modalKind) {
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeDialog(); return; }
            if (event.key === 'Tab') { const controls = [...channelDialog[0].querySelectorAll('button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]; if (!controls.length) return; const first = controls[0], last = controls[controls.length-1]; if (event.shiftKey && (document.activeElement === first || !channelDialog[0].contains(document.activeElement))) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (document.activeElement === last || !channelDialog[0].contains(document.activeElement))) { event.preventDefault(); first.focus(); } }
            return;
        }
        if (event.key === 'Escape' && !root.prop('hidden')) { captureDrafts(); persist(); root.prop('hidden',true); priorFocus?.focus?.(); }
    },true);
    listen(document,'focusin',event => { if (modalKind && !channelDialog[0].contains(event.target)) channelDialog.find('[data-channel-close]')[0].focus(); });
    if (window.ResizeObserver) { sizeObserver = new window.ResizeObserver(() => { if (!root.prop('hidden') && !maximized && !minimized) persist(); }); sizeObserver.observe(root[0]); cleanups.push(() => sizeObserver?.disconnect()); }
    root.on('click.nlc','[data-smaller],[data-larger]',function () { if (innerWidth < 620 || maximized || minimized) return; const delta = $(this).is('[data-smaller]') ? -60 : 60; root[0].style.width = `${Math.max(360,Math.min(innerWidth-16,(root[0].offsetWidth || parseFloat(root[0].style.width))+delta))}px`; root[0].style.height = `${Math.max(300,Math.min(innerHeight-16,(root[0].offsetHeight || parseFloat(root[0].style.height))+delta*.65))}px`; clampConsole(root[0]); persist(); });
    listen(window,'resize',() => { if (!root.prop('hidden') && !maximized) { clampConsole(root[0]); persist(); } });
    // 添加宿主入口并记录全部入口清理函数。
    const topHolder = document.getElementById('top-settings-holder');
    if (topHolder) { const launcher = $('<div class="drawer"><div class="drawer-toggle drawer-header" role="button" tabindex="0" title="NPC Life"><i class="fa-solid fa-address-card" aria-label="NPC Life"></i></div></div>'); $(topHolder).append(launcher); launcher.on('click.nlc keydown.nlc',function (e) { if (e.type === 'click' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }); cleanups.push(() => launcher.remove()); }
    const bodyEntry = $('<button type="button" class="menu_button nlc-body-entry" title="打开 NPC Life">NPC Life</button>'); $('body').append(bodyEntry); bodyEntry.on('click.nlc',open); cleanups.push(() => bodyEntry.remove());
    // 先显示窗口再测量，每次打开都重新约束保存的几何信息。
    function open(nextTab) { if (destroyed) return; captureDrafts(); if (!root[0].contains(document.activeElement)) priorFocus = document.activeElement; if (typeof nextTab === 'string') { const mapped = { dynamic:'动态',overview:'动态',contacts:'联系人',map:'地图',archive:'档案',settings:'设置' }[nextTab.toLowerCase()] || nextTab; if (TABS.includes(mapped)) tab = mapped; } minimized = false; root.removeClass('is-minimized').prop('hidden',false); if (!maximized) clampConsole(root[0]); render(false); persist(); if (!modalKind) (root.find('[role="tab"][aria-selected="true"]')[0] || root[0]).focus(); }
    // 销毁实例并将原工作台节点放回原父节点与原顺序。
    function destroy() { if (destroyed) return; destroyed = true; closeDialog(false); root.off('.nlc'); channelDialog.off('.nlcChannel').remove(); cleanups.splice(0).forEach(fn => { try { fn(); } catch (_) {} }); if (oldPanel && oldPanelParent?.isConnected) oldPanelParent.insertBefore(oldPanel,oldPanelNext?.parentNode === oldPanelParent ? oldPanelNext : null); root.remove(); }
    // 隐藏初始化只设置默认尺寸，避免零尺寸测量覆盖持久化数据。
    root.css({ left:'48px',top:'48px',width:'560px',height:'640px' });
    try { const saved = JSON.parse(localStorage.getItem(CONSOLE_KEY) || 'null'); if (saved && typeof saved === 'object') { if (TABS.includes(saved.tab)) tab = saved.tab; for (const key of ['left','top','width','height']) if (Number.isFinite(saved[key]) && (key === 'left' || key === 'top' || saved[key] > 0)) root[0].style[key] = `${saved[key]}px`; } } catch (_) {}
    render(false);
    return { render, destroy, open, isOpen:() => !destroyed && !root.prop('hidden') };
}

/* NPC Life 背景状态：注入短近况约束（篇幅与接续），并在最新一条角色回复下折成可折叠块。不改写聊天正文或 extra。 */
import { activitiesForNpc } from './activity-ledger.js';

export const BACKGROUND_TAG = 'npc_life_background';

const ACTION_WORDS = ['调查', '搜寻', '搜索', '探查', '巡视', '阅读', '读书', '工作', '休息', '睡觉', '学习', '训练', '做饭', '交谈', '闲聊', '散步', '打斗', '战斗', '等待', '等候', '祈禱', '祈祷', '看守', '守候', '保养', '擦拭'];
const SLOT_RE = /^(准备[\u4e00-\u9fff]{1,8}|[\u4e00-\u9fff]{1,10}(?:中|过)?)$/;
const CARD_BACKGROUND_RE = /【[^】]{2,}】[\s\S]{0,40}\[\d+\s*[—\-－]\s*\d+\]/;
const TAG_RE = new RegExp(`<${BACKGROUND_TAG}\\b[^>]*>([\\s\\S]*?)<\\/${BACKGROUND_TAG}>`, 'i');
const OPEN_RE = new RegExp(`<${BACKGROUND_TAG}\\b[^>]*>`, 'i');
const ESC_TAG_RE = new RegExp(`&lt;${BACKGROUND_TAG}\\b[^&]*&gt;([\\s\\S]*?)&lt;\\/${BACKGROUND_TAG}&gt;`, 'i');
const ESC_OPEN_RE = new RegExp(`&lt;${BACKGROUND_TAG}\\b[^&]*&gt;`, 'i');

function text(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
    return String(value || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function coreAction(summary) {
    return text(summary)
        .replace(/^[^，。]+完成了事先计划的/, '')
        .replace(/准备前往[^，。]*/g, '前往')
        .replace(/系统并未计算到达时间/g, '')
        .replace(/在[^，。；;]{1,20}(?:，|,|。|$)/g, '')
        .trim();
}

export function behaviorSlotFromActivity(activity) {
    if (!activity) return '';
    const summary = text(activity.summary);
    const core = coreAction(summary);
    const phase = activity.phase;
    const travelling = /前往|赶路|出发/.test(summary) || /准备前往/.test(String(activity.summary || ''));
    const waiting = /等待|等候|停留|歇着/.test(core) || /wait/i.test(String(activity.kind || ''));
    const pick = () => {
        if (travelling) return '前往';
        if (waiting) return '等待';
        for (const word of ACTION_WORDS) {
            if (core.includes(word) || summary.includes(word)) {
                if (word === '搜索' || word === '探查') return '搜寻';
                if (word === '读书') return '阅读';
                if (word === '等候') return '等待';
                if (word === '战斗') return '打斗';
                if (word === '祈禱') return '祈祷';
                if (word === '闲聊') return '交谈';
                return word;
            }
        }
        return '';
    };
    const action = pick();
    if (!action) {
        if (phase === 'planned') return '准备中';
        if (phase === 'doing') return '活动中';
        return '';
    }
    if (action === '前往') return phase === 'planned' ? '准备前往' : '途中';
    if (phase === 'planned') return `准备${action}`;
    if (phase === 'doing') return `${action}中`;
    if (phase === 'done') return `刚${action}过`;
    return `${action}中`;
}

export function collectBackgroundSlots(ledger, npcs = []) {
    const slots = [];
    for (const npc of npcs || []) {
        if (!npc?.name) continue;
        const items = activitiesForNpc(ledger, npc.id) || [];
        const doing = items.filter(item => item.phase === 'doing').at(-1);
        const planned = items.filter(item => item.phase === 'planned').at(-1);
        const slot = behaviorSlotFromActivity(doing) || behaviorSlotFromActivity(planned) || '状态不明';
        slots.push({
            id: npc.id,
            name: npc.name,
            aliases: Array.isArray(npc.aliases) ? npc.aliases.filter(Boolean) : [],
            slot,
            known: slot !== '状态不明',
        });
    }
    return slots;
}

export function isBackgroundStatusOn(npc) {
    return !!(npc && npc.tracked === true && npc.backgroundStatus !== false);
}

export function countCharacterReplies(messages = []) {
    return (Array.isArray(messages) ? messages : []).filter(item => item && item.is_user !== true && String(item.mes || item.content || '').trim()).length;
}

export function shouldWriteBackgroundPlot(messages = [], interval = 3) {
    const every = Number.isFinite(Number(interval)) ? Math.max(1, Math.min(100, Math.round(Number(interval)))) : 3;
    return countCharacterReplies(messages) % every === 0;
}

export function formatBackgroundInjection(slots = [], previous = []) {
    if (!slots.length) return '';
    const lines = [
        '【背景状态输出】只给下面这些已勾选人物。只要这份名单非空，就必须在回复最末尾单独输出这个标签，不能省略，也不要写进正文剧情，不要使用角色卡或其他插件的 <background> 标签。不要在 think_nya、思维链或自查文字里写出、预演或再次提到这个标签，只在最末尾输出一次完整的开闭标签。',
        '这段是给插件折叠块用的背景近况：每人先写一行“姓名｜行为状态词”，下一行再写一两句到三句情节式短描述，合成短小的一段，篇幅接近角色卡正文底下那种简短背景，不要写成大段。写出这个人此刻的处境或正在做的事，但不要写成【地点】标题，也不要写坐标。不要写结果，不要编造未发生的事件。名单里的每个人都必须写到，不能因为行为槽是“状态不明”就跳过：',
        `<${BACKGROUND_TAG}>`,
        '林青｜调查中',
        '正低头翻着一叠记录，偶尔停下来核对其中一页。听到门外的脚步时，他并没有立刻抬头。',
        `</${BACKGROUND_TAG}>`,
        '若下面给出了明确的行为槽，行为状态词必须用它。若是“状态不明”，就根据当前正文已发生的事选一个短的状态词（例如“等待中”“休息中”），并据此写近况；不要因此省略这个人，更不要省略整个标签。',
        '请把上次背景近况当作已发生的前情来续写，不要每轮从头另起一段无关描写。新的近况要能接上此前的行动、道别、归来或已发生的事。如果还没有上次近况，就根据当前行为槽或正文已发生的事来写，不要虚构更早的情节。',
    ];
    for (const item of slots) {
        lines.push(`- ${item.name}｜${item.slot}`);
    }
    if (previous.length) {
        lines.push('上次背景近况：');
        for (const item of previous) {
            if (!item) continue;
            const name = String(item.name || '').trim();
            const slot = String(item.slot || '').trim();
            const body = String(item.text || '').trim();
            if (name && slot) lines.push(`${name}｜${slot}`);
            else if (slot) lines.push(slot);
            if (body) lines.push(body);
        }
    }
    return lines.join('\n');
}

export function extractBackgroundTag(value) {
    const raw = String(value || '');
    if (!raw) return { found: false };
    const decoded = decodeEntities(raw);
    const closeRe = new RegExp(`</${BACKGROUND_TAG}>`, 'gi');
    const openRe = new RegExp(OPEN_RE.source, 'gi');
    let best = null;
    for (const close of decoded.matchAll(closeRe)) {
        const before = decoded.slice(0, close.index);
        let lastOpen = null;
        for (const open of before.matchAll(openRe)) lastOpen = open;
        if (!lastOpen) continue;
        const innerStart = lastOpen.index + lastOpen[0].length;
        best = {
            found: true,
            complete: true,
            inner: decoded.slice(innerStart, close.index),
            match: decoded.slice(lastOpen.index, close.index + close[0].length),
        };
    }
    if (best) return best;
    const open = decoded.search(OPEN_RE);
    if (open !== -1 && open >= decoded.length - 2500) {
        return {
            found: true,
            complete: false,
            inner: decoded.slice(open).replace(OPEN_RE, ''),
            match: decoded.slice(open),
        };
    }
    return { found: false };
}

function isHeader(line) {
    const value = String(line || '').trim();
    if (!value || value.length > 40 || /[。！？!?]/.test(value) || /【/.test(value)) return false;
    if (/[｜|]/.test(value)) {
        const [name, slot] = value.split(/[｜|]/, 2).map(item => item.trim());
        return !!(name && slot && slot.length <= 16 && SLOT_RE.test(slot));
    }
    return SLOT_RE.test(value);
}

function namesMatch(allowed, name) {
    const target = text(name);
    if (!target) return false;
    return (allowed || []).some(item => text(item) === target);
}

export function parseBackgroundEntries(inner, allowedNames = null) {
    const source = String(inner || '').replace(/^\uFEFF/, '').trim();
    if (!source || CARD_BACKGROUND_RE.test(source) || /<background\b/i.test(source)) return null;
    const lines = source.split(/\r?\n/);
    const entries = [];
    let current = null;
    for (const line of lines) {
        if (isHeader(line)) {
            if (current) entries.push(current);
            if (/[｜|]/.test(line)) {
                const [name, slot] = line.trim().split(/[｜|]/, 2).map(item => item.trim());
                current = { name, slot, body: [] };
            } else {
                current = { name: '', slot: line.trim(), body: [] };
            }
        } else if (current) {
            current.body.push(line);
        } else if (line.trim()) {
            return null;
        }
    }
    if (current) entries.push(current);
    const cleaned = entries
        .map(item => ({
            name: text(item.name),
            slot: text(item.slot),
            text: item.body.join('\n').trim(),
        }))
        .filter(item => item.slot && item.text && item.text.length <= 500 && !CARD_BACKGROUND_RE.test(item.text) && !/^\s*</.test(item.text));
    if (!cleaned.length) return null;
    if (Array.isArray(allowedNames) && allowedNames.length) {
        const selected = cleaned.filter(item => !item.name || namesMatch(allowedNames, item.name));
        if (cleaned.some(item => item.name) && !selected.length) return null;
        return selected.length ? selected : null;
    }
    return cleaned;
}

export function collectPreviousBackgrounds(messages = [], npcs = []) {
    const allowed = [];
    const canon = [];
    for (const npc of npcs || []) {
        if (!npc?.name) continue;
        const aliases = Array.isArray(npc.aliases) ? npc.aliases.filter(Boolean) : [];
        allowed.push(npc.name, ...aliases);
        canon.push({ name: npc.name, aliases });
    }
    const latest = new Map();
    const list = Array.isArray(messages) ? messages : [];
    const start = Math.max(0, list.length - 40);
    for (let i = list.length - 1; i >= start; i--) {
        const message = list[i];
        if (message?.is_user) continue;
        const raw = String(message?.mes ?? message?.content ?? message?.message ?? '');
        const extracted = extractBackgroundTag(raw);
        if (!extracted.found || !extracted.complete) continue;
        const entries = parseBackgroundEntries(extracted.inner, allowed.length ? allowed : null);
        if (!entries) continue;
        for (const entry of entries) {
            const name = text(entry.name);
            const match = canon.find(item => text(item.name) === name || item.aliases.some(alias => text(alias) === name));
            const key = match?.name || name || `slot:${entry.slot}`;
            if (!latest.has(key)) {
                latest.set(key, { name: match?.name || name, slot: entry.slot, text: entry.text });
            }
        }
    }
    return [...latest.values()];
}

export function withReservedBackground(body, backgroundText, cap) {
    const limit = Number.isFinite(cap) ? cap : 4500;
    const extra = String(backgroundText || '');
    const main = String(body || '');
    if (!extra) return main.length <= limit ? main : main.slice(0, limit);
    const reserved = extra.length + (main ? 2 : 0);
    const bodyCap = Math.max(0, limit - reserved);
    const trimmed = main.length <= bodyCap ? main : main.slice(0, bodyCap);
    return trimmed ? `${trimmed}\n\n${extra}` : extra;
}

function stripTagFromHtml(html) {
    return String(html || '')
        .replace(new RegExp(`<${BACKGROUND_TAG}\\b[^>]*>[\\s\\S]*?<\\/${BACKGROUND_TAG}>`, 'ig'), '')
        .replace(new RegExp(`&lt;${BACKGROUND_TAG}\\b[^&]*&gt;[\\s\\S]*?&lt;\\/${BACKGROUND_TAG}&gt;`, 'ig'), '')
        .replace(new RegExp(`<${BACKGROUND_TAG}\\b[^>]*>[\\s\\S]*$`, 'ig'), '')
        .replace(new RegExp(`&lt;${BACKGROUND_TAG}\\b[^&]*&gt;[\\s\\S]*$`, 'ig'), '');
}

function buildDetails(entries) {
    const details = document.createElement('details');
    details.className = 'npc-life-background-block';
    const summary = document.createElement('summary');
    summary.textContent = '背景状态';
    details.appendChild(summary);
    for (const entry of entries) {
        const block = document.createElement('div');
        block.className = 'npc-life-bg-entry';
        const slot = document.createElement('div');
        slot.className = 'npc-life-bg-slot';
        slot.textContent = entry.name ? `${entry.name}｜${entry.slot}` : entry.slot;
        const body = document.createElement('div');
        body.className = 'npc-life-bg-text';
        body.textContent = entry.text;
        block.append(slot, body);
        details.appendChild(block);
    }
    return details;
}

function enhanceElement(mesEl, allowedNames, fallbackEntries) {
    if (!mesEl || mesEl.classList.contains('is_user') || !mesEl.querySelector) return;
    mesEl.querySelectorAll('.npc-life-background-block').forEach(node => node.remove());
    const textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return;
    const custom = textEl.querySelectorAll(BACKGROUND_TAG);
    let source = `${textEl.innerHTML || ''}\n${textEl.textContent || ''}`;
    if (custom.length) {
        source += `\n${[...custom].map(node => node.outerHTML || node.textContent || '').join('\n')}`;
    }
    const extracted = extractBackgroundTag(source);
    if (extracted.found) {
        if (custom.length) custom.forEach(node => node.remove());
        textEl.innerHTML = stripTagFromHtml(textEl.innerHTML || '');
    }
    let entries = extracted.found && extracted.complete
        ? parseBackgroundEntries(extracted.inner, allowedNames)
        : null;
    if (!entries && Array.isArray(fallbackEntries) && fallbackEntries.length) entries = fallbackEntries;
    if (!entries) return;
    const hostEl = textEl.parentElement || mesEl;
    hostEl.appendChild(buildDetails(entries));
}

export function createBackgroundRenderer(host) {
    const listeners = [];
    let destroyed = false;
    const context = () => host.context?.() || {};
    const allowed = () => host.getAllowedNames?.() || null;

    function stripOnly(mesEl) {
        if (!mesEl || !mesEl.querySelector) return;
        mesEl.querySelectorAll('.npc-life-background-block').forEach(node => node.remove());
        const textEl = mesEl.querySelector('.mes_text');
        if (!textEl) return;
        const custom = textEl.querySelectorAll(BACKGROUND_TAG);
        let source = `${textEl.innerHTML || ''}\n${textEl.textContent || ''}`;
        if (custom.length) {
            source += `\n${[...custom].map(node => node.outerHTML || node.textContent || '').join('\n')}`;
        }
        const extracted = extractBackgroundTag(source);
        if (!extracted.found && !custom.length) return;
        if (custom.length) custom.forEach(node => node.remove());
        textEl.innerHTML = stripTagFromHtml(textEl.innerHTML || '');
    }

    function refreshAll() {
        if (destroyed || typeof document === 'undefined') return;
        try {
            const nodes = [...document.querySelectorAll('#chat .mes:not(.is_user)')];
            if (!nodes.length) return;
            const last = nodes[nodes.length - 1];
            const fallback = host.getFallbackEntries?.() || null;
            for (const node of nodes) {
                if (node === last) enhanceElement(node, allowed(), fallback);
                else stripOnly(node);
            }
        } catch { /* 渲染失败时静默跳过，避免打断正文。 */ }
    }

    function refreshOne() {
        refreshAll();
    }

    function listen(bus, types, name, handler) {
        const event = types?.[name];
        if (!event || typeof bus.on !== 'function') return;
        bus.on(event, handler);
        listeners.push([bus, event, handler]);
    }

    function bind() {
        destroy();
        destroyed = false;
        const ctx = context();
        const bus = ctx.eventSource;
        const types = ctx.eventTypes || ctx.event_types;
        if (bus && types) {
            listen(bus, types, 'CHARACTER_MESSAGE_RENDERED', refreshOne);
            listen(bus, types, 'MESSAGE_UPDATED', refreshOne);
            listen(bus, types, 'MESSAGE_EDITED', refreshOne);
            listen(bus, types, 'MESSAGE_SWIPED', refreshOne);
            listen(bus, types, 'CHAT_CHANGED', refreshAll);
        }
        refreshAll();
    }

    function destroy() {
        destroyed = true;
        for (const [bus, event, handler] of listeners) {
            if (typeof bus.removeListener === 'function') bus.removeListener(event, handler);
            else bus.off?.(event, handler);
        }
        listeners.length = 0;
        if (typeof document !== 'undefined') {
            document.querySelectorAll('.npc-life-background-block').forEach(node => node.remove());
        }
    }

    return { bind, destroy, refresh: refreshAll };
}

export const __test = { decodeEntities, escapeHtml, isHeader, stripTagFromHtml, CARD_BACKGROUND_RE };

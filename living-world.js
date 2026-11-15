/* 动态世界书、意图重合与偶遇：纯资料变换，不访问宿主或网络，不当正史。 */
import { canArrangeActivity, hasAppearedInPlay, hasSufficientProfile } from './activity-ledger.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const unique = list => [...new Set((list || []).filter(value => typeof value === 'string' && value))];

export const DEFAULT_LIVING_WORLD = {
    worldBookMaxEntries: 24,
    worldBookMaxTurns: 8,
    worldBookBudget: 1600,
    encounterProbability: 0.08,
    encounterMaxPerTurn: 1,
    encounterSameWeight: 1.6,
    encounterUncertainWeight: 1,
    encounterMismatchWeight: 0.35,
    intentOverlapBudget: 700,
    injectionBudget: 4500,
};

const STOP_WORDS = new Set([
    '的', '了', '在', '我', '你', '他', '她', '它', '是', '有', '和', '与', '也', '就', '都',
    '要', '会', '到', '去', '把', '被', '让', '对', '为', '及', '或', '但', '而', '且',
    '这', '那', '个', '些', '们', '吗', '呢', '吧', '啊', '哦', '嗯', '着', '过', '等',
    '以及', '然后', '因为', '所以', '如果', '虽然', '可以', '不是', '没有', '什么',
    '怎么', '这个', '那个', '自己', '我们', '他们', '一个', '一下', '一起', '还有',
    '进行', '开始', '继续', '准备', '打算', '想要', '希望', '路上', '时候', '现在',
    '然后', '已经', '正在', '将要', '以及', '以及',
]);
const PLACE_CHARS = new Set([...'桥门路城塔河港关坝堤墙巷街村镇岛山湖谷林营寺殿宫府寨堡渡口']);
const PUBLIC_WORLD_CHANGE = /桥断|断桥|石桥.{0,8}断|木桥.{0,8}断|桥梁.{0,6}(?:断|塌|毁)|封路|封城|封桥|道路被?(?:毁|断|堵|封)|路被?(?:毁|断|堵|封)|塌陷|倒塌|坍塌|城门.{0,8}(?:关闭|封锁|锁上|被封|紧闭)|关城|决堤|堤坝.{0,6}(?:决|溃)|烧毁|起火|大火|沉船|崩塌|阻断|阻断了|断了/;

function integer(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}

function probability(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

// 地点加权允许大于 1；空值回退到出厂默认，结果夹在 0–8。
function weight(value, fallback, min = 0, max = 8) {
    if (value === '' || value == null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

export function normalizeLivingWorldPreferences(value = {}) {
    return {
        worldBookMaxEntries: integer(value.worldBookMaxEntries, DEFAULT_LIVING_WORLD.worldBookMaxEntries, 4, 80),
        worldBookMaxTurns: integer(value.worldBookMaxTurns, DEFAULT_LIVING_WORLD.worldBookMaxTurns, 1, 40),
        worldBookBudget: integer(value.worldBookBudget, DEFAULT_LIVING_WORLD.worldBookBudget, 400, 6000),
        encounterProbability: probability(value.encounterProbability, DEFAULT_LIVING_WORLD.encounterProbability),
        encounterMaxPerTurn: integer(value.encounterMaxPerTurn, DEFAULT_LIVING_WORLD.encounterMaxPerTurn, 0, 5),
        encounterSameWeight: weight(value.encounterSameWeight, DEFAULT_LIVING_WORLD.encounterSameWeight),
        encounterUncertainWeight: weight(value.encounterUncertainWeight, DEFAULT_LIVING_WORLD.encounterUncertainWeight),
        encounterMismatchWeight: weight(value.encounterMismatchWeight, DEFAULT_LIVING_WORLD.encounterMismatchWeight),
        intentOverlapBudget: integer(value.intentOverlapBudget, DEFAULT_LIVING_WORLD.intentOverlapBudget, 200, 2000),
        injectionBudget: integer(value.injectionBudget, DEFAULT_LIVING_WORLD.injectionBudget, 1500, 12000),
    };
}

function hashNumber(value) {
    let hash = 2166136261;
    for (const char of String(value ?? '')) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function unitRandom(seed) {
    return hashNumber(seed) / 0x100000000;
}

export function tokenize(value) {
    const raw = text(value);
    if (!raw) return [];
    const tokens = new Set();
    for (const match of raw.matchAll(/[A-Za-z0-9_]{2,}/g)) tokens.add(match[0].toLowerCase());
    for (const run of raw.match(/[\u3400-\u9fff]{1,}/g) || []) {
        if (run.length === 1) {
            if (PLACE_CHARS.has(run)) tokens.add(run);
            continue;
        }
        tokens.add(run);
        for (let i = 0; i < run.length - 1; i++) {
            const bigram = run.slice(i, i + 2);
            if (![...bigram].every(char => STOP_WORDS.has(char))) tokens.add(bigram);
        }
        for (const char of run) if (PLACE_CHARS.has(char)) tokens.add(char);
    }
    return [...tokens].filter(token => token && !STOP_WORDS.has(token));
}

export function isPublicWorldState(summary, event = {}) {
    if (event.publicWorld === true) return true;
    const value = text(summary || event.summary || event.content);
    if (!value) return false;
    if (PUBLIC_WORLD_CHANGE.test(value)) return true;
    if (event.public === true && PUBLIC_WORLD_CHANGE.test(value)) return true;
    return false;
}

function namedLocation(id) {
    return typeof id === 'string' && id.trim() && id !== 'unknown';
}

function isConfined(state = {}) {
    return state.mobility === 'immobile'
        || state.activityLock?.active === true
        || ['confined', 'imprisoned', 'secluded'].includes(state.confinement?.value)
        || /闭关|囚禁|关押|监禁|禁足/.test(String(state.confinement?.evidence || state.confinement?.reason || state.activityLock?.reason || ''));
}

function explicitlyAbsent(state = {}) {
    if (state.scene === 'absent' || state.presence === 'absent') return true;
    if (state.explicitlyAbsent === true) return true;
    return /明确不在场|此时不在|并不在场|禁止出现|不得出现/.test(String(state.absenceReason || state.confinement?.reason || state.activityLock?.reason || ''));
}

function placeOf(id, context = {}) {
    if (typeof context.locationName === 'function') {
        const name = context.locationName(id);
        if (text(name) && name !== '未知地点' && name !== '地点不详') return text(name);
    }
    const hit = (context.locations || []).find(item => item.id === id);
    if (hit?.name) return hit.name;
    return namedLocation(id) ? id : '';
}

function currentActivity(items, phase) {
    return items.filter(item => item.phase === phase).at(-1) || null;
}

function committedActivities(ledger) {
    return (ledger?.activities || []).filter(item => item && item.status !== 'revoked' && item.committed === true);
}

function committedTimelineEvents(timeline) {
    if (!timeline || !Array.isArray(timeline.events)) return [];
    const pendingId = timeline.pending?.id || timeline.pending?.turnId || '';
    return timeline.events.filter(event => {
        if (!event) return false;
        if (event.committed === false) return false;
        if (pendingId && (event.turnId === pendingId || event.id === pendingId)) return false;
        return true;
    });
}

// 动态世界书条目：做过 / 正在做 / 准备做。正史以已提交状态为准，此处只做辅助上下文。
export function collectWorldBookEntries(input = {}) {
    const ledger = input.ledger || { activities: [] };
    const npcs = input.npcs || [];
    const states = input.states || {};
    const currentTurn = Number.isSafeInteger(input.currentTurn) ? input.currentTurn : (ledger.turnCursor || 0);
    const entries = [];
    const activities = committedActivities(ledger);
    for (const npc of npcs) {
        if (!npc?.id) continue;
        const items = activities.filter(item => (item.npcIds || []).includes(npc.id));
        const state = states[npc.id] || {};
        const confirmedPlace = placeOf(state.locationId, input);
        const doing = currentActivity(items, 'doing');
        const planned = currentActivity(items, 'planned');
        const doneList = items.filter(item => item.phase === 'done');
        if (doing) {
            entries.push({
                id: `wb:${npc.id}:doing:${doing.id}`,
                npcId: npc.id, npcName: npc.name, phase: 'doing',
                summary: doing.summary, locationId: state.locationId || doing.locationId,
                locationName: confirmedPlace || placeOf(doing.locationId, input),
                publicCanon: doing.publicCanon === true, sticky: true,
                createdAtTurn: doing.createdAtTurn ?? currentTurn, turnId: doing.turnId || '',
                sourceId: doing.id,
            });
        }
        if (planned) {
            entries.push({
                id: `wb:${npc.id}:planned:${planned.id}`,
                npcId: npc.id, npcName: npc.name, phase: 'planned',
                summary: planned.summary, locationId: state.locationId || planned.locationId,
                locationName: confirmedPlace || placeOf(planned.locationId, input),
                publicCanon: planned.publicCanon === true, sticky: true,
                createdAtTurn: planned.createdAtTurn ?? currentTurn, turnId: planned.turnId || '',
                sourceId: planned.id,
            });
        }
        for (const done of doneList) {
            entries.push({
                id: `wb:${npc.id}:done:${done.id}`,
                npcId: npc.id, npcName: npc.name, phase: 'done',
                summary: done.summary, locationId: done.locationId,
                locationName: placeOf(done.locationId, input),
                publicCanon: done.publicCanon === true, sticky: false,
                createdAtTurn: done.createdAtTurn ?? 0, turnId: done.turnId || '',
                sourceId: done.id,
            });
        }
    }
    return entries;
}

// 滑动窗口：按轮数与条数双上限淘汰最旧条目。正在做 / 准备做作为当前快照保留。不做重要度筛选。
export function applySlidingWindow(entries = [], options = {}) {
    const maxEntries = integer(options.maxEntries, DEFAULT_LIVING_WORLD.worldBookMaxEntries, 1, 200);
    const maxTurns = integer(options.maxTurns, DEFAULT_LIVING_WORLD.worldBookMaxTurns, 1, 80);
    const currentTurn = Number.isSafeInteger(options.currentTurn) ? options.currentTurn : 0;
    const sticky = [];
    const history = [];
    for (const entry of entries) {
        if (!entry) continue;
        if (entry.sticky || entry.phase === 'doing' || entry.phase === 'planned') sticky.push(entry);
        else history.push(entry);
    }
    // 窗口含当前轮：保留 createdAtTurn > currentTurn - maxTurns。超出条数时从最旧的历史条目开始丢。
    const inWindow = history.filter(item => (item.createdAtTurn ?? 0) > currentTurn - maxTurns);
    inWindow.sort((a, b) => (a.createdAtTurn ?? 0) - (b.createdAtTurn ?? 0) || String(a.id).localeCompare(String(b.id)));
    const leftover = Math.max(0, maxEntries - sticky.length);
    const keptHistory = leftover > 0 ? inWindow.slice(-leftover) : [];
    return [...keptHistory, ...sticky];
}

export function formatWorldBook(entries = [], budget = DEFAULT_LIVING_WORLD.worldBookBudget) {
    const limit = integer(budget, DEFAULT_LIVING_WORLD.worldBookBudget, 0, 20000);
    if (!entries.length || limit <= 0) return '';
    const header = '【动态世界书｜辅助上下文，不是正史】仅供主模型保持角色动态与世界后台状态一致，不得覆盖当前正文和已确认状态。幕后活动是世界后台状态或角色动态，不是玩家已知情报。未发现的痕迹不可写成玩家已经掌握。';
    const lines = [header];
    let used = header.length;
    const push = line => {
        if (used + line.length + 1 > limit) return false;
        lines.push(line);
        used += line.length + 1;
        return true;
    };
    const current = entries.filter(item => item.phase === 'doing' || item.phase === 'planned');
    const history = entries.filter(item => item.phase === 'done');
    if (current.length) {
        if (!push('角色动态：')) return lines.join('\n');
        for (const item of current) {
            const place = item.locationName ? `（${item.locationName}）` : '';
            const verb = item.phase === 'doing' ? '正在做' : '准备做';
            const tag = item.publicCanon ? '公开结果' : '世界后台状态';
            if (!push(`- ${item.npcName || item.npcId}${place}｜${verb}：${item.summary}｜${tag}`)) return lines.join('\n');
        }
    }
    if (history.length) {
        if (!push('近期做过：')) return lines.join('\n');
        for (const item of history) {
            const place = item.locationName ? `（${item.locationName}）` : '';
            const tag = item.publicCanon ? '已提交的公开结果' : '世界后台状态，不是玩家已知情报';
            if (!push(`- ${item.npcName || item.npcId}${place}｜做过：${item.summary}｜${tag}`)) return lines.join('\n');
        }
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

export function collectSubmittedWorldResults(input = {}) {
    const results = [];
    const ledger = input.ledger || {};
    const context = input;
    for (const activity of committedActivities(ledger)) {
        if (activity.phase !== 'done' && activity.phase !== 'doing') continue;
        if (!isPublicWorldState(activity.summary, activity)) continue;
        results.push({
            id: activity.id, summary: activity.summary, locationId: activity.locationId,
            locationName: placeOf(activity.locationId, context),
            npcIds: [...(activity.npcIds || [])],
            turnId: activity.turnId || '', createdAtTurn: activity.createdAtTurn ?? 0,
            publicWorld: true, source: 'activity',
        });
    }
    for (const event of committedTimelineEvents(input.timeline)) {
        if (!isPublicWorldState(event.summary, event)) continue;
        if (results.some(item => item.summary === event.summary && item.turnId === (event.turnId || ''))) continue;
        results.push({
            id: event.id || `event:${event.turnId}:${results.length}`,
            summary: event.summary, locationId: event.locationId,
            locationName: placeOf(event.locationId, context),
            npcIds: [...(event.npcIds || [])],
            turnId: event.turnId || '', createdAtTurn: event.createdAtTurn ?? 0,
            publicWorld: true, source: 'timeline',
        });
    }
    for (const extra of input.submittedResults || []) {
        if (!extra || extra.committed === false) continue;
        if (!isPublicWorldState(extra.summary, extra)) continue;
        results.push({
            id: extra.id || `extra:${results.length}`, summary: extra.summary,
            locationId: extra.locationId, locationName: extra.locationName || placeOf(extra.locationId, context),
            npcIds: [...(extra.npcIds || [])], turnId: extra.turnId || '',
            createdAtTurn: extra.createdAtTurn ?? 0, publicWorld: true, source: extra.source || 'extra',
        });
    }
    return results;
}

function overlapScore(intentTokens, result, intentText) {
    const intent = text(intentText);
    const summary = text(result.summary);
    if (!intent || !summary) return 0;
    let score = 0;
    const resultTokens = unique([
        ...tokenize(summary),
        ...tokenize(result.locationName || ''),
        ...(namedLocation(result.locationId) ? [result.locationId] : []),
    ]);
    const intentSet = new Set(intentTokens);
    for (const token of resultTokens) {
        if (!intentSet.has(token) && !intent.includes(token)) continue;
        score += token.length >= 2 ? 2 : 3;
        if (PLACE_CHARS.has(token) || (result.locationName && (token === result.locationName || result.locationName.includes(token)))) score += 2;
    }
    if (result.locationName && intent.includes(result.locationName)) score += 4;
    return score;
}

// 只匹配已提交、且与本轮意图相关的公开世界状态。私密未发现痕迹不进入。
export function matchIntentOverlap(playerIntent, results = [], options = {}) {
    const intent = text(playerIntent);
    if (!intent || !results.length) return [];
    const tokens = tokenize(intent);
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 3;
    const hits = [];
    for (const result of results) {
        if (!result || result.committed === false) continue;
        if (!isPublicWorldState(result.summary, result) && result.publicWorld !== true) continue;
        const score = overlapScore(tokens, result, intent);
        if (score >= threshold) hits.push({ ...result, score });
    }
    hits.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    return hits;
}

export function formatIntentOverlap(matches = [], budget = DEFAULT_LIVING_WORLD.intentOverlapBudget) {
    const limit = integer(budget, DEFAULT_LIVING_WORLD.intentOverlapBudget, 0, 8000);
    if (!matches.length || limit <= 0) return '';
    const header = '【与本轮意图重合的世界状态】以下是上一轮及更早已提交的公开世界变化，与玩家本轮行动意图相关。请在正文中让玩家自然感受到，不要写成系统判定旁白，也不要把未发现的私密痕迹写成已经掌握。';
    const lines = [header];
    let used = header.length;
    for (const item of matches.slice(0, 5)) {
        const place = item.locationName ? `（${item.locationName}）` : '';
        const line = `- 公开世界状态${place}：${item.summary}`;
        if (used + line.length + 1 > limit) break;
        lines.push(line);
        used += line.length + 1;
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

export function locationCompatibility(playerLocationId, npcLocationId) {
    if (!namedLocation(playerLocationId) || !namedLocation(npcLocationId)) return 'uncertain';
    if (playerLocationId === npcLocationId) return 'same';
    return 'mismatch';
}

function mentionedIn(textValue, npc) {
    const blob = text(textValue);
    if (!blob || !npc) return false;
    return [npc.name, ...(npc.aliases || [])].filter(name => name && name.length >= 2).some(name => blob.includes(name));
}

function currentDoingSummary(npc, ledger, state) {
    const items = committedActivities(ledger).filter(item => (item.npcIds || []).includes(npc.id));
    const doing = currentActivity(items, 'doing');
    if (doing?.summary) return doing.summary;
    const planned = currentActivity(items, 'planned');
    if (planned?.summary) return planned.summary;
    return text(state?.activity) ? `${npc.name}正在${state.activity}` : '';
}

export function isActingNpc(npc, state, ledger) {
    if (!npc || !state) return false;
    if (text(state.activity) && !/^(?:未知|空闲|无所事事|等待)$/.test(text(state.activity))) return true;
    const items = committedActivities(ledger).filter(item => (item.npcIds || []).includes(npc.id));
    return items.some(item => item.phase === 'doing' || item.phase === 'planned');
}

// 硬排除只保留：闭关/囚禁、明确不在场、未追踪或归档、未登场且资料不足、本轮已提到、当前没有正在进行的行动。地点只做软加权，不同地点不再一票否决。
export function encounterEligibility(npc, state = {}, context = {}) {
    const reasons = [];
    if (!npc) return { ok: false, reasons: ['无角色'], fit: 'uncertain' };
    if (npc.archived || npc.ignored || npc.mergedInto || npc.tracked !== true) reasons.push('未追踪或不在名册');
    if (isConfined(state)) reasons.push('闭关或囚禁');
    if (explicitlyAbsent(state)) reasons.push('明确不在场');
    const extras = { lore: context.lore || npc.description || '', scene: state.scene };
    if (!canArrangeActivity(npc, extras)) reasons.push('未登场且资料不足，或不允许安排活动');
    if (!hasAppearedInPlay(npc, extras) && !npc.userDesignated && !hasSufficientProfile(npc, extras.lore)) {
        reasons.push('未登场且资料不足');
    }
    if (!isActingNpc(npc, state, context.ledger || { activities: [] })) reasons.push('当前没有正在进行的行动');
    const fit = locationCompatibility(context.playerLocationId, state.locationId);
    if (mentionedIn(context.mentionedText, npc)) reasons.push('本轮输入或近期正文已提到');
    return { ok: reasons.length === 0, reasons, fit };
}

// 按地点拟合度取偶遇权重：同地提高、异地降低、未知用默认，均不排除。
export function encounterLocationWeight(fit, prefs = {}) {
    const normalized = normalizeLivingWorldPreferences(prefs);
    if (fit === 'same') return normalized.encounterSameWeight;
    if (fit === 'mismatch') return normalized.encounterMismatchWeight;
    return normalized.encounterUncertainWeight;
}

// 基础概率乘以地点权重后夹在 0–1。
export function effectiveEncounterProbability(base, fit, prefs = {}) {
    const probability = Number.isFinite(Number(base)) ? Math.max(0, Math.min(1, Number(base))) : DEFAULT_LIVING_WORLD.encounterProbability;
    return Math.max(0, Math.min(1, probability * encounterLocationWeight(fit, prefs)));
}

export function selectEncounters(candidates = [], options = {}) {
    const probability = Number.isFinite(options.probability) ? Math.max(0, Math.min(1, options.probability)) : DEFAULT_LIVING_WORLD.encounterProbability;
    const maxPerTurn = integer(options.maxPerTurn, DEFAULT_LIVING_WORLD.encounterMaxPerTurn, 0, 8);
    if (!candidates.length || maxPerTurn <= 0 || probability <= 0) return [];
    const seed = options.seed || '';
    const currentTurn = options.currentTurn ?? 0;
    const weights = {
        ...(options.preferences || {}),
        encounterSameWeight: options.encounterSameWeight ?? options.preferences?.encounterSameWeight,
        encounterUncertainWeight: options.encounterUncertainWeight ?? options.preferences?.encounterUncertainWeight,
        encounterMismatchWeight: options.encounterMismatchWeight ?? options.preferences?.encounterMismatchWeight,
    };
    const rolled = [];
    for (const item of candidates) {
        const key = `${seed}|${currentTurn}|${item.npcId || item.npc?.id || ''}`;
        const roll = typeof options.random === 'function' ? options.random(key) : unitRandom(key);
        const chance = effectiveEncounterProbability(probability, item.fit, weights);
        const locationWeight = encounterLocationWeight(item.fit, weights);
        if (roll < chance) rolled.push({ ...item, roll, chance, weight: locationWeight });
    }
    rolled.sort((a, b) => a.roll - b.roll || String(a.npcId).localeCompare(String(b.npcId)));
    return rolled.slice(0, maxPerTurn);
}

function encounterFitNote(fit) {
    if (fit === 'same') return '可能在此处出现';
    // 异地或地点不确定：只给可能路过的机会，禁止声称算过路线或已经到达。
    return '可能路过，系统并未计算路线，也未声称已经到达';
}

export function formatEncounters(encounters = [], budget = 500) {
    const limit = integer(budget, 500, 0, 4000);
    if (!encounters.length || limit <= 0) return '';
    const header = '【偶遇机会】以下角色即使本轮输入没有提到，也有可能在正文中出现，并且正在做他们正在做的事。这只是叙事机会，不是强行改写玩家行动，也不可把未发现痕迹写成业已掌握。同地可以写成可能在此处出现；地点不同或不确定时只给“可能路过”的机会，系统并未计算路线，也未声称对方已经到达。';
    const lines = [header];
    let used = header.length;
    for (const item of encounters) {
        const place = item.locationName ? `（${item.locationName}）` : '';
        const line = `- ${item.npcName || item.npcId}${place}正在：${item.summary || '继续自己的事'}｜${encounterFitNote(item.fit)}`;
        if (used + line.length + 1 > limit) break;
        lines.push(line);
        used += line.length + 1;
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

export function buildLivingWorldInjection(input = {}) {
    const prefs = normalizeLivingWorldPreferences(input.preferences || {});
    const currentTurn = Number.isSafeInteger(input.currentTurn) ? input.currentTurn : (input.ledger?.turnCursor || 0);
    const rawEntries = collectWorldBookEntries(input);
    const windowed = applySlidingWindow(rawEntries, {
        maxEntries: prefs.worldBookMaxEntries,
        maxTurns: prefs.worldBookMaxTurns,
        currentTurn,
    });
    const worldBook = formatWorldBook(windowed, prefs.worldBookBudget);

    const submitted = collectSubmittedWorldResults(input);
    const pending = [...(input.pendingResults || []), ...((input.ledger?.activities || []).filter(item => item && item.committed !== true))];
    const pendingIds = new Set(pending.map(item => item.id).filter(Boolean));
    const usable = submitted.filter(item => !pendingIds.has(item.id));
    const overlaps = matchIntentOverlap(input.playerIntent || '', usable, input);
    const overlapText = formatIntentOverlap(overlaps, prefs.intentOverlapBudget);

    const npcs = input.npcs || [];
    const states = input.states || {};
    const mentionedText = `${input.playerIntent || ''}\n${input.mentionedText || ''}\n${input.recentText || ''}`;
    const eligible = [];
    for (const npc of npcs) {
        const state = states[npc.id] || {};
        const verdict = encounterEligibility(npc, state, {
            ...input, mentionedText, playerLocationId: input.player?.locationId || input.playerLocationId,
            ledger: input.ledger, lore: typeof input.npcLore === 'function' ? input.npcLore(npc) : (npc.description || ''),
        });
        if (!verdict.ok) continue;
        eligible.push({
            npcId: npc.id, npcName: npc.name, fit: verdict.fit,
            locationId: state.locationId,
            locationName: placeOf(state.locationId, input),
            summary: currentDoingSummary(npc, input.ledger, state),
        });
    }
    const encounters = selectEncounters(eligible, {
        probability: prefs.encounterProbability,
        maxPerTurn: prefs.encounterMaxPerTurn,
        preferences: prefs,
        seed: input.seed || '',
        currentTurn,
        random: input.random,
    });
    const encounterText = formatEncounters(encounters);

    // 偶遇与世界书都不得把痕迹标成已发现，本模块不调用 recordDiscovery。
    const textParts = [worldBook, overlapText, encounterText].filter(Boolean);
    return {
        worldBook, overlaps, encounters, windowed,
        overlapText, encounterText,
        text: textParts.join('\n\n'),
        preferences: prefs,
    };
}

export { isConfined, explicitlyAbsent, namedLocation, committedActivities, committedTimelineEvents };

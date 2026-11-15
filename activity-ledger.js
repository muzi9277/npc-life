/* NPC 活动与痕迹资料库：做过/正在做/准备做与玩家发现分开存储，可按相关性检索。不访问宿主或网络。 */

const copy = value => structuredClone(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const unique = list => [...new Set((list || []).filter(value => typeof value === 'string' && value))];

export const ACTIVITY_PHASES = ['done', 'doing', 'planned'];
export const LEDGER_SOURCES = ['story', 'settlement', 'user', 'claim'];
const TRACE_DELAY_TURNS = 1;
const ACTIVITY_SOFT_LIMIT = 240;
const TRACE_SOFT_LIMIT = 240;
const GENERIC_TRACE_WORDS = new Set(['痕迹', '行踪', '线索', '机会', '相关', '地点', '完成', '计划', '事先', '活动', '留下', '有人', '来过', '好像', '似乎', '未知', 'unknown', 'npc']);

// 只对确实会留下可观察物证的行动生成痕迹。拿不准时不生成，禁止空泛的「留下行踪」。
export const OBSERVABLE_TRACE_TYPES = [
    { type: 'search', label: '搜寻痕迹', pattern: /调查|搜寻|搜索|探查|翻找|翻查|翻乱|翻过|查找|搜查/ },
    { type: 'combat', label: '打斗痕迹', pattern: /打斗|打架|交手|厮杀|搏斗|开战|砍伤|刺伤|战斗|交战|斩杀|击伤|打伤|血战|动武/ },
    { type: 'damage', label: '破坏痕迹', pattern: /破坏|砸碎|打碎|拆毁|烧毁|打破|毁坏|撞开|撬开|砸开|砍断|撕毁|炸开|破门|砸门/ },
    { type: 'item', label: '物品变动', pattern: /留下(?:了)?(?:一|这|那)?(?:件|封|份|袋|个|张|枚|本|块|把)?(?:信|物|剑|刀|包|箱|标记|符号|纸条|血迹|脚印|足迹|衣|徽章|钥匙|地图|书信|碎片|灰烬|火堆|绳|锁|包裹)|取走|拿走|丢下|遗落|偷走|带走了|藏下了|掉落/ },
    { type: 'intrusion', label: '闯入痕迹', pattern: /闯入|闯进|私闯|闯空门|闯入院|破门而入|翻墙|砸门/ },
    { type: 'escape', label: '逃亡痕迹', pattern: /逃(?:亡|窜)|落荒|仓皇(?:逃|离)|慌忙逃|留下(?:了)?(?:足迹|脚印|血迹|奔跑的痕迹)/ },
    { type: 'meeting', label: '会合物证', pattern: /(?:会合|接头).{0,24}(?:留下|信物|纸条|标记|暗号|交换)|留下(?:了)?(?:一[封张条])?(?:信|纸条|标记|暗号|信物)|交换(?:了)?(?:信物|信件|信笺)/ },
];

const ROUTINE_OR_MENTAL = /阅读|读书|看书|翻书|思考|沉思|默想|心想|暗自|心中|休息|睡觉|入睡|打盹|小憩|打坐|冥想|做饭|煮饭|烧饭|做饭菜|吃饭|用餐|用膳|进餐|喝(?:茶|水|酒)|闲聊|交谈|对话|说话|闲谈|聊天/;
const INTENT_OR_PLAN = /(?:计划|打算|准备|想要|希望)(?:去|前往|做|要)?/;
const DISCOVERY_EVIDENCE = /发现(?:了|到)?|找到(?:了)?|看见(?:了)?(?:这里|地上|门|桌上|书架|墙|窗)?(?:有|被)?|注意到(?:了)?|看出(?:了)?|捡到|拾到|好像有人来过|似乎有人来过|留下(?:了)?(?:足迹|脚印|痕迹|线索|血迹|翻找)|被翻(?:过|乱)|被撬(?:过|开)|被人动过/;
const NEGATED_DISCOVERY = /没(?:有)?(?:发现|找到|看见|看到|注意到)|未(?:曾)?(?:发现|找到|看见|看到|注意到)|看不出|并未(?:发现|找到|看见|看到|注意到)|不曾(?:发现|找到|看见|看到|注意到)/;

export function createLedger() {
    return { version: 1, turnCursor: 0, activities: [], traces: [], discoveries: [],
        archived: { activities: [], traces: [], discoveries: [] } };
}

export function normalizeLedger(raw) {
    if (!raw || typeof raw !== 'object') return createLedger();
    const next = createLedger();
    next.turnCursor = Number.isSafeInteger(raw.turnCursor) && raw.turnCursor >= 0 ? raw.turnCursor : 0;
    for (const key of ['activities', 'traces', 'discoveries']) {
        next[key] = Array.isArray(raw[key]) ? raw[key].map(item => copy(item)).filter(Boolean) : [];
        next.archived[key] = Array.isArray(raw.archived?.[key]) ? raw.archived[key].map(item => copy(item)).filter(Boolean) : [];
    }
    return next;
}

function allRecords(ledger, key) {
    return [...(ledger[key] || []), ...(ledger.archived?.[key] || [])];
}

function nextId(ledger, prefix) {
    const count = allRecords(ledger, 'activities').length + allRecords(ledger, 'traces').length
        + allRecords(ledger, 'discoveries').length + 1;
    return `${prefix}:${ledger.turnCursor || 0}:${count}`;
}

export function hasSufficientProfile(npc, lore = '') {
    if (npc?.hasProfile === true) return true;
    if (npc?.hasProfile === false) return false;
    const chunks = [npc?.description, npc?.identityEvidence, npc?.personality, lore]
        .map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const blob = chunks.join(' ');
    // 只要有设定/性格资料即可，不必很长；仅有名字、没有条目则视为资料不足。
    return blob.length >= 8;
}

export function isUserDesignated(npc) {
    return npc?.userDesignated === true || npc?.designated === true
        || npc?.enrolledReason === 'manual'
        || (npc?.source === 'manual' && npc?.tracked === true);
}

export function hasAppearedInPlay(npc, extras = {}) {
    if (npc?.appeared === true) return true;
    if (npc?.appeared === false) return false;
    if (['present', 'mentioned', 'settlement'].includes(npc?.enrolledReason)) return true;
    if (extras.scene === 'present') return true;
    return false;
}

// 玩家指定的人可以安排；未登场且资料不足的原创角色不提前安排。无标志的旧追踪记录保持兼容。
export function canArrangeActivity(npc, extras = {}) {
    if (!npc || npc.archived || npc.ignored || npc.mergedInto || npc.tracked !== true) return false;
    if (isUserDesignated(npc)) return true;
    const appeared = hasAppearedInPlay(npc, extras);
    const profile = hasSufficientProfile(npc, extras.lore);
    if (npc.appeared === false && !profile) return false;
    if (npc.hasProfile === false && !appeared) return false;
    if (npc.appeared == null && npc.hasProfile == null && !npc.enrolledReason) return true;
    return appeared && profile;
}

export function isInvestigationText(value) {
    const raw = text(value);
    if (!raw) return false;
    return /调查|检查|查看|搜寻|搜索|寻找|翻看|探查|追踪痕迹|有没有人来过|好像有人|留下(?:了)?(?:痕迹|足迹|线索|气息)|线索|足迹|残痕/.test(raw);
}

export function isDiscoveryEvidenceText(value, extras = {}) {
    const raw = text(value);
    if (!raw) return false;
    const npcNames = discoveryNpcNames(extras);
    return splitSentences(raw).some(sentence => sentenceHasDiscovery(sentence, npcNames));
}

function splitSentences(value) {
    return text(value).split(/(?<=[。！？!?\n])/).map(item => item.trim()).filter(Boolean);
}

function escapeReg(value) {
    return text(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function discoveryNpcNames(context = {}) {
    return unique((context.npcs || []).flatMap(npc => [npc?.name, ...(npc?.aliases || [])])).filter(name => name.length >= 2);
}

const INQUIRY_SPAN = /(?:检查|查看|调查|看看|看一下|确认|想知道)?[^\n。！？!?，,、；;]{0,16}(?:有没有|有无|是否|是不是)[^\n。！？!?，,、；;]*/g;
const OTHER_PRONOUN_DISCOVERY = /(?:^|[，,、；;。]|并且|而且|随后)(?:他|她|他们|她们|对方)(?:已经|也|还|又|终于|突然|好像|似乎)?(?:发现|看见|看到|注意到|找到)/;
const IMMEDIATE_OTHER_SUBJECT = /(?:^|[，,、；;])([\u4e00-\u9fffA-Za-z]{2,8})(?:已经|也|还|又|终于|突然|好像|似乎)?(?:发现了|发现到|发现|看见了|看见|看到了|看到|注意到|找到了|找到)/;
const OTHER_ACTOR_ADVERBS = new Set(['于是', '结果', '这时', '此时', '然后', '随后', '忽然', '突然', '终于', '这才', '好像', '似乎', '还是', '没有', '并未', '不曾', '已经', '同时', '而且', '并且', '此外', '另外', '接着', '立刻', '马上', '最终', '原来', '其实', '果然', '显然', '如果', '假如', '要是', '只见', '只是', '不过', '但是', '可是', '因为', '所以', '因此', '后来', '开始', '继续', '经过', '通过', '按照']);

function stripInquiryClauses(sentence) {
    return text(sentence)
        .replace(/(?:有没有|有无|是否|是不是)[^。！？!?，,、；;]*人来过/g, '')
        .replace(/(?:有没有|有无|是否|是不是)(?:留下|见到|发现)?(?:痕迹|足迹|线索)/g, '')
        .replace(INQUIRY_SPAN, '')
        .replace(/[？?]+/g, '')
        .replace(/[、，,]{2,}/g, '，')
        .replace(/^[、，,\s]+|[、，,\s]+$/g, '')
        .trim();
}

function isInquirySentence(sentence) {
    const raw = text(sentence);
    if (!raw) return true;
    if (/[？?]$/.test(raw)) return true;
    if (/[吗麼么][。！!]?$/.test(raw)) return true;
    if (/(?:有没有|有无|是否|是不是)/.test(raw)) return true;
    if (/(?:检查|查看|调查|看看|确认).{0,16}(?:没有|与否)\s*$/.test(raw)
        && !/(?:发现|看见|看到|注意到)(?:了|到)?/.test(raw)) return true;
    return false;
}

function isPlayerPerceptionSentence(sentence) {
    const raw = text(sentence);
    if (!raw) return false;
    if (/(?:^|[，,、；;：:])(?:你|我)(?:已经|也|还|又|终于|突然|这才|好像|似乎|仔细)?(?:[^\n。！？!?]{0,24})(?:发现|看见|看到|注意到|看出|找到|捡到|拾到)/.test(raw)) return true;
    if (/^(?:你|我)/.test(raw) && DISCOVERY_EVIDENCE.test(raw)) return true;
    return false;
}

function looksLikePersonName(value) {
    const name = text(value);
    if (name.length < 2 || name.length > 4) return false;
    if (/^(?:你|我)/.test(name)) return false;
    if (OTHER_ACTOR_ADVERBS.has(name)) return false;
    if (/[后时中里上下前后内外边间着过了的地得]/.test(name)) return false;
    if (/(?:查看|调查|检查|观察|搜寻|搜索|寻找|注意|发现|看见|看到)/.test(name)) return false;
    return true;
}

function isOtherActorDiscovery(sentence, npcNames = []) {
    const raw = text(sentence);
    if (!raw) return false;
    if (OTHER_PRONOUN_DISCOVERY.test(raw)) return true;
    const names = unique([...(npcNames || [])].filter(name => text(name).length >= 2))
        .sort((a, b) => b.length - a.length);
    for (const name of names) {
        const re = new RegExp(`${escapeReg(name)}(?:已经|也|还|又|终于|突然|好像|似乎|在[^，。！？!?]{0,12})?(?:发现|看见|看到|注意到|找到)`);
        if (re.test(raw)) return true;
    }
    const match = raw.match(IMMEDIATE_OTHER_SUBJECT);
    return Boolean(match?.[1] && looksLikePersonName(match[1]) && match[1] !== '你' && match[1] !== '我');
}

function stripNegatedClauses(sentence) {
    return text(sentence)
        .split(/(?<=[，,、；;])/)
        .filter(clause => clause && !NEGATED_DISCOVERY.test(clause))
        .join('')
        .replace(/^[、，,\s]+|[、，,\s]+$/g, '')
        .trim();
}

function sentenceHasDiscovery(sentence, npcNames = []) {
    if (!sentence) return false;
    const source = isInquirySentence(sentence) ? stripInquiryClauses(sentence) : sentence;
    if (!source || isInquirySentence(source)) return false;
    const remaining = stripNegatedClauses(source);
    if (!remaining || NEGATED_DISCOVERY.test(remaining)) return false;
    if (isOtherActorDiscovery(remaining, npcNames)) return false;
    return DISCOVERY_EVIDENCE.test(remaining);
}

function normalizeDiscoveryEntries(context = {}) {
    if (Array.isArray(context.messages) && context.messages.length) {
        return context.messages.map(item => {
            const role = item?.role === 'user' || item?.is_user ? 'user'
                : item?.role === 'assistant' || item?.is_user === false ? 'assistant'
                : text(item?.role) || 'mixed';
            const content = text(item?.content ?? item?.mes ?? item?.text);
            return { role, content };
        }).filter(item => item.content);
    }
    const story = text(context.text);
    return story ? [{ role: 'mixed', content: story }] : [];
}

function coreActionText(summary) {
    return text(summary).replace(/^[^，。]+完成了事先计划的/, '');
}

function placeLabel(locationId, meta = {}) {
    const raw = text(locationId);
    if (!raw || raw === 'unknown') return '地点不详';
    if (typeof meta.locationName === 'function') return text(meta.locationName(raw)) || raw;
    if (text(meta.locationLabel) && (!meta.locationId || meta.locationId === raw)) return text(meta.locationLabel);
    const found = (meta.locations || []).find(item => item.id === raw);
    if (found?.name) return found.name;
    return raw;
}

// 从行动文本判断是否留下可观察痕迹。必须带类型和地点／内容；不确定则返回 null。
export function describeObservableTrace(action = {}, meta = {}) {
    const summary = text(action.summary || action.activity || action.goal);
    const kind = text(action.kind);
    if (!summary) return null;
    if (kind === 'wait') return null;
    if (action.phase === 'planned') return null;
    if (kind === 'travel' && /意向|准备前往|未计算到达/.test(summary)) return null;
    const core = coreActionText(summary);
    if (!core) return null;
    if (INTENT_OR_PLAN.test(core) && !/(?:已经|完成了|留下了|砸开了|闯入了|翻乱了|取走了)/.test(core)) return null;

    const blob = `${kind} ${core}`;
    const matches = [];
    for (const item of OBSERVABLE_TRACE_TYPES) {
        const found = blob.match(item.pattern);
        if (found) matches.push({ ...item, index: found.index ?? 0 });
    }
    if (!matches.length) return null;

    const routine = ROUTINE_OR_MENTAL.exec(core);
    if (routine) {
        const resultClause = /(?:[，,。；;]|并且|而且|还|随后|同时).{0,12}(?:留下|砸|闯入|取走|翻乱|打碎|逃走|破坏|血迹|脚印)/.test(core);
        const earliestWorthy = Math.min(...matches.map(item => item.index));
        if (!resultClause && routine.index <= earliestWorthy) return null;
    }

    matches.sort((a, b) => a.index - b.index);
    const chosen = matches[0];
    const locationId = text(action.locationId) || 'unknown';
    const content = core.slice(0, 200);
    const place = placeLabel(locationId, meta);
    return {
        type: chosen.type,
        label: chosen.label,
        locationId,
        content,
        summary: `${chosen.label}：在${place}，${content}`,
        keywords: unique([chosen.type, chosen.label, place, locationId, ...content.split(/[，。、；;,\s]+/).filter(word => word.length >= 2 && !GENERIC_TRACE_WORDS.has(word))]).slice(0, 16),
    };
}

export function recordActivity(ledger, input = {}) {
    const activity = {
        id: text(input.id) || nextId(ledger, 'act'),
        npcIds: unique(input.npcIds),
        phase: ACTIVITY_PHASES.includes(input.phase) ? input.phase : 'planned',
        summary: text(input.summary).slice(0, 240),
        locationId: text(input.locationId) || 'unknown',
        clockMinutes: Number.isSafeInteger(input.clockMinutes) ? input.clockMinutes : null,
        turnId: text(input.turnId),
        createdAtTurn: Number.isSafeInteger(input.createdAtTurn) ? input.createdAtTurn : ledger.turnCursor,
        source: LEDGER_SOURCES.includes(input.source) ? input.source : 'settlement',
        sourceKeys: unique(input.sourceKeys),
        committed: input.committed === true,
        publicCanon: input.publicCanon === true,
        status: input.status === 'revoked' ? 'revoked' : 'active',
    };
    if (!activity.npcIds.length || !activity.summary) return null;
    ledger.activities.push(activity);
    return activity;
}

export function recordTrace(ledger, input = {}) {
    const trace = {
        id: text(input.id) || nextId(ledger, 'trace'),
        activityId: text(input.activityId),
        npcIds: unique(input.npcIds),
        locationId: text(input.locationId) || 'unknown',
        traceType: text(input.traceType),
        content: text(input.content).slice(0, 240),
        summary: text(input.summary).slice(0, 240),
        keywords: unique(input.keywords).slice(0, 16),
        turnId: text(input.turnId),
        createdAtTurn: Number.isSafeInteger(input.createdAtTurn) ? input.createdAtTurn : ledger.turnCursor,
        source: LEDGER_SOURCES.includes(input.source) ? input.source : 'settlement',
        sourceKeys: unique(input.sourceKeys),
        committed: input.committed === true,
        status: input.status === 'revoked' ? 'revoked' : 'active',
    };
    if (!trace.summary) return null;
    ledger.traces.push(trace);
    return trace;
}

export function recordDiscovery(ledger, input = {}) {
    const traceId = text(input.traceId);
    if (!traceId) return null;
    const knowledge = input.knowledge === 'found' ? 'found' : 'offered';
    if (knowledge === 'found') {
        const existing = allRecords(ledger, 'discoveries').find(item => item.traceId === traceId && item.status === 'active' && item.knowledge === 'found');
        if (existing) {
            if (text(input.evidence) && !text(existing.evidence)) existing.evidence = text(input.evidence).slice(0, 500);
            existing.sourceKeys = unique([...(existing.sourceKeys || []), ...(input.sourceKeys || [])]);
            return existing;
        }
    } else {
        const existing = activeDiscovery(ledger, traceId);
        if (existing) return existing;
    }
    const discovery = {
        id: text(input.id) || nextId(ledger, knowledge === 'found' ? 'found' : 'offer'),
        traceId,
        discoveredAtTurn: Number.isSafeInteger(input.discoveredAtTurn) ? input.discoveredAtTurn
            : Number.isSafeInteger(input.offeredAtTurn) ? input.offeredAtTurn : ledger.turnCursor,
        turnId: text(input.turnId),
        source: LEDGER_SOURCES.includes(input.source) ? input.source : 'story',
        sourceKeys: unique(input.sourceKeys),
        evidence: text(input.evidence).slice(0, 500),
        // offered：只是线索机会；found：已发现正史。编辑来源后两者都应回退。
        knowledge,
        status: input.status === 'revoked' ? 'revoked' : 'active',
    };
    ledger.discoveries.push(discovery);
    return discovery;
}

export function appendSettlementDrafts(ledger, drafts = [], meta = {}) {
    const created = { activities: [], traces: [] };
    for (const draft of drafts.activities || []) {
        const activity = recordActivity(ledger, { ...draft, ...meta, committed: false });
        if (activity) created.activities.push(activity);
    }
    for (const draft of drafts.traces || []) {
        const trace = recordTrace(ledger, { ...draft, ...meta, committed: false });
        if (trace) created.traces.push(trace);
    }
    return created;
}

export function commitLedgerTurn(ledger, turnId, turnCursor) {
    const id = text(turnId);
    if (Number.isSafeInteger(turnCursor) && turnCursor >= 0) ledger.turnCursor = turnCursor;
    for (const item of [...ledger.activities, ...ledger.traces]) {
        if (item.status !== 'revoked' && (!id || item.turnId === id)) item.committed = true;
    }
    maybeArchive(ledger);
    return ledger;
}

export function revokeLedgerTurn(ledger, turnId) {
    const id = text(turnId);
    if (!id) return ledger;
    for (const item of allRecords(ledger, 'activities')) if (item.turnId === id) item.status = 'revoked';
    const revokedTraceIds = new Set();
    for (const item of allRecords(ledger, 'traces')) if (item.turnId === id) {
        item.status = 'revoked';
        revokedTraceIds.add(item.id);
    }
    for (const item of allRecords(ledger, 'discoveries')) {
        if (item.turnId === id || revokedTraceIds.has(item.traceId)) item.status = 'revoked';
    }
    return ledger;
}

export function revokeBySourceKeys(ledger, changedKeys = []) {
    const keys = new Set(unique(changedKeys));
    if (!keys.size) return { activities: 0, traces: 0, discoveries: 0 };
    const hit = item => (item.sourceKeys || []).some(key => keys.has(key));
    const counts = { activities: 0, traces: 0, discoveries: 0 };
    const revokedTraceIds = new Set();
    for (const item of allRecords(ledger, 'activities')) if (item.status !== 'revoked' && hit(item)) {
        item.status = 'revoked'; counts.activities++;
    }
    for (const item of allRecords(ledger, 'traces')) if (item.status !== 'revoked' && (hit(item) || allRecords(ledger, 'activities').some(activity => activity.id === item.activityId && activity.status === 'revoked'))) {
        item.status = 'revoked'; revokedTraceIds.add(item.id); counts.traces++;
    }
    for (const item of allRecords(ledger, 'discoveries')) if (item.status !== 'revoked' && (hit(item) || revokedTraceIds.has(item.traceId))) {
        item.status = 'revoked'; counts.discoveries++;
    }
    return counts;
}

export function activeDiscovery(ledger, traceId) {
    const rows = allRecords(ledger, 'discoveries').filter(item => item.traceId === traceId && item.status === 'active');
    return rows.find(item => item.knowledge === 'found') || rows[0] || null;
}

export function isDiscoveredCanon(ledger, traceId) {
    return allRecords(ledger, 'discoveries').some(item => item.traceId === traceId && item.status === 'active' && item.knowledge === 'found');
}

function scoreTrace(trace, context, names, locationNames) {
    const blob = `${trace.summary} ${trace.content || ''} ${(trace.keywords || []).join(' ')} ${trace.locationId}`.toLowerCase();
    const hay = text(context.text).toLowerCase();
    let score = 0;
    if (context.locationId && trace.locationId && trace.locationId !== 'unknown' && trace.locationId === context.locationId) score += 40;
    for (const name of locationNames) if (name && hay.includes(name.toLowerCase())) score += 12;
    for (const name of names) if (name && (hay.includes(name) && blob.includes(name.toLowerCase()))) score += 16;
    for (const word of (trace.keywords || [])) if (word && hay.includes(word.toLowerCase())) score += 10;
    if (isInvestigationText(context.text)) score += 20;
    return score;
}

// 只返回已提交、且已过延迟、并与当前调查/场景相关的未发现痕迹。已发现的不得再以机会出现。
export function searchDiscoverableTraces(ledger, context = {}) {
    const currentTurn = Number.isSafeInteger(context.currentTurn) ? context.currentTurn : ledger.turnCursor;
    const delay = Number.isSafeInteger(context.minDelayTurns) ? Math.max(0, context.minDelayTurns) : TRACE_DELAY_TURNS;
    const names = unique((context.npcs || []).flatMap(npc => [npc.name, ...(npc.aliases || [])]));
    const place = typeof context.locationName === 'function' ? context.locationName(context.locationId) : context.locationName;
    const locationNames = unique([place, context.locationLabel, ...(context.locations || []).map(item => item.name)]);
    const related = isInvestigationText(context.text) || !!context.locationId;
    if (!related && !text(context.text)) return [];
    const rows = [];
    for (const trace of allRecords(ledger, 'traces')) {
        if (trace.status === 'revoked' || trace.committed !== true) continue;
        if ((trace.createdAtTurn ?? 0) + delay > currentTurn) continue;
        if (isDiscoveredCanon(ledger, trace.id)) continue;
        const score = scoreTrace(trace, context, names, locationNames);
        if (score <= 0) continue;
        rows.push({ trace, score, discovered: false });
    }
    rows.sort((a, b) => b.score - a.score || a.trace.createdAtTurn - b.trace.createdAtTurn);
    return rows;
}

export function searchFoundClues(ledger, context = {}) {
    const currentTurn = Number.isSafeInteger(context.currentTurn) ? context.currentTurn : ledger.turnCursor;
    const names = unique((context.npcs || []).flatMap(npc => [npc.name, ...(npc.aliases || [])]));
    const place = typeof context.locationName === 'function' ? context.locationName(context.locationId) : context.locationName;
    const locationNames = unique([place, context.locationLabel, ...(context.locations || []).map(item => item.name)]);
    const rows = [];
    for (const trace of allRecords(ledger, 'traces')) {
        if (trace.status === 'revoked' || trace.committed !== true) continue;
        const discovery = allRecords(ledger, 'discoveries').find(item => item.traceId === trace.id && item.status === 'active' && item.knowledge === 'found');
        if (!discovery) continue;
        const score = scoreTrace(trace, context, names, locationNames);
        const recent = currentTurn - (discovery.discoveredAtTurn ?? 0) <= 4;
        if (score <= 0 && !recent) continue;
        rows.push({ trace, discovery, score: score + (recent ? 8 : 0) });
    }
    rows.sort((a, b) => b.score - a.score || (a.discovery.discoveredAtTurn ?? 0) - (b.discovery.discoveredAtTurn ?? 0));
    return rows;
}

export function activitiesForNpc(ledger, npcId, { includeArchived = true } = {}) {
    const list = includeArchived ? allRecords(ledger, 'activities') : (ledger.activities || []);
    return list.filter(item => item.status !== 'revoked' && item.committed === true && item.npcIds.includes(npcId));
}

function opportunityLabel(trace) {
    const typeItem = OBSERVABLE_TRACE_TYPES.find(item => item.type === trace?.traceType);
    if (typeItem?.label) return typeItem.label;
    const prefix = text(trace?.summary).split(/[：:]/)[0];
    return prefix || '痕迹';
}

function opportunityPlace(trace, context = {}) {
    let place = placeLabel(trace?.locationId, context);
    if (!place || place === '地点不详' || place === trace?.locationId) {
        const fromSummary = text(trace?.summary).match(/：在([^，,。：:]+)/);
        if (fromSummary?.[1]) place = fromSummary[1];
    }
    return place && place !== '地点不详' ? place : '地点不详';
}

// 机会注入只给类型和地点，不带出痕迹摘要里的具体物证或 NPC 秘密活动。
export function formatOpportunityLine(trace, context = {}) {
    const place = opportunityPlace(trace, context);
    const placeText = place === '地点不详' ? '地点不详' : `在${place}`;
    return `- 机会：${opportunityLabel(trace)}：${placeText}，这里好像有人来过。`;
}

export function buildClueOpportunities(hits, budget = 800, context = {}) {
    if (!hits?.length || !Number.isFinite(budget) || budget <= 0) return { text: '', traces: [] };
    const header = '【可被发现的线索机会】以下痕迹已存在于后台资料库，但玩家尚未发现。不要写成玩家已经看见或已经知道，只在调查或进入相关场景时，给正文表现“这里好像有人来过”的机会。它们不是全知旁白，也不是已提交的正史。不要提前写出具体物证或谁做过什么。';
    const lines = [header];
    const traces = [];
    const seen = new Set();
    let used = header.length;
    for (const { trace } of hits.slice(0, 6)) {
        if (!trace?.id) continue;
        const key = `${text(trace.traceType)}::${text(trace.locationId)}`;
        if (seen.has(key)) continue;
        const line = formatOpportunityLine(trace, context);
        if (used + line.length + 1 > budget) break;
        seen.add(key);
        lines.push(line);
        traces.push(trace);
        used += line.length + 1;
    }
    return lines.length > 1 ? { text: lines.join('\n'), traces } : { text: '', traces: [] };
}

export function formatClueOpportunities(hits, budget = 800, context = {}) {
    return buildClueOpportunities(hits, budget, context).text;
}

export function tracesShownInText(textValue, traces = [], context = {}) {
    const hay = text(textValue);
    if (!hay) return [];
    const shown = [];
    for (const trace of traces) {
        if (!trace?.id) continue;
        const line = formatOpportunityLine(trace, context);
        if (hay.includes(line)) shown.push(trace);
    }
    return shown;
}

export function formatFoundClues(hits, budget = 600) {
    if (!hits?.length || !Number.isFinite(budget) || budget <= 0) return '';
    const header = '【已发现的线索】玩家已经发现这些痕迹，可以按已知事实写入正文。不要再写成尚未发现的“可发现机会”，也不要再写成“这里好像有人来过”。';
    const lines = [header];
    let used = header.length;
    for (const { trace } of hits.slice(0, 6)) {
        const line = `- 已发现：${trace.summary}`;
        if (used + line.length + 1 > budget) break;
        lines.push(line);
        used += line.length + 1;
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

export function formatActivityStatus(ledger, npcs = [], locationName = id => id, limit = 4) {
    const lines = [];
    for (const npc of npcs) {
        const items = activitiesForNpc(ledger, npc.id);
        if (!items.length) continue;
        const doing = items.filter(item => item.phase === 'doing').at(-1);
        const planned = items.filter(item => item.phase === 'planned').at(-1);
        const done = items.filter(item => item.phase === 'done' && item.publicCanon).at(-1);
        const parts = [];
        if (doing) parts.push(`正在做：${doing.summary}`);
        if (planned) parts.push(`准备做：${planned.summary}`);
        if (done) parts.push(`已公开做过：${done.summary}`);
        if (!parts.length) continue;
        const place = locationName(doing?.locationId || planned?.locationId || done?.locationId || 'unknown');
        lines.push(`${npc.name}｜${place || '地点不详'}｜${parts.join('；')}`);
        if (lines.length >= limit) break;
    }
    if (!lines.length) return '';
    return ['【当前短状态】来自已提交资料库，未同场者不要写成站在眼前。准备做/正在做不是已经发生的结果。', ...lines].join('\n');
}

export function buildLedgerInjection(ledger, context = {}) {
    const opportunities = searchDiscoverableTraces(ledger, context);
    const found = searchFoundClues(ledger, context);
    const clues = buildClueOpportunities(opportunities, context.clueBudget ?? 700, context);
    const known = formatFoundClues(found, context.foundBudget ?? 600);
    const nameOf = typeof context.locationName === 'function' ? context.locationName : (id => context.locationLabel || id);
    const status = formatActivityStatus(ledger, context.npcs || [], nameOf, 4);
    return {
        text: [status, known, clues.text].filter(Boolean).join('\n\n'),
        opportunityTraces: clues.traces,
    };
}

export function formatLedgerInjection(ledger, context = {}) {
    return buildLedgerInjection(ledger, context).text;
}

export function recordOfferedOpportunities(ledger, hits = [], meta = {}) {
    const created = [];
    for (const row of hits) {
        const trace = row?.trace || row;
        if (!trace?.id || isDiscoveredCanon(ledger, trace.id)) continue;
        const rec = recordDiscovery(ledger, {
            traceId: trace.id,
            knowledge: 'offered',
            offeredAtTurn: meta.offeredAtTurn ?? meta.discoveredAtTurn,
            turnId: meta.turnId,
            source: meta.source || 'story',
            sourceKeys: meta.sourceKeys,
        });
        if (rec && rec.knowledge === 'offered') created.push(rec);
    }
    return created;
}

function distinctiveWords(trace, context = {}) {
    const place = placeLabel(trace.locationId, context);
    const words = [...(trace.keywords || []), trace.traceType, trace.content, place];
    if (trace.locationId && trace.locationId !== 'unknown') words.push(trace.locationId);
    for (const part of text(trace.summary).split(/[：:，。、；;,\s]+/)) words.push(part);
    return unique(words.map(text).filter(word => word.length >= 2 && !GENERIC_TRACE_WORDS.has(word)));
}

function linkScore(sentence, trace, context = {}) {
    let score = 0;
    const place = placeLabel(trace.locationId, context);
    if (place && place !== '地点不详' && sentence.includes(place)) score += 3;
    if (trace.locationId && trace.locationId !== 'unknown' && sentence.includes(trace.locationId)) score += 2;
    if (sentence.includes('这里') && context.locationId && trace.locationId === context.locationId) score += 1;
    const typeItem = OBSERVABLE_TRACE_TYPES.find(item => item.type === trace.traceType);
    if (typeItem && sentence.includes(typeItem.label.replace('痕迹', '').replace('物证', ''))) score += 1;
    for (const word of distinctiveWords(trace, context)) {
        if (word && sentence.includes(word)) score += 1;
    }
    return score;
}

function eligibleDiscoveryTraces(ledger, context = {}) {
    const currentTurn = Number.isSafeInteger(context.currentTurn) ? context.currentTurn : ledger.turnCursor;
    const delay = Number.isSafeInteger(context.minDelayTurns) ? Math.max(0, context.minDelayTurns) : TRACE_DELAY_TURNS;
    return allRecords(ledger, 'traces').filter(trace => {
        if (trace.status === 'revoked' || trace.committed !== true) return false;
        if ((trace.createdAtTurn ?? 0) + delay > currentTurn) return false;
        if (isDiscoveredCanon(ledger, trace.id)) return false;
        return true;
    });
}

// 根据本轮正文保守写回「已发现」。只用玩家消息确认玩家发现；助手消息须是玩家视角感知，且对应已注入线索。纯问句和他人发现不写回；同一句里问句后面的真实发现仍写回。
export function applyStoryDiscoveries(ledger, context = {}) {
    const entries = normalizeDiscoveryEntries(context);
    if (!entries.length) return [];
    const npcNames = discoveryNpcNames(context);
    const offeredIds = new Set(unique(context.offeredTraceIds));
    const candidates = eligibleDiscoveryTraces(ledger, context);
    if (!candidates.length) return [];
    const assigned = new Map();
    const tryAssign = (trace, sentence, { explicit, role, playerView, otherActor }) => {
        if (!trace || assigned.has(trace.id) || otherActor) return;
        const wasOffered = offeredIds.has(trace.id) || activeDiscovery(ledger, trace.id)?.knowledge === 'offered';
        if (role === 'assistant') {
            if (!playerView || !wasOffered) return;
        } else if (role === 'user') {
            if (!explicit && !wasOffered) return;
        } else if (playerView) {
            const firstPerson = /(?:^|[，,、；;])我/.test(sentence);
            if (firstPerson) {
                if (!explicit && !wasOffered) return;
            } else if (!wasOffered) return;
        } else {
            return;
        }
        assigned.set(trace.id, sentence);
    };
    for (const entry of entries) {
        const sentences = splitSentences(entry.content).filter(sentence => sentenceHasDiscovery(sentence, npcNames));
        for (const sentence of sentences) {
            const playerView = isPlayerPerceptionSentence(sentence);
            const otherActor = isOtherActorDiscovery(sentence, npcNames);
            const meta = { role: entry.role, playerView, otherActor };
            const scored = candidates.map(trace => ({ trace, score: linkScore(sentence, trace, context) }))
                .filter(item => item.score > 0 && !assigned.has(item.trace.id))
                .sort((a, b) => b.score - a.score);
            if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
                tryAssign(scored[0].trace, sentence, { ...meta, explicit: scored[0].score >= 2 });
                continue;
            }
            if (scored.length > 1) {
                const offered = scored.filter(item => offeredIds.has(item.trace.id) || activeDiscovery(ledger, item.trace.id)?.knowledge === 'offered');
                if (offered.length === 1) tryAssign(offered[0].trace, sentence, { ...meta, explicit: false });
                continue;
            }
            const offeredHere = candidates.filter(trace => !assigned.has(trace.id)
                && (offeredIds.has(trace.id) || activeDiscovery(ledger, trace.id)?.knowledge === 'offered')
                && trace.locationId && trace.locationId === context.locationId);
            if (offeredHere.length === 1 && (playerView || entry.role === 'user') && (sentence.includes('这里') || playerView)) {
                tryAssign(offeredHere[0], sentence, { ...meta, explicit: false });
            }
        }
    }
    const created = [];
    for (const [traceId, evidence] of assigned) {
        const rec = recordDiscovery(ledger, {
            traceId,
            knowledge: 'found',
            discoveredAtTurn: context.currentTurn,
            turnId: context.turnId,
            source: context.source || 'story',
            sourceKeys: context.sourceKeys,
            evidence,
        });
        if (rec) created.push(rec);
    }
    return created;
}

export function maybeArchive(ledger, limits = {}) {
    const activityLimit = limits.activityLimit || ACTIVITY_SOFT_LIMIT;
    const traceLimit = limits.traceLimit || TRACE_SOFT_LIMIT;
    const archive = (key, keep) => {
        const live = ledger[key] || [];
        if (live.length <= keep) return;
        const overflow = live.length - keep;
        const taken = [];
        for (const item of live) {
            if (taken.length >= overflow) break;
            if (key === 'activities' && (item.phase === 'doing' || item.phase === 'planned') && item.status === 'active') continue;
            if (!item.committed) continue;
            taken.push(item);
        }
        if (!taken.length) return;
        const ids = new Set(taken.map(item => item.id));
        ledger[key] = live.filter(item => !ids.has(item.id));
        ledger.archived[key] = [...(ledger.archived[key] || []), ...taken];
    };
    archive('activities', activityLimit);
    archive('traces', traceLimit);
    const discoveriesLimit = limits.discoveryLimit || TRACE_SOFT_LIMIT;
    const live = ledger.discoveries || [];
    if (live.length > discoveriesLimit) {
        const overflow = live.length - discoveriesLimit;
        const taken = live.filter(item => item.committed !== false).slice(0, overflow);
        const ids = new Set(taken.map(item => item.id));
        ledger.discoveries = live.filter(item => !ids.has(item.id));
        ledger.archived.discoveries = [...(ledger.archived.discoveries || []), ...taken];
    }
    return ledger;
}

// 由时间线结算草稿生成活动与痕迹：只有确实会留下可观察物证的完成才生成痕迹；未目击不等于已经发现。
export function draftsFromSettlement(events = [], plans = [], meta = {}) {
    const activities = [];
    const traces = [];
    const placeOf = id => placeLabel(id, meta);
    for (const event of events) {
        if (!event || event.drafted === false) continue;
        const witnessed = event.knownBy?.includes('player') === true;
        const phase = event.kind === 'travel' ? 'doing' : 'done';
        const summary = text(event.summary);
        if (!summary) continue;
        const activityId = `act:${event.id || `${meta.turnId}:${activities.length}`}`;
        activities.push({
            id: activityId, npcIds: unique(event.npcIds), phase: witnessed ? 'done' : phase,
            summary, locationId: event.locationId || 'unknown', clockMinutes: event.clockMinutes,
            turnId: event.turnId || meta.turnId, source: 'settlement',
            sourceKeys: unique(meta.sourceKeys), publicCanon: witnessed || event.public === true && witnessed,
        });
        if (!witnessed) {
            const observed = describeObservableTrace({
                summary, kind: event.kind, locationId: event.locationId, phase,
            }, { ...meta, locationName: placeOf });
            if (observed) {
                traces.push({
                    id: `trace:${event.id || activityId}`, activityId, npcIds: unique(event.npcIds),
                    locationId: event.locationId || 'unknown',
                    traceType: observed.type, content: observed.content, summary: observed.summary,
                    keywords: unique([...(event.npcIds || []), event.locationId, observed.type, observed.label, ...observed.keywords]),
                    turnId: event.turnId || meta.turnId, source: 'settlement', sourceKeys: unique(meta.sourceKeys),
                });
            }
        }
    }
    for (const plan of plans) {
        if (!['active', 'blocked'].includes(plan?.status)) continue;
        const step = (plan.steps || []).find(item => item.status === 'active');
        if (!step) continue;
        const going = step.kind === 'travel';
        activities.push({
            id: `act:${plan.id}:${step.id || 'step'}`, npcIds: unique(plan.npcIds),
            phase: going || step.status === 'active' ? (going ? 'doing' : 'planned') : 'planned',
            summary: going ? `准备前往${step.targetLocationId || '别处'}，系统并未计算到达时间` : text(step.summary || plan.goal),
            locationId: step.locationId || 'unknown', turnId: meta.turnId, source: 'settlement',
            sourceKeys: unique(meta.sourceKeys), publicCanon: false,
        });
        // 计划中或尚未执行的行动，包括单纯的前往意向，默认不生成痕迹。
    }
    return { activities, traces };
}

export { allRecords };

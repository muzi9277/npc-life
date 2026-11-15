/* 确定性时间线：不访问宿主、网络、系统时间，也不直接写入 NPC 状态。 */
const copy = value => structuredClone(value);
const text = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';
const open = plan => plan.status === 'active' || plan.status === 'blocked';
const person = npc => !!npc && (npc.entityType === 'person'
    || (npc.entityType === undefined && (npc.confirmed === true || npc.tracked === true)));
// 懒加载名册：已追踪即可结算，不再把“用户确认”当成开局门槛。
const enabledNpc = npc => person(npc) && npc.tracked === true
    && !npc.archived && !npc.ignored && !npc.mergedInto
    && (npc.canonicalId === undefined || npc.canonicalId === npc.id);
const eligibleId = (rules, id) => typeof id === 'string'
    && !Object.prototype.hasOwnProperty.call(rules.entityRedirects || {}, id)
    && enabledNpc(rules.npcs?.find(npc => npc.id === id));
// 地点只作叙事软约束：有稳定 ID 即可参与情景判断，不做坐标或路线耗时计算。
const namedLocation = id => typeof id === 'string' && id.trim() && id !== 'unknown';
const catalogLocation = (rules, id) => rules.locations?.find(location => location.id === id);
const usableLocation = (rules, id) => namedLocation(id) && (catalogLocation(rules, id) || true);
// 事件参与者必须仍是有效实体；地点不再要求已确认。历史引用不借合并重定向扩大知情范围。
const validEvent = (event, rules) => Array.isArray(event?.npcIds) && event.npcIds.length > 0
    && event.npcIds.every(id => eligibleId(rules, id))
    && Array.isArray(event.knownBy) && event.knownBy.every(id => id === 'player' || eligibleId(rules, id));
// 「锁定」只表示持续保留状态，不冻结行为。闭关、囚禁等正文硬约束仍优先。
const confined = state => state.mobility === 'immobile'
    || state.activityLock?.active === true
    || ['confined', 'imprisoned', 'secluded'].includes(state.confinement?.value)
    || /闭关|囚禁|关押|监禁|禁足/.test(String(state.confinement?.evidence || state.confinement?.reason || state.activityLock?.reason || ''));
const externalTravel = state => ['in_transit', 'arrival_ready'].includes(state.travel?.status)
    || state.status === 'in_transit';
// 只接受动作名称；不将模型叙述、结果、对白或新世界事实复制为事件。
const neutralAction = value => /^(?:等待|休息|睡觉|睡眠|阅读|读书|看书|工作|学习|练习|训练|练剑|练武|冥想|散步|吃饭|用餐|喝茶|做饭|烹饪|打扫|整理|写作|写字|值守|巡逻|钓鱼|采集|种植|浇水|购物|交谈|聊天|修炼|研究|观望|休整|调查|搜寻|搜索|搜查|探查|翻找|打斗|战斗|交手)$/.test(value);

// 建立独立基线副本；sources 是已有正文基线，之后每轮只接收增量 sources。
export function createTimeline({ baseDay = 1, sources = [] } = {}) {
    if (!Number.isSafeInteger(baseDay) || baseDay < 1 || !Array.isArray(sources)) throw new TypeError('时间线基线无效');
    return { version: 1, clockMinutes: 0, baseDay, revision: 0, plans: [], turns: [], events: [],
        pending: null, sourceCursor: sources.length, baselineSources: copy(sources), pausedReason: '' };
}

// 快照仅包含引擎字段；撤回不会接触上层正文、NPC 手动修订或其他宿主状态。
function snapshot(timeline) {
    return copy({ clockMinutes: timeline.clockMinutes, plans: timeline.plans,
        events: timeline.events, sourceCursor: timeline.sourceCursor });
}

// 同行闭包必须完整，成员必须启用并处于同一地点（地点可以是 unknown，只要全员一致）。
function memberProblem(ids, rules, states) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) return '没有有效 NPC';
    const included = new Set(ids);
    for (const party of rules.parties) {
        if (party.confirmed === false) continue;
        const members = party.members || party.npcIds || [];
        if (members.some(id => included.has(id)) && members.some(id => !included.has(id))) return '同行成员不完整';
    }
    for (const id of ids) {
        if (!eligibleId(rules, id)) return 'NPC 未启用或未追踪';
        if (!states[id]) return 'NPC 缺少状态';
        if (externalTravel(states[id])) return 'NPC 正在外部行程中';
    }
    if (new Set(ids.map(id => states[id].locationId || 'unknown')).size !== 1) return '同行成员不在同一地点';
    return '';
}

// 预验证所有未完成步骤。地点未知时允许原地活动/等待。旅行只作为意向，不计算路线或到达时间。
function validatePlan(plan, rules, states) {
    const problem = memberProblem(plan.npcIds, rules, states);
    if (problem) return problem;
    const virtual = copy(states);
    for (const step of plan.steps.filter(item => item.status !== 'completed')) {
        if (!['activity', 'wait', 'travel'].includes(step.kind)) return '未知步骤类型';
        const origin = virtual[plan.npcIds[0]].locationId || 'unknown';
        if ((step.locationId || 'unknown') !== origin) return '步骤地点与当前地点不符';
        if (step.kind === 'travel') {
            if (plan.npcIds.some(id => virtual[id].scene === 'present')) return '在场 NPC 不可后台移动';
            if (plan.npcIds.some(id => confined(virtual[id]))) return '正文约束（闭关、囚禁等）优先，当前不可离开';
            if (!namedLocation(step.targetLocationId) || step.targetLocationId === origin) return '旅行目的地无效';
            if (origin === 'unknown') return '当前位置未知，先在已知范围内行动';
            // 不编写旅行耗时，也不根据路线推算抵达。后续步骤不能假定已经到达。
            step.durationMinutes = null;
            step.remainingMinutes = null;
        } else {
            if (!Number.isSafeInteger(step.durationMinutes) || step.durationMinutes < 0) return '步骤耗时必须为非负安全整数';
            if (step.kind === 'activity' && !neutralAction(step.summary)) return '活动必须是受支持的动作名称，不可包含新事实';
            if (step.kind === 'activity' && plan.npcIds.some(id => confined(virtual[id]))) return '正文约束（闭关、囚禁等）优先，当前仅可原地等待';
            if (step.kind === 'activity' && plan.npcIds.some(id => virtual[id].scene === 'present') && step.major !== false) return '在场活动必须明确标记 major:false';
        }
    }
    return '';
}

// 接收计划只挑选引擎认识的字段，不信任模型的 status、ID、剩余耗时或事件文本。
function normalizePlan(raw, turnId, index, events, rules) {
    // 保留非法成员供整组校验拒绝，不能删除坏引用后让其余成员执行。
    const npcIds = Array.isArray(raw?.npcIds) ? [...new Set(raw.npcIds)] : [];
    const id = `${turnId}:plan:${index}`;
    const validCauses = new Set(events.filter(event => validEvent(event, rules)
        && npcIds.length && npcIds.every(npcId => event.knownBy.includes(npcId))).map(event => event.id));
    const steps = Array.isArray(raw?.steps) ? raw.steps.slice(0, 3).map((step, stepIndex) => ({
        id: `${id}:step:${stepIndex}`, kind: step.kind, locationId: step.locationId,
        targetLocationId: step.kind === 'travel' ? step.targetLocationId : null,
        durationMinutes: step.kind === 'travel' ? null : step.durationMinutes,
        remainingMinutes: step.kind === 'travel' ? null : step.durationMinutes,
        summary: step.kind === 'wait' ? '等待' : step.kind === 'travel' ? '准备前往，系统未计算到达时间' : text(step.summary),
        status: 'active', ...(step.kind === 'activity' ? { major: step.major === false ? false : true } : {}),
    })) : [];
    return { id, npcIds, goal: text(raw?.goal), reason: text(raw?.reason), status: 'active', sourceTurnId: turnId,
        knownEventIds: [...new Set((Array.isArray(raw?.knownEventIds) ? raw.knownEventIds : []).filter(eventId => validCauses.has(eventId)))], steps };
}

// 生成固定模板事件。只有当时同场目击才算玩家已知/公开正史；远处完成不写成玩家已经看见。
function completionEvent(timeline, plan, step, rules, states, turnId, clockMinutes) {
    const locationId = step.kind === 'travel' ? step.targetLocationId : (step.locationId || 'unknown');
    const names = plan.npcIds.map(id => rules.npcs.find(npc => npc.id === id).name || id).join('、');
    const knownBy = [...plan.npcIds];
    const playerLoc = rules.player?.locationId;
    const witnessed = namedLocation(playerLoc) && playerLoc === locationId
        && plan.npcIds.some(id => states[id].scene === 'present' && states[id].locationId === locationId);
    if (witnessed) knownBy.push('player');
    const causeIds = (plan.knownEventIds || []).filter(id => timeline.events.some(event => event.id === id
        && validEvent(event, rules) && plan.npcIds.every(npcId => event.knownBy.includes(npcId))));
    const place = catalogLocation(rules, locationId);
    const placeLabel = place?.name || (namedLocation(locationId) ? locationId : '地点不详');
    return { id: `${turnId}:event:${timeline.events.length}`, turnId, planId: plan.id, stepId: step.id,
        kind: step.kind, npcIds: [...plan.npcIds], locationId, clockMinutes, knownBy, causeIds, public: witnessed,
        summary: step.kind === 'travel' ? `${names}有前往${placeLabel}的意向，系统未计算抵达` : `${names}完成了事先计划的${step.summary}` };
}

// 每个旧计划各自享有完整 delta；跨步骤消耗剩余分钟，只投影 locationId 与 activity。
function advancePlan(timeline, plan, delta, rules, states, projections, turnId) {
    const problem = validatePlan(plan, rules, states);
    if (problem) { plan.status = 'blocked'; plan.blockedReason = problem; return; }
    plan.status = 'active';
    delete plan.blockedReason;
    if (delta === 0) return;
    let remaining = delta;
    for (const step of plan.steps) {
        if (step.status === 'completed') continue;
        // 未定时的旅行只是意向，不靠世界时钟或虚构耗时完成，更不声称已经抵达。
        if (step.kind === 'travel' || !Number.isSafeInteger(step.remainingMinutes)) break;
        const consumed = Math.min(remaining, step.remainingMinutes);
        remaining -= consumed;
        step.remainingMinutes -= consumed;
        if (step.remainingMinutes > 0) break;
        step.status = 'completed';
        for (const npcId of plan.npcIds) {
            if (step.kind === 'travel' || step.kind === 'activity') {
                const field = step.kind === 'travel' ? 'locationId' : 'activity';
                const value = step.kind === 'travel' ? step.targetLocationId : step.summary;
                states[npcId][field] = value;
                projections.push({ npcId, field, value });
            }
        }
        timeline.events.push(completionEvent(timeline, plan, step, rules, states, turnId, timeline.clockMinutes + delta - remaining));
        if (remaining === 0) break;
    }
    if (plan.steps.every(step => step.status === 'completed')) plan.status = 'completed';
}

// 反馈由上层核验来源；取消/替换在推进前生效，证据为空则不接受反馈。
function applyFeedback(plans, feedback) {
    for (const item of feedback) {
        if (!item || !['cancel', 'replace'].includes(item.action) || !text(item.evidence)) continue;
        for (const plan of plans) {
            if (!open(plan) || !plan.npcIds.includes(item.npcId)) continue;
            plan.status = 'cancelled';
            plan.cancelReason = text(item.evidence);
            for (const step of plan.steps) if (step.status !== 'completed') step.status = 'cancelled';
        }
    }
}

// 纯函数事务：先反馈、后旧计划推进、最后接新计划；满额明确报错，绝不静默丢弃回滚依赖。
export function proposeTurn(timeline, input, rules) {
    if (!input || typeof input.id !== 'string' || !input.id.trim()) throw new TypeError('本轮必须提供确定性 id');
    if (timeline.turns.length >= 60) throw new RangeError('时间线已达 60 轮，请先由上层归档或撤回');
    if (timeline.turns.some(turn => turn.id === input.id)) throw new Error('本轮 id 已存在');
    const delta = input.deltaMinutes ?? 0;
    // 分钟与 legacyDay 共用整数时间轴；限制单轮七天，避免小数漂移与超范围推进。
    if (!Number.isSafeInteger(delta) || delta < 0 || delta > 10080
        || !Number.isSafeInteger(timeline.clockMinutes + delta)) throw new TypeError('deltaMinutes 必须为 0..10080 的整数，累计分钟必须为安全整数');
    if (!Array.isArray(input.sources ?? [])) throw new TypeError('sources 必须为本轮增量数组');
    const next = copy(timeline);
    const before = snapshot(next);
    const safeRules = { npcs: [], states: {}, locations: [], parties: [], player: {}, ...rules };
    const states = copy(safeRules.states);
    const projections = [];
    applyFeedback(next.plans, input.feedback || []);
    for (const plan of next.plans) if (open(plan)) advancePlan(next, plan, delta, safeRules, states, projections, input.id);
    next.clockMinutes += delta;
    for (const [index, raw] of (input.plans || []).entries()) {
        const plan = normalizePlan(raw, input.id, index, next.events, safeRules);
        // 即使旧计划 blocked，也不能未经反馈擅自替换同一成员的计划。
        if (next.plans.some(existing => open(existing) && existing.npcIds.some(id => plan.npcIds.includes(id)))) continue;
        const problem = !plan.steps.length ? '计划没有步骤' : validatePlan(plan, safeRules, states);
        if (problem) { plan.status = 'blocked'; plan.blockedReason = problem; }
        next.plans.push(plan);
    }
    if (next.events.length > 180) throw new RangeError('时间线已达 180 个事件，请先由上层归档或撤回');
    next.sourceCursor += (input.sources || []).length;
    next.revision++;
    next.turns.push({ id: input.id, deltaMinutes: delta, before, sources: copy(input.sources || []), projections: copy(projections) });
    return { timeline: next, projections, turnId: input.id };
}

// fromIndex 为有效 turns 的零基下标；返回被撤回记录供上层存档，宿主自行反向处理 projections。
export function undoTurns(timeline, fromIndex) {
    if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > timeline.turns.length) throw new RangeError('撤回下标无效');
    const next = copy(timeline);
    const revokedTurns = copy(next.turns.slice(fromIndex));
    if (revokedTurns.length) {
        Object.assign(next, copy(revokedTurns[0].before));
        next.turns = next.turns.slice(0, fromIndex);
        next.revision++;
    }
    return { timeline: next, revokedTurns };
}

function locationLabel(rules, id) {
    if (!namedLocation(id)) return '地点不详';
    return catalogLocation(rules, id)?.name || id;
}

function sameScene(event, rules) {
    // 只有结算当时玩家已知情的事件，才可以标成同场；后来相遇不追授目击。
    if (!event.knownBy?.includes('player')) return false;
    const playerLoc = rules.player?.locationId;
    return namedLocation(playerLoc) && event.locationId === playerLoc
        && event.npcIds.some(id => rules.states[id]?.scene === 'present' && rules.states[id]?.locationId === event.locationId);
}

const CONTEXT_HEADER = '【NPC Life 已提交的公开事实】以下仅包含上一轮及更早已提交、并且玩家已知或已是公开正史的结果。它们不是建议，也不是心理侧写。尚未写进正文的后台提案、未被发现的痕迹，不得写成玩家已经知道。玩家在正文里声称的成功或失败只是主张，不能自动覆盖这些结果。未同场的人不要写成站在玩家眼前。';

// 一轮开始前只注入已提交且玩家已知/已是公开正史的事实，不把远处后台结算冒充正史。
export function timelineContext(timeline, rules, budget = 1200) {
    if (!Number.isFinite(budget) || budget <= 0) return '';
    const limit = Math.floor(budget);
    const safeRules = { npcs: [], locations: [], states: {}, player: {}, ...rules };
    const recentTurnIds = new Set((timeline.turns || []).slice(-2).map(turn => turn.id));
    const events = (timeline.events || []).filter(event => validEvent(event, safeRules));
    const candidates = events.filter(event => event.knownBy?.includes('player') || event.public === true && event.knownBy?.includes('player'));
    if (!candidates.length) return '';
    const scored = candidates.map((event, index) => ({
        event,
        score: (sameScene(event, safeRules) ? 30 : 0) + (event.knownBy?.includes('player') ? 10 : 0)
            + (recentTurnIds.has(event.turnId) ? 8 : 0) + index,
    })).sort((a, b) => b.score - a.score);
    const usedPeople = new Set(), lines = [];
    for (const { event } of scored) {
        const newcomers = event.npcIds.filter(id => !usedPeople.has(id));
        if (usedPeople.size >= 2 && newcomers.length && !event.npcIds.some(id => usedPeople.has(id))) continue;
        event.npcIds.forEach(id => usedPeople.add(id));
        const scene = sameScene(event, safeRules) ? '同场' : '玩家可知';
        lines.push(`- [${event.clockMinutes}分钟·${scene}] ${event.summary}`);
        if (lines.length >= 6) break;
    }
    if (!lines.length) return '';
    const body = [CONTEXT_HEADER, ...lines].join('\n');
    return body.length > limit ? body.slice(0, limit) : body;
}

export { enabledNpc, eligibleId, usableLocation, namedLocation, confined };

/* beta4 确定性时间线：不访问宿主、网络、系统时间，也不直接写入 NPC 状态。 */
const copy = value => structuredClone(value);
const text = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';
const open = plan => plan.status === 'active' || plan.status === 'blocked';
const person = npc => !!npc && (npc.entityType === 'person'
    || (npc.entityType === undefined && (npc.confirmed === true || npc.tracked === true)));
const enabledNpc = npc => person(npc) && npc.tracked === true && npc.confirmed === true
    && !npc.archived && !npc.ignored && !npc.mergedInto
    && (npc.canonicalId === undefined || npc.canonicalId === npc.id);
const eligibleId = (rules, id) => typeof id === 'string'
    && !Object.prototype.hasOwnProperty.call(rules.entityRedirects || {}, id)
    && enabledNpc(rules.npcs?.find(npc => npc.id === id));
const knownLocation = (rules, id) => id && id !== 'unknown'
    && rules.locations?.some(location => location.id === id && location.confirmed === true);
// 事件参与者和知情者都必须仍是有效实体；历史引用不借合并重定向扩大知情范围。
const validEvent = (event, rules) => Array.isArray(event?.npcIds) && event.npcIds.length > 0
    && event.npcIds.every(id => eligibleId(rules, id)) && knownLocation(rules, event.locationId)
    && Array.isArray(event.knownBy) && event.knownBy.every(id => id === 'player' || eligibleId(rules, id));
const locked = state => state.locked === true || state.activityLock?.active === true || state.mobility === 'immobile';
const externalTravel = state => ['in_transit', 'arrival_ready'].includes(state.travel?.status)
    || state.status === 'in_transit';
// 只接受动作名称；不将模型叙述、结果、对白或新世界事实复制为事件。
const neutralAction = value => /^(?:等待|休息|睡觉|睡眠|阅读|读书|看书|工作|学习|练习|训练|练剑|练武|冥想|散步|吃饭|用餐|喝茶|做饭|烹饪|打扫|整理|写作|写字|值守|巡逻|钓鱼|采集|种植|浇水|购物|交谈|聊天|修炼|研究|观望|休整)$/.test(value);

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

// 同行闭包必须完整，成员必须启用、确认并处于同一已知地点。
function memberProblem(ids, rules, states) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) return '没有有效 NPC';
    const included = new Set(ids);
    for (const party of rules.parties) {
        if (party.confirmed === false) continue;
        const members = party.members || party.npcIds || [];
        if (members.some(id => included.has(id)) && members.some(id => !included.has(id))) return '同行成员不完整';
    }
    for (const id of ids) {
        if (!eligibleId(rules, id)) return 'NPC 未启用或未确认';
        if (!states[id] || !knownLocation(rules, states[id].locationId)) return 'NPC 当前地点未知';
        if (externalTravel(states[id])) return 'NPC 正在外部行程中';
    }
    if (new Set(ids.map(id => states[id].locationId)).size !== 1) return '同行成员不在同一地点';
    return '';
}

// 预验证所有未完成步骤，用虚拟地点模拟步骤衔接；失败时整个计划本轮不推进。
function validatePlan(plan, rules, states) {
    const problem = memberProblem(plan.npcIds, rules, states);
    if (problem) return problem;
    const virtual = copy(states);
    for (const step of plan.steps.filter(item => item.status !== 'completed')) {
        if (!['activity', 'wait', 'travel'].includes(step.kind)) return '未知步骤类型';
        const origin = virtual[plan.npcIds[0]].locationId;
        if (!knownLocation(rules, step.locationId) || step.locationId !== origin) return '步骤地点未确认或与当前地点不符';
        if (step.kind === 'travel') {
            if (plan.npcIds.some(id => virtual[id].scene === 'present')) return '在场 NPC 不可后台移动';
            if (plan.npcIds.some(id => locked(virtual[id]))) return 'NPC 移动已锁定';
            if (!knownLocation(rules, step.targetLocationId) || step.targetLocationId === origin) return '旅行目的地无效';
            const route = typeof rules.route === 'function' ? rules.route(origin, step.targetLocationId, [...plan.npcIds]) : null;
            if (!route || !Number.isSafeInteger(route.durationMinutes) || route.durationMinutes <= 0) return '缺少已确认路线和整数旅行耗时';
            // 首次合法验证时固定 route 已含 rate 的耗时，不能采用模型分钟数。
            if (step.durationMinutes === null) {
                step.durationMinutes = route.durationMinutes;
                step.remainingMinutes = route.durationMinutes;
            }
            for (const id of plan.npcIds) virtual[id].locationId = step.targetLocationId;
        } else {
            if (!Number.isSafeInteger(step.durationMinutes) || step.durationMinutes < 0) return '步骤耗时必须为非负安全整数';
            if (step.kind === 'activity' && !neutralAction(step.summary)) return '活动必须是受支持的动作名称，不可包含新事实';
            if (step.kind === 'activity' && plan.npcIds.some(id => locked(virtual[id]))) return '活动已锁定，仅可原地等待';
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
        summary: step.kind === 'wait' ? '等待' : step.kind === 'travel' ? '旅行' : text(step.summary),
        status: 'active', ...(step.kind === 'activity' ? { major: step.major === false ? false : true } : {}),
    })) : [];
    return { id, npcIds, goal: text(raw?.goal), reason: text(raw?.reason), status: 'active', sourceTurnId: turnId,
        knownEventIds: [...new Set((Array.isArray(raw?.knownEventIds) ? raw.knownEventIds : []).filter(eventId => validCauses.has(eventId)))], steps };
}

// 生成固定模板事件，仅参与者知情；玩家还必须与明确 present 的成员同处已确认地点。
function completionEvent(timeline, plan, step, rules, states, turnId, clockMinutes) {
    const locationId = step.kind === 'travel' ? step.targetLocationId : step.locationId;
    const names = plan.npcIds.map(id => rules.npcs.find(npc => npc.id === id).name || id).join('、');
    const knownBy = [...plan.npcIds];
    if (knownLocation(rules, rules.player.locationId) && rules.player.locationId === locationId
        && plan.npcIds.some(id => states[id].scene === 'present' && states[id].locationId === locationId)) knownBy.push('player');
    const causeIds = (plan.knownEventIds || []).filter(id => timeline.events.some(event => event.id === id
        && validEvent(event, rules) && plan.npcIds.every(npcId => event.knownBy.includes(npcId))));
    const place = rules.locations.find(location => location.id === locationId);
    return { id: `${turnId}:event:${timeline.events.length}`, turnId, planId: plan.id, stepId: step.id,
        kind: step.kind, npcIds: [...plan.npcIds], locationId, clockMinutes, knownBy, causeIds,
        summary: step.kind === 'travel' ? `${names}抵达${place.name || place.id}` : `${names}完成了事先计划的${step.summary}` };
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

// 仅向玩家提供最近三个已知且当前同场的事件模板，不包含计划、目标、理由或私密心理。
export function timelineContext(timeline, rules, budget = 1200) {
    if (!Number.isFinite(budget) || budget <= 0) return '';
    const limit = Math.floor(budget);
    const safeRules = { npcs: [], locations: [], states: {}, player: {}, ...rules };
    if (!knownLocation(safeRules, safeRules.player.locationId)) return '';
    // 整条事件可能提及多名参与者：任一成员已归档、忽略或停用，均不再注入旧结果。
    const events = timeline.events.filter(event => validEvent(event, safeRules) && event.knownBy.includes('player')
        && event.locationId === safeRules.player.locationId
        && event.npcIds.some(id => safeRules.states[id]?.scene === 'present'
            && safeRules.states[id]?.locationId === event.locationId)).slice(-3);
    let result = '';
    for (const event of events) {
        const line = `[${event.clockMinutes}分钟] ${event.summary}`;
        if ((result ? result.length + 1 : 0) + line.length > limit) continue;
        result += (result ? '\n' : '') + line;
    }
    return result;
}

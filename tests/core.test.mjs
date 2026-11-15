import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Standalone runner intentionally supports both `bun tests/core.test.mjs` and Node.
const tests = [];
const test = (name, run) => tests.push({ name, run });

// Portable seam: load the real core without ST imports or its browser bootstrap.
// Only the external generation service is replaced; state/render/save logic stays real.
const indexUrl = new URL('../index.js', import.meta.url);
const { normalizeConsolePreferences } = await import(new URL('../services.js', import.meta.url).href);
const ledgerApi = await import(new URL('../activity-ledger.js', import.meta.url).href);
const livingWorldApi = await import(new URL('../living-world.js', import.meta.url).href);
const originalSource = await readFile(indexUrl, 'utf8');
assert.match(originalSource, /jQuery\(init\);\s*$/);
assert.match(originalSource, /let consoleFeatures = null;/);
const source = originalSource
    .replace(/^import .*?;\r?\n/gm, '')
    .replace('let consoleFeatures = null;', 'let consoleFeatures = mockConsoleFeatures;')
    .replace(/jQuery\(init\);\s*$/, '');
assert.doesNotMatch(source, /^import\s/m);
const names = [
    'activeData', 'rootSettings', 'makeNpc', 'makeNpcState', 'makeLocation', 'mergeCatalog',
    'ensureCatalog', 'discoverCatalog', 'classifyNpc', 'mergeNpcIdentity', 'undoNpcMerge',
    'archiveNpc', 'restoreNpc', 'activeNpc', 'resolveEntity', 'confirmedLocation',
    'messageAnchors', 'canonFields', 'observeCanonFields', 'revokeCanonFact', 'revokeMissingCanonFacts',
    'normalizeFact', 'applyCanonFact', 'extractStoryFacts', 'addEvent', 'save', 'savePreferences',
    'findRoute', 'validateTransition', 'evaluateAppearanceRequest', 'evaluateRequestMotivation', 'confirmTravelPlan',
    'advanceTravelPlans', 'commitGameDay', 'validateSimulationEvents', 'simulateDay',
    'generateSceneGestures', 'checkIdentity', 'syncPrompt', 'setManualNpcLocation', 'openConnectionManager',
    'worldRules', 'commitWorldTurn', 'rollbackWorldTurns', 'observeWorldProjection', 'assertLegacyClock', 'syncWorldPrompt', 'lazyEnrollFromChat', 'setTracked', 'buildInjectionText', 'enrollNpc',
];
const loadCore = new Function('environment', `
    const { SillyTavern, $, jQuery, extension_prompt_types, extension_prompt_roles,
        document, window, normalizeConsolePreferences, mockConsoleFeatures, mountConsole,
        createConsoleFeatures, timelineContext, fetch, setInterval,
        normalizeLedger, appendSettlementDrafts, commitLedgerTurn, revokeLedgerTurn, revokeBySourceKeys,
        draftsFromSettlement, formatLedgerInjection, canArrangeActivity, hasSufficientProfile, isUserDesignated,
        searchDiscoverableTraces, recordOfferedOpportunities, applyStoryDiscoveries,
        buildLivingWorldInjection } = environment;
    ${source}
    return { ${names.join(', ')} };
`);
const forbidden = label => () => { throw new Error(`core tests forbid ${label}`); };
const originalFetch = globalThis.fetch;
globalThis.fetch = forbidden('network fetch');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture({ trackNpc = false, entries = [] } = {}) {
    const calls = { requests: [], saves: 0, prompts: [], timelineContexts: [] };
    const ctx = {
        extensionSettings: {}, characterId: 0, chatId: 'chat-a', name1: '沈遥', chat: [],
        characters: [
            { name: 'World A', avatar: 'world-a.png', data: { character_book: { entries: [
                { keys: ['林青'], comment: '人物', content: '林青住在北塔。' },
                { keys: ['北塔'], comment: '地点：北塔', content: '北塔是要塞。' },
                { keys: ['南门'], comment: '地点：南门', content: '南门是出口。' },
                ...entries,
            ] } } },
            { name: 'World B', avatar: 'world-b.png', data: { character_book: { entries: [
                { keys: ['林青'], comment: '人物', content: '林青居住在海港。' },
                { keys: ['海港'], comment: '地点：海港', content: '海港。' },
            ] } } },
        ],
        saveSettingsDebounced() { calls.saves++; },
        setExtensionPrompt(...args) { calls.prompts.push(args); },
        generateRaw: forbidden('real API'),
    };
    // Deliberately small jQuery chain: enough for real render() calls, no DOM/init.
    const chain = {
        text() { return this; }, val() { return this; }, prop() { return this; },
        attr() { return this; }, end() { return this; }, empty() { return this; },
        append() { return this; }, off() { return this; }, on() { return this; },
        remove() { return this; }, find() { return this; }, closest() { return this; },
        children() { return { length: 0 }; },
    };
    const $ = value => {
        if (typeof value === 'function') throw new Error('core tests must not call init');
        return chain;
    };
    let response = '{}';
    const mockConsoleFeatures = {
        relevant: () => '',
        request: async (...args) => {
            calls.requests.push(args);
            return typeof response === 'function' ? response(...args) : response;
        },
    };
    const api = loadCore({
        SillyTavern: { getContext: () => ctx }, $, jQuery: $,
        extension_prompt_types: { IN_CHAT: 'in_chat' }, extension_prompt_roles: { SYSTEM: 'system' },
        document: { querySelector: () => null },
        // Confirmation belongs to UI. Calling archive/restore directly needs none.
        window: { confirm: forbidden('core confirmation'), alert: forbidden('alert') },
        normalizeConsolePreferences, mockConsoleFeatures,
        timelineContext: (...args) => {
            calls.timelineContexts.push(args);
            return `mock world context:${args[0].turns.at(-1)?.id || 'baseline'}`;
        },
        mountConsole: forbidden('console mount'), createConsoleFeatures: forbidden('real generation service'),
        fetch: forbidden('network fetch'), setInterval: forbidden('init timer'),
        ...ledgerApi,
        ...livingWorldApi,
    });
    const data = api.activeData();
    api.activeData(); // Normalize newly created chats exactly as subsequent host reads do.
    const store = api.rootSettings();
    store.preferences.autoMode = 'notes';
    const npc = data.world.catalog.npcs.find(item => item.name === '林青');
    const north = data.world.catalog.locations.find(item => item.name === '北塔');
    const south = data.world.catalog.locations.find(item => item.name === '南门');
    assert.ok(npc && north && south, 'real card discovery should seed the fixture');
    npc.confirmed = true;
    // Discovery is deliberately untracked. Generation tests opt into tracking explicitly.
    if (trackNpc) npc.tracked = true;
    north.confirmed = south.confirmed = true;
    const friend = api.makeNpc('顾宁', 'manual');
    data.world.catalog.npcs.push(friend);
    data.chat.npcStates[friend.id] = api.makeNpcState(friend.id);
    for (const state of Object.values(data.chat.npcStates)) Object.assign(state, {
        locationId: north.id, activity: '原活动', scene: 'away', source: 'story',
        updatedDay: 0, updatedAt: 1, mobility: 'free', travelRate: 1,
    });
    return { api, ctx, calls, ...data, npc, friend, north, south,
        respond(value) { response = typeof value === 'function' ? value : JSON.stringify(value); },
    };
}

const mixedIdentityEntry = {
    keys: ['林舟', '室友', '夜莺商会'], comment: '人物',
    content: '姓名：林舟。林舟是一名医生。室友是人物关系称呼，未注明具体姓名。夜莺商会是一个组织。',
};
const identityCard = entries => ({ data: { character_book: { entries } } });
const emptyIdentityWorld = () => ({ catalog: { npcs: [], locations: [], routes: [] }, chats: {} });

test('identity discovery classifies each key in a person section as person, organization or unknown', () => {
    const f = fixture();
    const discovered = f.api.discoverCatalog(identityCard([mixedIdentityEntry]));
    assert.deepEqual(discovered.npcs.map(item => [item.name, item.entityType]), [['林舟', 'person']]);
    assert.deepEqual(discovered.organizations.map(item => [item.name, item.entityType]), [['夜莺商会', 'organization']]);
    assert.deepEqual(discovered.identityCandidates.map(item => [item.name, item.entityType]), [['室友', 'unknown']]);
    assert.equal(discovered.npcs[0].tracked, false);
    assert.equal(discovered.npcs[0].confirmed, false);
    const world = emptyIdentityWorld();
    f.api.mergeCatalog(world, discovered);
    assert.equal(f.api.resolveEntity(world, '林舟', 'npc').id, discovered.npcs[0].id);
    for (const entity of [...world.catalog.organizations, ...world.catalog.identityCandidates]) {
        assert.equal(f.api.activeNpc(entity), false);
        assert.equal(f.api.activeNpc({ ...entity, tracked: true, confirmed: true }), false);
        assert.equal(f.api.resolveEntity(world, entity.name, 'npc'), null);
        assert.equal(f.api.resolveEntity(world, entity.id, 'npc'), null);
    }
});

test('identity discovery creates one canonical person for an explicit same-entry alias', () => {
    const f = fixture(), world = emptyIdentityWorld();
    const discovered = f.api.discoverCatalog(identityCard([{
        keys: ['林舟', '舟影'], comment: '人物', content: '姓名：林舟。林舟又名舟影。林舟是一名医生。',
    }]));
    assert.equal(discovered.npcs.length, 1);
    assert.deepEqual(new Set([discovered.npcs[0].name, ...discovered.npcs[0].aliases]), new Set(['林舟', '舟影']));
    assert.equal(discovered.organizations.length, 0);
    assert.equal(discovered.identityCandidates.length, 0);
    f.api.mergeCatalog(world, discovered);
    const canonical = world.catalog.npcs[0];
    assert.equal(f.api.resolveEntity(world, '林舟', 'npc'), canonical);
    assert.equal(f.api.resolveEntity(world, '舟影', 'npc'), canonical);
});

test('identity discovery keeps two real characters distinct despite same-world co-occurrence', () => {
    const f = fixture(), world = emptyIdentityWorld();
    f.api.mergeCatalog(world, f.api.discoverCatalog(identityCard([
        { keys: ['林舟'], comment: '人物', content: '姓名：林舟。林舟是一名医生，认识顾宁。' },
        { keys: ['顾宁'], comment: '人物', content: '姓名：顾宁。顾宁是一名老师，认识林舟。' },
    ])));
    assert.equal(world.catalog.npcs.length, 2);
    const lin = f.api.resolveEntity(world, '林舟', 'npc'), gu = f.api.resolveEntity(world, '顾宁', 'npc');
    assert.ok(lin && gu);
    assert.notEqual(lin.id, gu.id);
    assert.deepEqual(lin.aliases, []);
    assert.deepEqual(gu.aliases, []);
    assert.equal(lin.mergedInto, undefined);
    assert.equal(gu.mergedInto, undefined);
    assert.equal(world.catalog.identityMerges.length, 0);
});

test('explicit alias across separate entries joins the existing stable ID and remains idempotent', () => {
    const f = fixture(), world = emptyIdentityWorld();
    const original = { keys: ['舟影'], comment: '人物', content: '姓名：舟影。舟影是一名医生。' };
    f.api.mergeCatalog(world, f.api.discoverCatalog(identityCard([original])));
    const stableId = world.catalog.npcs[0].id;
    const entries = [original, {
        keys: ['林舟'], comment: '人物', content: '姓名：林舟。林舟又名舟影。林舟是一名医生。',
    }];
    f.api.mergeCatalog(world, f.api.discoverCatalog(identityCard(entries)));
    assert.equal(world.catalog.npcs.length, 1, 'unambiguous explicit alias must not create a second canonical person');
    assert.equal(world.catalog.npcs[0].id, stableId, 'new display-name evidence cannot replace the original stable ID');
    assert.equal(f.api.resolveEntity(world, '林舟', 'npc').id, stableId);
    assert.equal(f.api.resolveEntity(world, '舟影', 'npc').id, stableId);
    const before = structuredClone(world.catalog);
    f.api.mergeCatalog(world, f.api.discoverCatalog(identityCard(entries)));
    assert.deepEqual(world.catalog, before, 'repeated real discovery and merge cannot add identities or audit records');
});

test('cross-entry alias evidence for existing characters proposes review before explicit stable-ID merge', () => {
    const entries = [
        { keys: ['林舟'], comment: '人物', content: '姓名：林舟。林舟是一名医生。' },
        { keys: ['舟影'], comment: '人物', content: '姓名：舟影。舟影是一名老师。' },
    ];
    const f = fixture({ entries });
    const lin = f.api.resolveEntity(f.world, '林舟', 'npc'), shadow = f.api.resolveEntity(f.world, '舟影', 'npc');
    assert.ok(lin && shadow);
    assert.notEqual(lin.id, shadow.id);
    f.chat.npcStates[lin.id].activity = '独立医生状态';
    f.chat.npcStates[shadow.id].activity = '独立老师状态';
    f.chat.events.push({ id: 'existing-identity-history', npcIds: [shadow.id], summary: '旧身份历史' });
    const states = structuredClone(f.chat.npcStates), history = identityHistory(f.chat);
    f.ctx.characters[0].data.character_book.entries.push({
        keys: ['林舟'], comment: '人物', content: '姓名：林舟。林舟又名舟影。',
    });
    f.api.ensureCatalog(f.world, true);
    assert.equal(f.api.resolveEntity(f.world, '林舟', 'npc').id, lin.id);
    assert.equal(f.api.resolveEntity(f.world, '舟影', 'npc').id, shadow.id);
    assert.equal(lin.mergedInto, undefined);
    assert.equal(shadow.mergedInto, undefined);
    assert.deepEqual(f.chat.npcStates, states);
    assert.deepEqual(identityHistory(f.chat), history);
    const proposal = f.world.catalog.identityCandidates.find(item => item.requiresReview
        && item.sourceNpcIds?.includes(lin.id) && item.sourceNpcIds?.includes(shadow.id));
    assert.ok(proposal, 'explicit cross-entry evidence should offer review for two preexisting stable identities');
    assert.deepEqual(new Set(proposal.sourceNpcIds), new Set([lin.id, shadow.id]));
    assert.deepEqual(new Set(proposal.targetNpcIds), new Set([lin.id, shadow.id]));
    const record = f.api.mergeNpcIdentity(shadow.id, lin.id, '用户审核了跨条目的明确别名证据');
    assert.equal(record.fromId, shadow.id);
    assert.equal(record.toId, lin.id);
    assert.equal(f.api.resolveEntity(f.world, '舟影', 'npc').id, lin.id);
    assert.equal(f.world.catalog.npcs.find(item => item.id === shadow.id).mergedInto, lin.id);
    assert.deepEqual(f.chat.npcStates, states);
    assert.deepEqual(identityHistory(f.chat), history);
});

test('real card rescans preserve manual tracked contacts, calibrated identity and dynamic states', () => {
    const f = fixture({ entries: [mixedIdentityEntry] });
    const discovered = f.world.catalog.npcs.find(item => item.name === '林舟');
    assert.equal(discovered.tracked, false);
    assert.equal(f.npc.tracked, false, 'ordinary discovery fixture must not opt into simulation');
    assert.equal(f.friend.tracked, true, 'manual makeNpc retains its tracking default');
    assert.equal(f.api.makeNpc('旧联系人', 'legacy').tracked, true);
    f.friend.aliases = ['小宁'];
    f.npc.tracked = true; // This contact has been explicitly selected by the user.
    f.npc.aliases = ['青先生'];
    const snapshot = () => {
        const catalog = structuredClone(f.world.catalog);
        delete catalog.scannedAt;
        return { catalog, states: structuredClone(f.chat.npcStates) };
    };
    const before = snapshot();
    for (let pass = 0; pass < 3; pass++) {
        assert.equal(f.api.ensureCatalog(f.world, true), true);
        f.api.activeData();
        assert.deepEqual(snapshot(), before);
        assert.equal(f.api.resolveEntity(f.world, '小宁', 'npc').id, f.friend.id);
        assert.equal(f.api.resolveEntity(f.world, '青先生', 'npc').id, f.npc.id);
    }
});

test('explicit classification enables only people; organization and unknown never become active NPCs', () => {
    const f = fixture({ entries: [mixedIdentityEntry] });
    const candidate = f.world.catalog.identityCandidates.find(item => item.name === '室友');
    const organization = f.world.catalog.organizations.find(item => item.name === '夜莺商会');
    assert.ok(candidate && organization);
    assert.equal(f.chat.npcStates[candidate.id], undefined);
    assert.equal(f.chat.npcStates[organization.id], undefined);
    f.api.classifyNpc(candidate.id, 'person');
    const person = f.api.resolveEntity(f.world, '室友', 'npc');
    assert.ok(person);
    assert.equal(person.entityType, 'person');
    assert.equal(person.tracked, true);
    assert.equal(person.confirmed, true);
    assert.equal(f.world.catalog.identityCandidates.some(item => item.id === candidate.id), false);
    f.api.activeData();
    const state = structuredClone(f.chat.npcStates[person.id]);
    f.api.classifyNpc(person.id, 'organization');
    assert.equal(f.api.activeNpc(person), false);
    assert.equal(person.tracked, false);
    assert.equal(f.api.resolveEntity(f.world, '室友', 'npc'), null);
    assert.deepEqual(f.chat.npcStates[person.id], state, 'classification retains existing state for review');
    f.api.classifyNpc(person.id, 'unknown');
    assert.equal(f.api.activeNpc(person), false);
    assert.equal(person.confirmed, false);
    assert.equal(f.api.resolveEntity(f.world, person.id, 'npc'), null);
    assert.deepEqual(f.chat.npcStates[person.id], state);
    assert.throws(() => f.api.mergeNpcIdentity(person.id, f.npc.id), /人物|活跃/);
    assert.equal(f.world.catalog.identityMerges.length, 0, 'unknown identity cannot be merged as an active person');
    assert.throws(() => f.api.classifyNpc(person.id, 'location'), /分类/);
});

const identityHistory = chat => structuredClone({
    events: chat.events, diaries: chat.diaries, conversations: chat.conversations,
    parties: chat.parties, factLedger: chat.factLedger, pendingFacts: chat.pendingFacts,
    canonFacts: chat.canonFacts, travelPlans: chat.travelPlans, appearanceRequests: chat.appearanceRequests,
    turns: chat.timeline?.turns,
});

test('identity merge conflicts pause each chat without migrating states/history; undo restores contact and keeps history', () => {
    const f = fixture();
    f.ctx.chatId = 'identity-peer';
    const peer = f.api.activeData().chat;
    f.api.activeData();
    f.ctx.chatId = 'chat-a';
    f.store.preferences.autoMode = 'world';
    f.npc.aliases = ['青先生'];
    f.friend.aliases = ['小宁'];
    for (const chat of [f.chat, peer]) {
        Object.assign(chat.npcStates[f.npc.id], { locationId: f.north.id, activity: '目标活动', source: 'manual' });
        Object.assign(chat.npcStates[f.friend.id], { locationId: f.south.id, activity: '来源活动', source: 'canon' });
        chat.events.push({ id: `history:${chat.id}`, npcIds: [f.friend.id], participants: [f.friend.id], summary: '来源人物旧事件' });
        chat.diaries.push({ id: 'diary', npcId: f.friend.id, text: '来源人物旧日记' });
        chat.conversations[f.friend.id] = [{ role: 'assistant', content: '来源人物旧试聊' }];
        chat.parties.push({ id: 'party', members: [f.npc.id, f.friend.id], locationId: f.north.id });
        chat.factLedger.push({ id: 'identity-fact', subjects: [f.friend.id], status: 'active', authority: 'canon' });
        chat.pendingFacts.push({ id: 'identity-proposal', subjects: [f.friend.id] });
        chat.canonFacts.push({ id: 'identity-fact', subjects: [f.friend.id], valid: true });
        chat.travelPlans.push({ id: 'old-trip', npcIds: [f.friend.id], status: 'in_transit', targetLocationId: f.south.id });
        chat.appearanceRequests.push({ id: 'old-request', npcId: f.friend.id, status: 'needs_info' });
        chat.timeline = { baseDay: 1, clockMinutes: 0, turns: [{ id: 'old-turn', events: [{ npcIds: [f.friend.id], summary: '旧事务' }] }] };
    }
    f.api.activeData();
    const snapshots = [f.chat, peer].map(chat => ({ states: structuredClone(chat.npcStates), history: identityHistory(chat) }));
    const targetAliases = structuredClone(f.npc.aliases);
    const record = f.api.mergeNpcIdentity(f.friend.id, f.npc.id, '玩家明确确认二者是同一人');
    assert.equal(record.fromId, f.friend.id);
    assert.equal(record.toId, f.npc.id);
    assert.equal(record.status, 'active');
    assert.equal(record.conflicts.length, 2);
    assert.equal(f.friend.mergedInto, f.npc.id);
    assert.equal(f.api.activeNpc(f.friend), false);
    assert.equal(f.friend.tracked, false);
    assert.equal(f.api.resolveEntity(f.world, '顾宁', 'npc').id, f.npc.id);
    assert.equal(f.api.resolveEntity(f.world, '小宁', 'npc').id, f.npc.id);
    for (const [index, chat] of [f.chat, peer].entries()) {
        assert.deepEqual(chat.npcStates, snapshots[index].states, 'merge must preserve both complete states');
        assert.deepEqual(identityHistory(chat), snapshots[index].history, 'merge must not rewrite historical entity references');
        assert.match(chat.timeline.pausedReason, /合并|核对/);
        const review = chat.entityMergeReviews.find(item => item.fromId === f.friend.id && item.toId === f.npc.id);
        assert.ok(review);
        assert.equal(review.status, 'review');
        assert.ok(review.fields.includes('locationId'));
        assert.ok(review.fields.includes('activity'));
    }
    assert.equal(f.calls.prompts.at(-1)[1], '', 'conflicting identity merge clears world injection');
    f.chat.events.push({ id: 'during-merge', npcIds: [f.npc.id], summary: '合并期间的新历史' });
    const mergedHistory = [f.chat, peer].map(identityHistory);
    assert.equal(f.api.undoNpcMerge(record.id), true);
    assert.equal(record.status, 'undone');
    assert.equal(f.friend.mergedInto, undefined);
    assert.equal(f.api.activeNpc(f.friend), true);
    assert.equal(f.friend.tracked, true);
    assert.equal(f.api.resolveEntity(f.world, '顾宁', 'npc').id, f.friend.id, 'restored name resolves its own contact even when target appears first');
    assert.equal(f.api.resolveEntity(f.world, '小宁', 'npc').id, f.friend.id);
    assert.deepEqual(f.npc.aliases, targetAliases, 'undo removes only aliases introduced by this merge');
    for (const [index, chat] of [f.chat, peer].entries()) {
        assert.deepEqual(chat.npcStates, snapshots[index].states);
        assert.deepEqual(identityHistory(chat), mergedHistory[index], 'undo retains old and newly created history');
        assert.match(chat.timeline.pausedReason, /核对|基线/);
    }
    assert.throws(() => f.api.undoNpcMerge(record.id), /找不到|撤销/);
});

const field = (...path) => JSON.stringify(path);
const eventFor = (f, overrides = {}) => ({ npcIds: [f.npc.id], participants: [f.npc.id],
    locationId: f.north.id, kind: 'life', summary: '林青沿着北塔的回廊检查了昨夜留下的脚印。', ...overrides });
function route(f, days = 3) {
    const result = { id: 'route:north-south', fromId: f.north.id, toId: f.south.id, durationDays: days, confirmed: true };
    f.world.catalog.routes.push(result);
    return result;
}
function canon(f, overrides = {}, evidence = '林青正在北塔读书。') {
    f.ctx.chat.push({ is_user: true, mes: evidence });
    const fact = f.api.normalizeFact(f.world, {
        type: 'activity', subjects: [f.npc.id], activity: '读书', summary: evidence,
        evidence, direct: true, confidence: 1, ...overrides,
    }, `fingerprint:${f.ctx.chat.length}`);
    assert.equal(fact.authority, 'claim');
    fact.authority = 'canon';
    return fact;
}
function applyCanon(f, fact) {
    assert.equal(f.api.applyCanonFact(f.world, f.chat, fact), true);
    fact.status = 'active';
    // Keep the SAME object: patches are recorded by applyCanonFact on this fact.
    f.chat.factLedger.push(fact);
    return fact;
}

for (const ignored of [false, true]) test(`archive/restore: ignored=${ignored}, pause complete groups across this world's chats and retain history`, () => {
    const f = fixture();
    f.ctx.chatId = 'chat-peer';
    const peer = f.api.activeData().chat;
    f.api.activeData();
    f.ctx.characterId = 1;
    const otherWorld = f.api.activeData().world;
    f.api.activeData(); // Finish lazy normalization before taking isolation snapshot.
    const otherBefore = structuredClone(otherWorld);
    f.ctx.characterId = 0; f.ctx.chatId = 'chat-a';
    for (const chat of [f.chat, peer]) {
        chat.events.push({ id: 'history', summary: '历史事件', npcIds: [f.npc.id] });
        chat.diaries.push({ id: 'diary', npcId: f.npc.id, text: '旧日记' });
        chat.conversations[f.npc.id] = [{ role: 'assistant', content: '旧试聊' }];
        chat.parties.push({ id: 'party', members: [f.npc.id, f.friend.id], locationId: f.north.id });
        chat.travelPlans.push(
            { id: 'group', npcIds: [f.npc.id, f.friend.id], status: 'in_transit', targetLocationId: f.south.id },
            { id: 'ready', npcIds: [f.npc.id], status: 'arrival_ready', targetLocationId: f.south.id },
            { id: 'finished', npcIds: [f.npc.id], status: 'scene_confirmed', targetLocationId: f.north.id },
            { id: 'unrelated', npcIds: [f.friend.id], status: 'in_transit', targetLocationId: f.south.id },
        );
        for (const id of [f.npc.id, f.friend.id]) chat.npcStates[id].travel = { status: 'in_transit' };
        chat.appearanceRequests.push({ id: 'request', npcId: f.npc.id }, { id: 'other', npcId: f.friend.id });
    }
    const history = [f.chat, peer].map(chat => structuredClone({
        events: chat.events, diaries: chat.diaries, conversations: chat.conversations, parties: chat.parties,
    }));
    f.api.archiveNpc(f.npc.id, ignored);
    assert.equal(f.npc.archived, true);
    assert.equal(f.npc.ignored, ignored);
    assert.ok(f.npc.archivedAt > 0);
    assert.equal(f.api.resolveEntity(f.world, f.npc.name, 'npc'), null);
    assert.equal(f.calls.prompts.at(-1)[1], '');
    for (const [index, chat] of [f.chat, peer].entries()) {
        assert.deepEqual(chat.travelPlans.map(item => item.status), ['paused_archive', 'paused_archive', 'scene_confirmed', 'in_transit']);
        assert.equal(chat.npcStates[f.friend.id].travel.status, 'paused_archive', 'whole travelling group pauses');
        assert.equal(chat.appearanceRequests[0].archived, true);
        assert.equal(chat.appearanceRequests[1].archived, undefined);
        assert.deepEqual({ events: chat.events, diaries: chat.diaries, conversations: chat.conversations, parties: chat.parties }, history[index]);
    }
    f.api.restoreNpc(f.npc.id);
    assert.equal(f.api.activeNpc(f.npc), true);
    for (const chat of [f.chat, peer]) {
        assert.equal(chat.travelPlans[0].status, 'paused_archive', 'restore must not resume a trip');
        assert.equal(chat.appearanceRequests[0].archived, false);
    }
    assert.deepEqual(otherWorld, otherBefore);
    assert.throws(() => f.api.archiveNpc('npc:absent'), /找不到/);
    assert.throws(() => f.api.restoreNpc('npc:absent'), /找不到/);
});

test('archiving an arrived group pauses it; advance cannot reactivate it before or after restore', () => {
    const f = fixture();
    f.chat.player.locationId = f.south.id;
    const plan = { id: 'already-arrived', npcIds: [f.npc.id, f.friend.id], status: 'arrived',
        targetLocationId: f.south.id, confirmedDay: 1, sceneConfirmed: false };
    f.chat.travelPlans.push(plan);
    f.api.archiveNpc(f.npc.id);
    assert.equal(plan.status, 'paused_archive');
    const before = structuredClone(f.chat.npcStates);
    assert.deepEqual(f.api.advanceTravelPlans(f.world, f.chat), []);
    assert.equal(plan.status, 'paused_archive', 'matching player destination must not reactivate archived arrivals');
    f.api.restoreNpc(f.npc.id);
    assert.deepEqual(f.api.advanceTravelPlans(f.world, f.chat), []);
    assert.equal(plan.status, 'paused_archive', 'restore still requires explicit travel handling');
    assert.deepEqual(f.chat.npcStates, before);
    // Imported/stale arrived plans must also be protected even without archiveNpc having paused them.
    f.npc.ignored = true; plan.status = 'arrived';
    assert.deepEqual(f.api.advanceTravelPlans(f.world, f.chat), []);
    assert.equal(plan.status, 'paused_archive');
});

test('motivation rejects archived NPC/request before any generation and preserves request/state', async () => {
    for (const mode of ['archive', 'ignored', 'archived-request']) {
        const f = fixture(); route(f);
        const request = { id: 'motivation-request', type: 'appearance_request', npcId: f.npc.id,
            targetLocationId: f.south.id, status: 'travel_required', sourceText: '希望林青来南门。',
            result: { status: 'travel_required', earliestDay: 4 } };
        f.chat.appearanceRequests.push(request);
        if (mode === 'archive') f.api.archiveNpc(f.npc.id);
        if (mode === 'ignored') f.npc.ignored = true;
        if (mode === 'archived-request') request.archived = true;
        f.respond(() => { throw new Error('archived motivation must never reach generation'); });
        const before = structuredClone(f.chat), saves = f.calls.saves;
        await assert.rejects(f.api.evaluateRequestMotivation(request.id), /删除或忽略/);
        assert.equal(f.calls.requests.length, 0, `${mode}: no API/service call`);
        assert.deepEqual(f.chat, before, `${mode}: no request or state mutation`);
        assert.equal(f.calls.saves, saves, `${mode}: no save`);
    }
});

test('mergeCatalog/rescan: tombstones, aliases, manual calibration and absent map_import locations survive', () => {
    const f = fixture();
    f.npc.archived = true; f.npc.ignored = true; f.npc.aliases = ['青先生'];
    const imported = { ...f.api.makeLocation('地图码头', 'map_import', true), tags: ['港口'], x: 12, y: 34 };
    f.world.catalog.locations.push(imported);
    f.north.name = '校准北塔'; f.north.tags = ['自定义'];
    const beforeRoutes = structuredClone(f.world.catalog.routes);
    f.api.mergeCatalog(f.world, {
        npcs: [f.api.makeNpc('林青'), { ...f.api.makeNpc('青先生'), id: 'npc:alias-rediscovered' }],
        locations: [f.api.makeLocation('北塔')],
    });
    const tombstone = f.world.catalog.npcs.find(item => item.id === f.npc.id);
    assert.equal(tombstone.archived, true); assert.equal(tombstone.ignored, true);
    assert.equal(f.world.catalog.npcs.some(item => item.id === 'npc:alias-rediscovered'), false);
    assert.ok(f.world.catalog.npcs.some(item => item.id === f.friend.id), 'absent manual NPC retained');
    assert.deepEqual(f.world.catalog.locations.find(item => item.id === imported.id), imported);
    assert.equal(f.world.catalog.locations.find(item => item.id === f.north.id).name, '校准北塔');
    assert.deepEqual(f.world.catalog.routes, beforeRoutes);
    f.api.ensureCatalog(f.world, true);
    assert.equal(f.world.catalog.npcs.find(item => item.id === f.npc.id).archived, true);
    assert.deepEqual(f.world.catalog.locations.find(item => item.id === imported.id), imported);
});

test('card/chat isolation: same NPC name never shares world catalog or dynamic chat state', () => {
    const f = fixture();
    f.chat.day = 9; f.chat.npcStates[f.npc.id].activity = 'A 独立状态';
    const before = structuredClone(f.chat);
    f.ctx.chatId = 'chat-b';
    const peer = f.api.activeData();
    assert.notEqual(peer.chat, f.chat); assert.equal(peer.world, f.world);
    assert.equal(peer.chat.day, 1);
    assert.notEqual(peer.chat.npcStates[f.npc.id], f.chat.npcStates[f.npc.id]);
    f.ctx.characterId = 1;
    const b = f.api.activeData();
    assert.notEqual(b.wid, f.wid); assert.notEqual(b.world, f.world);
    assert.ok(b.world.catalog.npcs.some(item => item.id === f.npc.id));
    assert.equal(b.world.catalog.locations.some(item => item.id === f.north.id), false);
    f.api.archiveNpc(f.npc.id);
    assert.equal(f.npc.archived, undefined, 'world B archive cannot archive world A');
    assert.deepEqual(f.chat, before);
    f.ctx.characterId = 0; f.ctx.chatId = 'chat-a';
    assert.equal(f.api.activeData().chat, f.chat);
    f.api.checkIdentity();
    assert.equal(f.calls.prompts.at(-1)[1], '');
});

test('canonFields/observeCanonFields: independent clones and stable party ID paths track changes, removal and ABA saves', () => {
    const f = fixture();
    f.chat.parties = [{ id: 'p:a', members: [f.npc.id], locationId: f.north.id }, { id: 'p:b', members: [f.friend.id] }];
    const fields = f.api.observeCanonFields(f.chat);
    const activityPath = field('npcStates', f.npc.id, 'activity');
    const partyPath = field('party', 'p:a');
    assert.equal(fields[activityPath], '原活动');
    assert.equal(fields[field('player', 'locationId')], 'unknown');
    assert.equal(fields[field('day')], 1);
    fields[partyPath].members.push('external');
    assert.deepEqual(f.chat.parties[0].members, [f.npc.id], 'snapshots cannot mutate live arrays');
    const initialVersion = f.chat.canonFieldVersions[activityPath];
    f.chat.parties.reverse();
    const partyVersion = f.chat.canonFieldVersions[partyPath];
    f.api.observeCanonFields(f.chat);
    assert.equal(f.chat.canonFieldVersions[partyPath], partyVersion, 'reordering is not a party edit');
    f.chat.npcStates[f.npc.id].activity = 'B'; f.api.save();
    f.chat.npcStates[f.npc.id].activity = '原活动'; f.api.save();
    assert.equal(f.chat.canonFieldVersions[activityPath], initialVersion + 2);
    f.chat.parties = f.chat.parties.filter(item => item.id !== 'p:a');
    f.api.observeCanonFields(f.chat);
    assert.equal(f.chat.canonFieldVersions[partyPath], partyVersion + 1);
    assert.equal(Object.hasOwn(f.api.canonFields(f.chat), partyPath), false);
});

test('applyCanonFact records changed-field patches/versions and addEvent preserves derivedFrom', () => {
    const f = fixture();
    const before = f.api.canonFields(f.chat);
    const fact = applyCanon(f, canon(f));
    assert.ok(fact.patches.length > 0);
    const after = f.api.canonFields(f.chat);
    const changed = Object.keys(after).filter(path => JSON.stringify(before[path]) !== JSON.stringify(after[path]));
    assert.deepEqual(fact.patches.map(patch => patch.path).sort(), changed.sort());
    for (const patch of fact.patches) {
        assert.deepEqual(patch.before, before[patch.path]); assert.deepEqual(patch.after, after[patch.path]);
        assert.equal(patch.beforeExists, Object.hasOwn(before, patch.path));
        assert.equal(patch.afterExists, Object.hasOwn(after, patch.path));
        assert.equal(patch.version, f.chat.canonFieldVersions[patch.path]);
    }
    assert.equal(f.chat.events.at(-1).derivedFrom, fact.id);
    assert.equal(f.api.applyCanonFact(f.world, f.chat, fact), false, 'same canon is idempotent');
    f.api.addEvent(f.chat, { summary: '外部派生事件', derivedFrom: 'fact:external', npcIds: [f.npc.id, f.npc.id] });
    assert.equal(f.chat.events.at(-1).derivedFrom, 'fact:external');
    assert.deepEqual(f.chat.events.at(-1).npcIds, [f.npc.id]);
});

test('revokeCanonFact restores owned fields and removes only its own derived events', () => {
    const f = fixture();
    const before = structuredClone(f.chat.npcStates[f.npc.id]);
    const fact = applyCanon(f, canon(f));
    f.api.addEvent(f.chat, { summary: '独立历史', derivedFrom: 'fact:other' });
    f.chat.injection = { ids: ['stale'], rounds: 1 };
    f.api.revokeCanonFact(f.chat, fact);
    assert.equal(fact.status, 'revoked');
    assert.deepEqual(f.chat.npcStates[f.npc.id], before);
    assert.equal(f.chat.canonFacts.find(item => item.id === fact.id).valid, false);
    assert.deepEqual(f.chat.events.map(item => item.derivedFrom), ['fact:other']);
    assert.deepEqual(f.chat.injection, { ids: [], rounds: 0 });
});

test('save observes manual B/ABA after canon A; revoking A keeps the later saved value and marks review', () => {
    const f = fixture();
    const fact = applyCanon(f, canon(f));
    const path = field('npcStates', f.npc.id, 'activity');
    const patch = fact.patches.find(item => item.path === path);
    f.chat.npcStates[f.npc.id].activity = '手动 B'; f.api.save();
    f.chat.npcStates[f.npc.id].activity = patch.after; f.api.save();
    assert.ok(f.chat.canonFieldVersions[path] > patch.version);
    f.ctx.chat = [];
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), true);
    assert.equal(f.chat.npcStates[f.npc.id].activity, patch.after, 'ABA value has a new owner, cannot roll back');
    assert.equal(fact.status, 'revoked_review');
    assert.match(fact.reviewReason, /保留|校准/);
});

test('manual confirmation of the same canon destination survives source deletion with the whole manual NPC state intact', () => {
    const f = fixture(), state = f.chat.npcStates[f.npc.id];
    assert.equal(state.locationId, f.north.id);
    const fact = applyCanon(f, canon(f, { type: 'position', location: f.south.id }, '林青已经在南门。'));
    assert.equal(state.locationId, f.south.id);
    assert.equal(state.source, 'canon');
    f.api.setManualNpcLocation(f.npc.id, f.south.id);
    assert.equal(state.locationId, f.south.id);
    assert.equal(state.source, 'manual');
    const manualState = structuredClone(state);
    f.ctx.chat = [];
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), true);
    assert.equal(fact.status, 'revoked_review');
    assert.equal(state.locationId, f.south.id);
    assert.equal(state.source, 'manual');
    assert.deepEqual(state, manualState, 'same-value manual confirmation owns the complete NPC state');
    assert.equal(f.chat.events.some(event => event.derivedFrom === fact.id), false);
});

test('repeated canon escape owns cleared card confinement fields so revoking A cannot imprison active B again', () => {
    const f = fixture(), state = f.chat.npcStates[f.npc.id];
    Object.assign(state, { locationId: f.north.id, scene: 'away', locked: true, mobility: 'immobile',
        activityLock: { active: true, kind: 'prison', source: 'card', reason: '北塔监狱' },
        confinement: { value: 'confined', source: 'card', evidence: '初始囚禁' } });
    const a = applyCanon(f, canon(f, { type: 'status', object: 'escaped', activity: '已经逃出监狱' }, '我带林青逃出监狱了。'));
    assert.equal(state.locationId, 'unknown');
    assert.equal(state.activityLock, null); assert.equal(state.locked, false); assert.equal(state.mobility, 'free');
    const b = applyCanon(f, canon(f, { type: 'status', object: 'escaped', activity: '已经逃出监狱' }, '林青已经逃出监狱，正在城外休息。'));
    const bState = structuredClone(state);
    for (const key of ['locationId', 'scene', 'activityLock', 'locked', 'mobility']) {
        const path = field('npcStates', f.npc.id, key);
        const patch = b.patches.find(item => item.path === path);
        assert.ok(patch, `B retains ownership of cleared ${key}`);
        assert.equal(patch.beforeOwner, a.id);
        assert.deepEqual(patch.before, patch.after, `${key} was already cleared by A`);
    }
    f.ctx.chat.shift();
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), true);
    assert.equal(a.status, 'revoked_review'); assert.equal(b.status, 'active');
    assert.deepEqual(state, bState, 'valid B keeps every escape result after A is revoked');
    assert.equal(state.confinement.value, 'escaped'); assert.equal(state.locationId, 'unknown');
    assert.equal(state.activityLock, null); assert.equal(state.locked, false); assert.equal(state.mobility, 'free');
    assert.equal(f.chat.events.some(event => event.derivedFrom === a.id), false);
    assert.equal(f.chat.events.some(event => event.derivedFrom === b.id), true);
});

test('revokeMissingCanonFacts preserves manual B, active canon B, unrelated party/day/player/history instead of restoring baseline', () => {
    const f = fixture();
    const a = applyCanon(f, canon(f, { type: 'position', location: f.south.id }, '林青已经在南门。'));
    f.chat.npcStates[f.npc.id].locationId = f.north.id;
    f.chat.npcStates[f.npc.id].relationship = { value: 'friend', note: '手动 B', source: 'manual' };
    f.chat.day = 12; f.chat.player.locationId = f.south.id;
    f.chat.parties.push({ id: 'manual-party', members: [f.friend.id], source: 'manual', locationId: f.north.id });
    f.chat.diaries.push({ id: 'diary', text: '保留日记' });
    f.chat.conversations[f.npc.id] = [{ role: 'user', content: '保留试聊' }];
    f.api.save();
    const b = applyCanon(f, canon(f, { subjects: [f.friend.id], activity: '有效 B 活动' }, '顾宁正在北塔练剑。'));
    const bState = structuredClone(f.chat.npcStates[f.friend.id]);
    const retained = structuredClone({ parties: f.chat.parties, player: f.chat.player, diaries: f.chat.diaries, conversations: f.chat.conversations });
    f.ctx.chat.shift(); // Delete only A's source; B is still present.
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), true);
    assert.equal(a.status, 'revoked_review'); assert.equal(b.status, 'active');
    assert.equal(f.chat.npcStates[f.npc.id].locationId, f.north.id);
    assert.equal(f.chat.npcStates[f.npc.id].relationship.note, '手动 B');
    assert.deepEqual(f.chat.npcStates[f.friend.id], bState);
    assert.equal(f.chat.day, 12);
    assert.deepEqual({ parties: f.chat.parties, player: f.chat.player, diaries: f.chat.diaries, conversations: f.chat.conversations }, retained);
    assert.equal(f.chat.events.some(item => item.derivedFrom === a.id), false);
    assert.equal(f.chat.events.some(item => item.derivedFrom === b.id), true);
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), false, 'repeated scan has no work');
});

test('later active canon B on the same field retains ownership when earlier A is revoked', () => {
    const f = fixture();
    const a = applyCanon(f, canon(f, { activity: 'A 活动' }, '林青正在北塔读书。'));
    const b = applyCanon(f, canon(f, { activity: 'B 活动' }, '林青正在北塔练剑。'));
    const bState = structuredClone(f.chat.npcStates[f.npc.id]);
    for (const key of ['source', 'updatedDay']) {
        const path = field('npcStates', f.npc.id, key);
        const aPatch = a.patches.find(patch => patch.path === path);
        const bPatch = b.patches.find(patch => patch.path === path);
        assert.ok(bPatch, `B records ownership of its same-value ${key} write`);
        assert.deepEqual(bPatch.before, bPatch.after, `${key} has no value change`);
        assert.ok(bPatch.version > aPatch.version, `${key} still transfers ownership`);
        assert.equal(bPatch.beforeOwner, a.id);
    }
    f.ctx.chat.shift();
    f.api.revokeMissingCanonFacts(f.world, f.chat);
    assert.equal(a.status, 'revoked_review'); assert.equal(b.status, 'active');
    assert.deepEqual(f.chat.npcStates[f.npc.id], bState);
});

test('A → B dependency: deleting both sources keeps B for review instead of reviving invalid A; independent patches revert', () => {
    const f = fixture();
    const a = applyCanon(f, canon(f, { activity: 'A 活动' }, '林青正在北塔读书。'));
    const b = applyCanon(f, canon(f, { activity: 'B 活动' }, '林青正在北塔练剑。'));
    const path = field('npcStates', f.npc.id, 'activity');
    assert.equal(b.patches.find(patch => patch.path === path).beforeOwner, a.id);
    const independent = applyCanon(f, canon(f, { type: 'time', subjects: [], day: 7 }, '现在已经在第七天。'));
    f.ctx.chat = [];
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), true);
    assert.equal(a.status, 'revoked_review');
    assert.equal(b.status, 'revoked_review');
    assert.equal(f.chat.npcStates[f.npc.id].activity, 'B 活动');
    assert.equal(independent.status, 'revoked');
    assert.equal(f.chat.day, 1, 'independent day patch still reverts');
    assert.equal(f.chat.events.length, 0);
    assert.ok(f.chat.canonFacts.every(item => item.valid === false));
});

test('party/time/player canon patches revoke by stable path, retaining an independent later party', () => {
    const f = fixture();
    const together = applyCanon(f, canon(f, { type: 'together', subjects: [f.npc.id, f.friend.id], location: f.north.id }, '林青和顾宁一起走。'));
    assert.ok(together.patches.some(item => item.path === field('party', `canon:${together.id}`) && !item.beforeExists));
    f.chat.parties.unshift({ id: 'independent', members: ['npc:third'], locationId: f.south.id });
    f.api.save();
    f.api.revokeCanonFact(f.chat, together);
    assert.deepEqual(f.chat.parties.map(item => item.id), ['independent']);
    const time = applyCanon(f, canon(f, { type: 'time', subjects: [], day: 8 }, '现在已经在第八天。'));
    assert.ok(time.patches.some(item => item.path === field('day')));
    f.api.revokeCanonFact(f.chat, time); assert.equal(f.chat.day, 1);
    const player = applyCanon(f, canon(f, { type: 'player_position', subjects: [], location: f.south.id }, '我已经在南门。'));
    assert.ok(player.patches.some(item => item.path === field('player', 'locationId')));
    f.api.revokeCanonFact(f.chat, player); assert.equal(f.chat.player.locationId, 'unknown');
});

test('messageAnchors without IDs survive earlier deletion; legacy indexed anchors migrate while evidence survives', () => {
    const f = fixture();
    f.ctx.chat = [{ is_user: false, mes: '前文叙述' }];
    const fact = applyCanon(f, canon(f));
    const anchor = f.api.messageAnchors()[1];
    f.ctx.chat.shift();
    assert.equal(f.api.messageAnchors()[0].key, anchor.key);
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), false);
    assert.equal(fact.status, 'active');
    const legacy = { id: 'legacy-indexed', authority: 'canon', status: 'active',
        evidence: fact.evidence, messageKey: 'legacy:index:1' }; // Genuine legacy: no patches.
    f.chat.factLedger.push(legacy);
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), false);
    assert.equal(legacy.messageKey, anchor.key);
    assert.equal(fact.messageKey, anchor.key, 'modern fact never needed index migration');
    f.ctx.chat[0].mes = '用户已经改写成另一件事。';
    assert.notEqual(f.api.messageAnchors()[0].key, anchor.key);
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), true);
    assert.equal(fact.status, 'revoked');
});

test('missing chat during host transition does not revoke canon; actual empty chat does', () => {
    const f = fixture();
    const fact = applyCanon(f, canon(f));
    const before = f.api.canonFields(f.chat);
    f.ctx.chat = undefined;
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), false);
    assert.equal(fact.status, 'active');
    assert.deepEqual(f.api.canonFields(f.chat), before);
    f.ctx.chat = [];
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), true);
    assert.equal(fact.status, 'revoked');
});

test('legacy canon without patches becomes revoked_review and preserves all state rather than restoring canonBaseline', () => {
    const f = fixture();
    f.chat.day = 23; f.chat.npcStates[f.npc.id].activity = '后来手动值';
    f.chat.parties.push({ id: 'later', members: [f.npc.id, f.friend.id] });
    const before = f.api.canonFields(f.chat);
    const legacy = { id: 'legacy', authority: 'canon', status: 'active', messageKey: 'deleted', evidence: '旧证据' };
    f.chat.factLedger.push(legacy);
    f.chat.canonFacts.push({ id: legacy.id, valid: true });
    assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), true);
    assert.equal(legacy.status, 'revoked_review');
    assert.deepEqual(f.api.canonFields(f.chat), before);
    assert.equal(f.chat.canonFacts[0].valid, false);
});

test('extractStoryFacts 把用户声称的成功只记为主张，不自动改世界；愿望仍是提案，确认后才生效', async () => {
    const f = fixture();
    f.ctx.chat = [{ is_user: true, mes: '我带林青逃出监狱了。' }, { is_user: true, mes: '希望顾宁逃出监狱。' }];
    const state = f.chat.npcStates[f.npc.id];
    state.activityLock = { active: true, kind: 'prison', source: 'card', reason: '卡片初始囚禁' };
    state.locked = true; state.mobility = 'immobile';
    f.respond({ facts: [
        { type: 'status', subjects: [f.npc.name], object: 'escaped', activity: '逃出监狱', summary: '林青已逃出', evidence: f.ctx.chat[0].mes, direct: true, confidence: 1 },
        { type: 'status', subjects: [f.friend.name], object: 'escaped', summary: '顾宁逃出提案', evidence: f.ctx.chat[1].mes, direct: true, confidence: 1 },
    ] });
    await f.api.extractStoryFacts();
    const fact = f.chat.factLedger.find(item => item.authority === 'claim');
    assert.ok(fact); assert.equal(fact.status, 'claim');
    assert.equal(state.activityLock.source, 'card'); assert.equal(state.locked, true);
    assert.ok(f.chat.pendingFacts.some(item => item.authority === 'proposal'));
    await f.api.extractStoryFacts();
    assert.equal(f.chat.factLedger.length, 2, 'repeat synchronization does not duplicate facts');
    assert.equal(f.api.applyCanonFact(f.world, f.chat, fact), true);
    assert.equal(state.confinement.value, 'escaped');
});

test('用户主张不会在删除正文后自动改写世界；手动确认后才会生效', async () => {
    const f = fixture(), evidence = '林青正在北塔读书。';
    const message = { is_user: true, mes: evidence };
    f.ctx.chat = [message];
    f.respond({ facts: [{ type: 'activity', subjects: [f.npc.id], activity: '读书',
        summary: evidence, evidence, direct: true, confidence: 1 }] });
    await f.api.extractStoryFacts();
    const original = f.chat.factLedger[0];
    assert.equal(original.authority, 'claim');
    assert.equal(original.status, 'claim');
    assert.equal(f.chat.npcStates[f.npc.id].activity, '原活动');
    assert.equal(f.api.applyCanonFact(f.world, f.chat, original), true);
    assert.equal(f.chat.npcStates[f.npc.id].activity, '读书');
    original.status = 'active';
    f.chat.factLedger[0] = original;
    f.ctx.chat = [];
    f.api.revokeMissingCanonFacts(f.world, f.chat);
    assert.notEqual(f.chat.npcStates[f.npc.id].activity, '不存在的自动成功');
});

for (const source of ['manual', 'migration']) test(`canon escape retains ${source} lock and flags conflict for review`, () => {
    const f = fixture(), state = f.chat.npcStates[f.npc.id];
    state.activityLock = { active: true, source, kind: 'lock', reason: '保留锁' };
    state.locked = true; state.mobility = 'immobile';
    applyCanon(f, canon(f, { type: 'status', object: 'escaped' }, '我带林青逃出监狱了。'));
    assert.equal(state.activityLock.source, source); assert.equal(state.activityLock.active, true);
    assert.equal(state.locked, true); assert.equal(state.mobility, 'immobile');
    assert.match(f.chat.factLedger[0].reviewReason, /冲突|保留|校准/);
});

test('出行评估不再计算路线或到达时间；闭关仍阻断，锁定不阻断', () => {
    const f = fixture(), request = { npcId: f.npc.id, targetLocationId: f.south.id, deadlineDay: 2 };
    const unknown = f.api.evaluateAppearanceRequest(f.world, f.chat, request);
    assert.ok(['opportunity', 'needs_info'].includes(unknown.status));
    if (unknown.status === 'opportunity') assert.equal(unknown.durationDays, null);
    route(f);
    const result = f.api.evaluateAppearanceRequest(f.world, f.chat, request);
    assert.equal(result.status, 'opportunity');
    assert.equal(result.durationDays, null);
    assert.equal(result.earliestDay, null);
    assert.match(result.reason, /不计算路线或到达时间/);
    const found = f.api.findRoute(f.world, f.north.id, f.south.id);
    assert.equal(found.durationDays, null);
    f.chat.npcStates[f.npc.id].locked = true;
    assert.equal(f.api.evaluateAppearanceRequest(f.world, f.chat, request).status, 'opportunity');
    f.chat.parties.push({ id: 'group', members: [f.npc.id, f.friend.id], locationId: f.north.id });
    f.chat.npcStates[f.friend.id].activityLock = { active: true, reason: '闭关' };
    assert.equal(f.api.evaluateAppearanceRequest(f.world, f.chat, request).status, 'blocked');
    assert.equal(f.api.validateTransition(f.world, f.chat, [f.npc.id], f.south.id).code, 'party_split');
});

test('出行排期只记录意向，不按游戏日推算抵达', () => {
    const f = fixture(); route(f);
    const request = { id: 'request', type: 'appearance_request', npcId: f.npc.id,
        targetLocationId: f.south.id, stateRevision: f.chat.stateRevision, status: 'opportunity' };
    f.chat.appearanceRequests.push(request);
    assert.throws(() => f.api.confirmTravelPlan(request.id), /意愿|动机/);
    request.motivationDecision = 'accept'; request.stateRevision--;
    assert.throws(() => f.api.confirmTravelPlan(request.id), /状态已变化/);
    request.stateRevision = f.chat.stateRevision;
    f.api.confirmTravelPlan(request.id);
    const plan = f.chat.travelPlans[0];
    assert.equal(plan.arrivalDay, null); assert.equal(plan.status, 'intent');
    assert.equal(plan.visibility, 'backstage'); assert.deepEqual(plan.knownBy, []);
    assert.equal(f.chat.npcStates[f.npc.id].locationId, f.north.id);
    assert.equal(f.chat.npcStates[f.npc.id].scene, 'away');
    assert.throws(() => f.api.confirmTravelPlan(request.id), /状态已变化|重复/);
    f.chat.day = 4; assert.equal(f.api.advanceTravelPlans(f.world, f.chat).length, 0);
    assert.equal(plan.status, 'intent');
    assert.equal(f.chat.npcStates[f.npc.id].locationId, f.north.id, '系统不声称已经抵达');
});

test('simulation validator rejects teleport, unknown/unconfirmed entities, locks, present, fresh, archived and partial parties', () => {
    const f = fixture({ trackNpc: true });
    const event = eventFor(f);
    const validate = raw => f.api.validateSimulationEvents(f.world, f.chat, [raw], new Set([f.npc.id, f.friend.id]));
    assert.equal(validate(event).length, 1);
    for (const bad of [
        { locationId: f.south.id }, { locationId: 'unknown' }, { npcIds: ['npc:foreign'] },
        { participants: ['npc:foreign'] },
    ]) assert.equal(validate({ ...event, ...bad }).length, 0);
    f.chat.npcStates[f.npc.id].locked = true;
    assert.equal(validate(event).length, 1, '锁定只保留状态，不阻断模拟行动');
    f.chat.npcStates[f.npc.id].locked = false;
    for (const [key, value] of [['activityLock', { active: true, reason: '闭关' }], ['mobility', 'immobile'], ['scene', 'present'], ['updatedDay', 1]]) {
        const old = f.chat.npcStates[f.npc.id][key];
        f.chat.npcStates[f.npc.id][key] = value;
        assert.equal(validate(event).length, 0, `${key} must block simulation`);
        f.chat.npcStates[f.npc.id][key] = old;
    }
    f.npc.archived = true; assert.equal(validate(event).length, 0); f.npc.archived = false;
    f.npc.ignored = true; assert.equal(validate(event).length, 0); f.npc.ignored = false;
    f.north.confirmed = false; assert.equal(validate(event).length, 0); f.north.confirmed = true;
    f.chat.parties.push({ id: 'party', members: [f.npc.id, f.friend.id], locationId: f.north.id });
    assert.equal(validate(event).length, 0, 'whole party required');
    assert.equal(validate({ ...event, npcIds: [f.npc.id, f.friend.id], participants: [f.npc.id, f.friend.id] }).length, 1);
});

test('simulateDay commits once, advances time, updates eligible NPCs and rejects already processed day', async () => {
    const f = fixture({ trackNpc: true }); f.friend.tracked = false;
    f.respond({ events: [eventFor(f)] });
    await f.api.simulateDay();
    assert.equal(f.chat.day, 2); assert.equal(f.chat.npcStates[f.npc.id].updatedDay, 1);
    assert.deepEqual(f.chat.processedBatches, [1]);
    assert.equal(f.chat.events.filter(item => item.source === 'simulation').length, 1);
    assert.equal(f.calls.requests[0][2], 'simulation');
    f.chat.day = 1;
    await assert.rejects(f.api.simulateDay(), /已模拟/);
    assert.equal(f.calls.requests.length, 1);
});

for (const mode of ['malformed', 'invalid', 'api-error']) test(`simulation ${mode} leaves day, events and NPC states unchanged`, async () => {
    const f = fixture({ trackNpc: true }); f.friend.tracked = false;
    if (mode === 'malformed') f.respond(() => 'not JSON');
    else if (mode === 'invalid') f.respond({ events: [eventFor(f, { locationId: f.south.id })] });
    else f.respond(() => { throw new Error('mock generation failed'); });
    const before = structuredClone(f.chat);
    await assert.rejects(f.api.simulateDay());
    assert.deepEqual(f.chat, before);
    f.respond({ events: [eventFor(f)] });
    await f.api.simulateDay(); assert.equal(f.chat.day, 2, 'busy lock releases after failure');
});

for (const mode of ['card', 'chat', 'save', 'archive']) test(`in-flight simulation discards stale result after ${mode} change`, async () => {
    const f = fixture({ trackNpc: true }); f.friend.tracked = false;
    const gate = deferred(), started = deferred();
    f.respond(() => { started.resolve(); return gate.promise; });
    const rejected = assert.rejects(f.api.simulateDay(), /改变|丢弃/);
    await started.promise;
    if (mode === 'card') f.ctx.characterId = 1;
    if (mode === 'chat') f.ctx.chatId = 'chat-b';
    if (mode === 'save') { f.chat.npcStates[f.npc.id].activity = '后来保存'; f.api.save(); }
    if (mode === 'archive') f.api.archiveNpc(f.npc.id);
    const before = structuredClone(f.chat);
    const other = mode === 'card' || mode === 'chat' ? f.api.activeData().chat : null;
    if (other) f.api.activeData(); // Normalize lazy-created target before asserting no writes.
    const otherBefore = other && structuredClone(other);
    gate.resolve(JSON.stringify({ events: [eventFor(f)] }));
    await rejected;
    assert.deepEqual(f.chat, before, 'old chat gets no generated mutations');
    if (other) assert.deepEqual(other, otherBefore, 'new chat gets no generated mutations');
});

test('no eligible NPCs still does not invent arrival by day count; unstable chat identity blocks simulation', async () => {
    const f = fixture(); route(f);
    f.npc.tracked = f.friend.tracked = false;
    f.chat.travelPlans.push({ id: 'trip', npcIds: [f.npc.id], targetLocationId: f.south.id,
        lastProgressDay: 1, arrivalDay: 2, status: 'in_transit' });
    await f.api.simulateDay();
    assert.equal(f.chat.day, 2);
    assert.notEqual(f.chat.travelPlans[0].status, 'arrival_ready');
    assert.equal(f.chat.npcStates[f.npc.id].scene, 'away'); assert.equal(f.calls.requests.length, 0);
    f.ctx.chatId = undefined;
    await assert.rejects(f.api.simulateDay(), /稳定聊天标识/);
    assert.equal(f.calls.requests.length, 0);
});

test('scene gestures are presentation only and use the configured player name; preference saves do not invalidate state', async () => {
    const f = fixture({ trackNpc: true });
    f.chat.npcStates[f.npc.id].scene = 'present'; f.chat.player.locationId = f.north.id;
    f.store.preferences.userName = '沈遥';
    f.respond({ gestures: [{ npcId: f.npc.id, text: '林青将雨伞挪到玄关边，回头看向沈遥。' }] });
    const before = structuredClone(f.chat);
    await f.api.generateSceneGestures();
    assert.deepEqual(f.chat, before);
    assert.match(f.calls.requests[0][1], /沈遥/);
    const version = f.chat.stateRevision;
    f.api.savePreferences(); assert.equal(f.chat.stateRevision, version);
    assert.equal(f.calls.saves, 1);
});

test('connection manager navigation opens only the verified drawer and leaves connection settings unchanged', () => {
    const f = fixture();
    const before = structuredClone(f.ctx.extensionSettings);
    let opened = false, clicks = 0, focused = 0;
    const panel = { classList: { contains: name => name === 'openDrawer' && opened } };
    const profiles = { focus() { focused++; }, scrollIntoView() {} };
    const toggle = { click() { clicks++; opened = true; } };
    const document = {
        getElementById: id => id === 'rm_api_block' ? panel : id === 'connection_profiles' ? profiles : null,
        querySelector: selector => selector === '#sys-settings-button > .drawer-toggle' ? toggle : null,
    };
    // Load this small real function with an isolated DOM; no host button handlers are executed.
    const match = originalSource.match(/function openConnectionManager\(\) \{[\s\S]*?\n\}/);
    assert.ok(match);
    const open = new Function('document', `${match[0]}; return openConnectionManager;`)(document);
    open(); open();
    assert.equal(clicks, 1);
    assert.equal(focused, 2);
    assert.deepEqual(f.ctx.extensionSettings, before);
    document.getElementById = () => null;
    assert.throws(open, /连接管理器未加载或已禁用/);
});

// Adapter tests run real index state/save/render code. Engine/service decisions are
// supplied as plain transactions; timelineContext alone is a presentation mock.
function worldFixture() {
    const f = fixture();
    f.store.preferences.autoMode = 'world';
    return f;
}
function worldNext(f, id, clockMinutes = 1440) {
    return { ...(f.chat.timeline || { baseDay: f.chat.day, clockMinutes: 0, turns: [] }),
        clockMinutes, turns: [...(f.chat.timeline?.turns || []), { id }] };
}
const projection = (f, field, value) => ({ npcId: f.npc.id, field, value });
const patchFor = (turn, ...path) => turn.projectionPatches.find(patch => JSON.stringify(patch.path) === field(...path));

test('world commit projects once, deduplicates paths, records independent patches and saves/prompts once', () => {
    const f = worldFixture(), state = f.chat.npcStates[f.npc.id];
    const before = structuredClone(state), next = worldNext(f, 'turn:A', 1500);
    const nested = { value: 'friend', note: '投影关系', source: 'simulation' };
    const input = [projection(f, 'locationId', f.south.id), projection(f, 'activity', '中间活动'),
        projection(f, 'activity', '最终活动'), projection(f, 'relationship', nested)];
    const inputBefore = structuredClone(input), revision = f.chat.stateRevision;
    f.api.commitWorldTurn(next, input);
    const turn = next.turns.at(-1);
    assert.equal(f.chat.timeline, next);
    assert.equal(state.locationId, f.south.id); assert.equal(state.activity, '最终活动');
    assert.equal(state.source, 'simulation'); assert.equal(f.chat.day, 2);
    assert.deepEqual(input, inputBefore);
    assert.equal(f.chat.stateRevision, revision + 1); assert.equal(f.calls.saves, 1);
    assert.equal(f.calls.prompts.length, 1); assert.equal(f.calls.timelineContexts.length, 1);
    assert.equal(f.calls.prompts[0][1], 'mock world context:turn:A');
    assert.equal(f.calls.timelineContexts[0][0], next); assert.equal(f.calls.timelineContexts[0][2], 1200);
    assert.equal(turn.projectionPatches.length, 5, 'three projected fields, source, and day each own one patch');
    for (const key of ['locationId', 'activity', 'relationship', 'source']) {
        const patch = patchFor(turn, 'npcStates', f.npc.id, key);
        assert.deepEqual(patch.before, before[key]); assert.equal(patch.beforeExists, true);
        assert.equal(patch.owner, turn.id); assert.equal(patch.ownerBefore, null);
        assert.deepEqual(f.chat.timelineOwners[field(...patch.path)], { owner: turn.id, serialized: JSON.stringify(patch.after) });
    }
    assert.equal(patchFor(turn, 'day').before, 1); assert.equal(patchFor(turn, 'day').after, 2);
    nested.note = '外部修改输入';
    assert.equal(state.relationship.note, '投影关系');
    state.relationship.note = '修改当前状态';
    assert.equal(patchFor(turn, 'npcStates', f.npc.id, 'relationship').after.note, '投影关系');
});

test('world commit projects a complete moving party location and rollback restores the party location', () => {
    const f = worldFixture();
    const party = { id: 'party:traveling', members: [f.npc.id, f.friend.id], locationId: f.north.id,
        source: 'simulation', confirmed: true };
    f.chat.parties.push(party);
    const next = worldNext(f, 'turn:party', 1440);
    f.api.commitWorldTurn(next, [
        { npcId: f.npc.id, field: 'locationId', value: f.south.id },
        { npcId: f.friend.id, field: 'locationId', value: f.south.id },
    ]);
    const turn = next.turns.at(-1);
    const partyPatch = patchFor(turn, 'party', party.id, 'locationId');
    assert.ok(partyPatch, 'complete party movement records a party location patch');
    assert.equal(partyPatch.before, f.north.id); assert.equal(partyPatch.after, f.south.id);
    assert.equal(party.locationId, f.south.id);
    assert.equal(f.chat.npcStates[f.npc.id].locationId, party.locationId);
    assert.equal(f.chat.npcStates[f.friend.id].locationId, party.locationId);
    assert.equal(f.chat.timelineOwners[field('party', party.id, 'locationId')].owner, turn.id);
    f.api.rollbackWorldTurns([turn], { baseDay: 1, clockMinutes: 0, turns: [] });
    assert.equal(party.locationId, f.north.id, 'undo restores the party location alongside member locations');
    assert.equal(f.chat.npcStates[f.npc.id].locationId, f.north.id);
    assert.equal(f.chat.npcStates[f.friend.id].locationId, f.north.id);
    assert.equal(f.chat.timelineOwners[field('party', party.id, 'locationId')], undefined);
});

test('world commit requires a source turn before any projected state/save/prompt mutation', () => {
    const f = worldFixture(), before = structuredClone(f.chat);
    assert.throws(() => f.api.commitWorldTurn({ baseDay: 1, clockMinutes: 1440, turns: [] },
        [projection(f, 'locationId', f.south.id)]), /来源事务/);
    assert.deepEqual(f.chat, before); assert.equal(f.calls.saves, 0); assert.equal(f.calls.prompts.length, 0);
});

test('world ownership A → B rolls back B to A, then A to baseline, including same-value source/day ownership', () => {
    const f = worldFixture(), initial = structuredClone(f.chat.npcStates[f.npc.id]);
    const a = worldNext(f, 'turn:A');
    f.api.commitWorldTurn(a, [projection(f, 'locationId', f.south.id), projection(f, 'activity', 'A 活动')]);
    const aState = structuredClone(f.chat.npcStates[f.npc.id]);
    const b = worldNext(f, 'turn:B');
    f.api.commitWorldTurn(b, [projection(f, 'locationId', f.north.id), projection(f, 'activity', 'B 活动')]);
    for (const path of [['npcStates', f.npc.id, 'source'], ['day']]) {
        const patch = patchFor(b.turns.at(-1), ...path);
        assert.deepEqual(patch.before, patch.after, 'same-value writes still transfer ownership');
        assert.equal(patch.ownerBefore.owner, 'turn:A');
        assert.equal(f.chat.timelineOwners[field(...path)].owner, 'turn:B');
    }
    f.api.rollbackWorldTurns([b.turns.at(-1)], a);
    assert.deepEqual(f.chat.npcStates[f.npc.id], aState); assert.equal(f.chat.day, 2);
    assert.equal(a.pausedReason, undefined);
    assert.ok(Object.values(f.chat.timelineOwners).every(owner => owner.owner === 'turn:A'));
    const baseline = { baseDay: 1, clockMinutes: 0, turns: [] };
    f.api.rollbackWorldTurns(a.turns, baseline);
    assert.deepEqual(f.chat.npcStates[f.npc.id], initial); assert.equal(f.chat.day, 1);
    assert.deepEqual(f.chat.timelineOwners, {}); assert.equal(baseline.pausedReason, undefined);
});

test('world suffix rollback reverses A → B together and deletes fields that did not exist at baseline', () => {
    const f = worldFixture(), initial = structuredClone(f.chat.npcStates[f.npc.id]);
    const a = worldNext(f, 'turn:A');
    f.api.commitWorldTurn(a, [projection(f, 'activity', 'A'), projection(f, 'adapterOnly', { tag: 'A' })]);
    assert.equal(patchFor(a.turns[0], 'npcStates', f.npc.id, 'adapterOnly').beforeExists, false);
    const b = worldNext(f, 'turn:B', 2880);
    f.api.commitWorldTurn(b, [projection(f, 'activity', 'B'), projection(f, 'adapterOnly', { tag: 'B' })]);
    const baseline = { baseDay: 1, clockMinutes: 0, turns: [] };
    const order = b.turns.map(turn => turn.id);
    f.api.rollbackWorldTurns(b.turns, baseline);
    assert.deepEqual(b.turns.map(turn => turn.id), order, 'rollback must not reverse the transaction input in place');
    assert.deepEqual(f.chat.npcStates[f.npc.id], initial); assert.equal(f.chat.day, 1);
    assert.equal(Object.hasOwn(f.chat.npcStates[f.npc.id], 'adapterOnly'), false);
    assert.deepEqual(f.chat.timelineOwners, {}); assert.equal(baseline.pausedReason, undefined);
});

for (const saved of [false, true]) test(`world rollback preserves same-value manual location/source (saved=${saved}) and pauses injection`, () => {
    const f = worldFixture(), state = f.chat.npcStates[f.npc.id];
    const next = worldNext(f, 'turn:A');
    f.api.commitWorldTurn(next, [projection(f, 'locationId', f.south.id)]);
    if (saved) f.api.setManualNpcLocation(f.npc.id, f.south.id);
    else state.source = 'manual'; // Pending external edit is also detected by rollback's observation.
    const manualState = structuredClone(state), baseline = { baseDay: 1, clockMinutes: 0, turns: [] };
    f.api.rollbackWorldTurns(next.turns, baseline);
    assert.deepEqual(state, manualState, 'manual confirmation of the same value must not revive the old location/source');
    assert.equal(state.locationId, f.south.id); assert.equal(state.source, 'manual');
    assert.equal(f.chat.day, 1, 'independently owned day can still revert');
    assert.equal(f.chat.timelineOwners[field('npcStates', f.npc.id, 'locationId')], undefined);
    assert.match(baseline.pausedReason, /人工|后续/);
    assert.deepEqual(baseline.rollbackConflicts, [{ count: 2, reason: baseline.pausedReason }]);
    assert.equal(f.calls.prompts.at(-1)[1], '');
    assert.equal(f.calls.timelineContexts.length, 1, 'paused rollback must not compute injectable world context');
});

for (const source of ['manual', 'canon']) test(`world commit rejects intervening unsaved same-value ${source} ownership before B can overwrite it`, () => {
    const f = worldFixture(), state = f.chat.npcStates[f.npc.id];
    const a = worldNext(f, 'turn:A');
    f.api.commitWorldTurn(a, [projection(f, 'locationId', f.south.id)]);
    state.source = source; // Same-value external confirmation before its own save.
    const retained = structuredClone(state), b = worldNext(f, 'turn:B', 2880);
    const saves = f.calls.saves, prompts = f.calls.prompts.length;
    assert.throws(() => f.api.commitWorldTurn(b, [projection(f, 'locationId', f.north.id)]), /基线|人工|正文/);
    assert.deepEqual(state, retained); assert.equal(f.chat.timeline, a);
    assert.equal(f.chat.day, 2); assert.equal(f.calls.saves, saves); assert.equal(f.calls.prompts.length, prompts);
    assert.equal(b.turns.at(-1).projectionPatches, undefined);
    assert.equal(f.chat.timelineOwners[field('npcStates', f.npc.id, 'locationId')], undefined);
    const baseline = { baseDay: 1, clockMinutes: 0, turns: [] };
    f.api.rollbackWorldTurns(a.turns, baseline);
    assert.deepEqual(state, retained, 'revoking A must retain the intervening external destination and source');
    assert.match(baseline.pausedReason, /人工|后续/);
});

test('world observation releases only changed owned fields; rollback preserves unrelated state, history and party/player edits', () => {
    const f = worldFixture(), state = f.chat.npcStates[f.npc.id];
    const next = worldNext(f, 'turn:A');
    f.api.commitWorldTurn(next, [projection(f, 'locationId', f.south.id), projection(f, 'activity', '投影活动')]);
    state.activity = '外部活动'; state.relationship = { value: 'friend', note: '保留', source: 'manual' };
    f.chat.player.locationId = f.south.id;
    f.chat.parties.push({ id: 'manual-party', members: [f.friend.id], locationId: f.north.id });
    f.chat.events.push({ id: 'independent-event', summary: '保留历史' });
    f.chat.diaries.push({ id: 'independent-diary', npcId: f.npc.id, text: '保留日记' });
    f.chat.conversations[f.npc.id] = [{ role: 'user', content: '保留试聊' }];
    f.chat.npcStates[f.friend.id].activity = '无关 NPC 活动';
    f.api.save();
    assert.equal(f.chat.timelineOwners[field('npcStates', f.npc.id, 'activity')], undefined);
    assert.equal(f.chat.timelineOwners[field('npcStates', f.npc.id, 'locationId')].owner, 'turn:A');
    const keep = structuredClone({ player: f.chat.player, parties: f.chat.parties, events: f.chat.events,
        diaries: f.chat.diaries, conversations: f.chat.conversations, friend: f.chat.npcStates[f.friend.id], relationship: state.relationship });
    f.api.rollbackWorldTurns(next.turns, { baseDay: 1, clockMinutes: 0, turns: [] });
    assert.equal(state.locationId, f.north.id); assert.equal(state.source, 'story');
    assert.equal(state.activity, '外部活动');
    assert.deepEqual({ player: f.chat.player, parties: f.chat.parties, events: f.chat.events,
        diaries: f.chat.diaries, conversations: f.chat.conversations, friend: f.chat.npcStates[f.friend.id], relationship: state.relationship }, keep);
});

test('world rollback protects later saved day, including ABA back to the projected value', () => {
    for (const aba of [false, true]) {
        const f = worldFixture(), next = worldNext(f, 'turn:A', 2880);
        f.api.commitWorldTurn(next, [projection(f, 'activity', '投影活动')]);
        assert.equal(f.chat.day, 3);
        f.chat.day = 19; f.api.save();
        if (aba) { f.chat.day = 3; f.api.save(); }
        const expectedDay = f.chat.day, baseline = { baseDay: 1, clockMinutes: 0, turns: [] };
        assert.equal(f.chat.timelineOwners[field('day')], undefined);
        f.api.rollbackWorldTurns(next.turns, baseline);
        assert.equal(f.chat.day, expectedDay, 'later day calibration must never restore the old day');
        assert.equal(f.chat.npcStates[f.npc.id].activity, '原活动');
        assert.match(baseline.pausedReason, /人工|后续/);
    }
});

for (const saved of [false, true]) test(`world commit refuses externally calibrated day before overwriting it (saved=${saved})`, () => {
    const f = worldFixture(), a = worldNext(f, 'turn:A');
    f.api.commitWorldTurn(a, [projection(f, 'activity', 'A 活动')]);
    f.chat.day = 17;
    if (saved) f.api.save();
    const state = structuredClone(f.chat.npcStates), saves = f.calls.saves;
    const b = worldNext(f, 'turn:B', 2880);
    assert.throws(() => f.api.commitWorldTurn(b, [projection(f, 'activity', 'B 活动')]), /游戏日|基线/);
    assert.equal(f.chat.day, 17); assert.deepEqual(f.chat.npcStates, state);
    assert.equal(f.chat.timeline, a); assert.equal(f.calls.saves, saves);
    assert.equal(f.chat.timelineOwners[field('day')], undefined);
    assert.equal(b.turns.at(-1).projectionPatches, undefined);
});

test('world rollback of earlier A retains still-owned B and reports conflicts rather than undoing B', () => {
    const f = worldFixture(), a = worldNext(f, 'turn:A');
    f.api.commitWorldTurn(a, [projection(f, 'activity', 'A 活动')]);
    const b = worldNext(f, 'turn:B', 2880);
    f.api.commitWorldTurn(b, [projection(f, 'activity', 'B 活动')]);
    const state = structuredClone(f.chat.npcStates), owners = structuredClone(f.chat.timelineOwners);
    const remaining = { ...b, turns: [b.turns.at(-1)] };
    f.api.rollbackWorldTurns(a.turns, remaining);
    assert.deepEqual(f.chat.npcStates, state); assert.deepEqual(f.chat.timelineOwners, owners);
    assert.equal(f.chat.day, 3); assert.match(remaining.pausedReason, /后续/);
    assert.deepEqual(remaining.rollbackConflicts, [{ count: 3, reason: remaining.pausedReason }]);
    assert.equal(f.calls.prompts.at(-1)[1], '');
});

test('world commit and rollback isolate another chat, including owners, prompt identity and timeline', () => {
    const f = worldFixture(), a = worldNext(f, 'turn:A');
    f.api.commitWorldTurn(a, [projection(f, 'locationId', f.south.id)]);
    const firstBefore = structuredClone(f.chat);
    f.ctx.chatId = 'chat-peer';
    const peer = f.api.activeData().chat;
    f.api.activeData();
    assert.notEqual(peer, f.chat); assert.equal(peer.timeline, undefined);
    assert.equal(peer.timelineOwners, undefined);
    const peerNext = { baseDay: peer.day, clockMinutes: 4320, turns: [{ id: 'turn:peer' }] };
    f.api.commitWorldTurn(peerNext, [projection(f, 'activity', '另一个聊天的活动')]);
    const peerBefore = structuredClone(peer);
    assert.deepEqual(f.chat, firstBefore);
    f.ctx.chatId = 'chat-a';
    f.api.checkIdentity();
    assert.equal(f.calls.prompts.at(-1)[1], 'mock world context:turn:A');
    f.api.rollbackWorldTurns(a.turns, { baseDay: 1, clockMinutes: 0, turns: [] });
    assert.equal(f.chat.npcStates[f.npc.id].locationId, f.north.id);
    assert.deepEqual(peer, peerBefore);
    f.ctx.chatId = 'chat-peer'; f.api.checkIdentity();
    assert.equal(f.calls.prompts.at(-1)[1], 'mock world context:turn:peer');
});

test('world prompt clears when paused, disabled or absent and restores only the current active timeline', () => {
    const f = worldFixture();
    f.api.syncWorldPrompt(); assert.equal(f.calls.prompts.at(-1)[1], '');
    assert.equal(f.calls.timelineContexts.length, 0);
    const next = worldNext(f, 'turn:A', 0);
    f.api.commitWorldTurn(next, []);
    assert.equal(f.calls.prompts.at(-1)[1], 'mock world context:turn:A');
    next.pausedReason = '需要核对'; f.api.syncWorldPrompt();
    assert.equal(f.calls.prompts.at(-1)[1], '');
    delete next.pausedReason; f.store.preferences.autoMode = 'notes'; f.api.syncWorldPrompt();
    assert.equal(f.calls.prompts.at(-1)[1], ''); assert.equal(f.calls.timelineContexts.length, 1);
    f.store.preferences.autoMode = 'world'; f.api.syncWorldPrompt();
    assert.equal(f.calls.prompts.at(-1)[1], 'mock world context:turn:A');
    assert.equal(f.calls.timelineContexts.length, 2);
});

test('worldRules 只提供叙事软约束，不再计算旅行耗时', () => {
    const f = worldFixture(); route(f, 3);
    f.chat.npcStates[f.npc.id].travelRate = 2; f.chat.npcStates[f.friend.id].travelRate = 0.5;
    const rules = f.api.worldRules();
    assert.equal(rules.npcs, f.world.catalog.npcs); assert.equal(rules.states, f.chat.npcStates);
    assert.equal(rules.locations, f.world.catalog.locations); assert.equal(rules.parties, f.chat.parties);
    assert.equal(rules.player, f.chat.player);
    assert.equal(rules.route, undefined);
    assert.equal(f.api.findRoute(f.world, f.north.id, f.south.id).durationDays, null);
    assert.equal(f.api.findRoute(f.world, f.south.id, f.north.id).durationDays, null);
});

for (const entry of ['simulateDay', 'confirmTravelPlan', 'advanceTravelPlans']) test(`world mode rejects legacy ${entry} before mutation, save or generation`, async () => {
    const f = worldFixture(); route(f);
    const request = { id: 'legacy-request', type: 'appearance_request', npcId: f.npc.id,
        targetLocationId: f.south.id, motivationDecision: 'accept', stateRevision: f.chat.stateRevision };
    f.chat.appearanceRequests.push(request);
    f.chat.travelPlans.push({ id: 'legacy-plan', npcIds: [f.npc.id], targetLocationId: f.south.id,
        lastProgressDay: 0, arrivalDay: 1, status: 'in_transit' });
    const before = structuredClone(f.chat), revision = f.chat.stateRevision;
    if (entry === 'simulateDay') await assert.rejects(f.api.simulateDay(), /同步世界/);
    if (entry === 'confirmTravelPlan') assert.throws(() => f.api.confirmTravelPlan(request.id), /同步世界/);
    if (entry === 'advanceTravelPlans') assert.throws(() => f.api.advanceTravelPlans(f.world, f.chat), /同步世界/);
    assert.deepEqual(f.chat, before); assert.equal(f.chat.stateRevision, revision);
    assert.equal(f.calls.requests.length, 0); assert.equal(f.calls.saves, 0); assert.equal(f.calls.prompts.length, 0);
    assert.throws(() => f.api.assertLegacyClock(), /同步世界/);
    f.store.preferences.autoMode = 'notes'; assert.doesNotThrow(() => f.api.assertLegacyClock());
});


test('懒加载：资料里的名字先不追踪，写到正文或在场后才建档', () => {
    const f = fixture();
    assert.equal(f.npc.tracked, false);
    f.ctx.chat = [{ is_user: true, mes: '我在北塔遇见了林青。' }];
    assert.equal(f.api.lazyEnrollFromChat(f.world, f.chat), true);
    assert.equal(f.npc.tracked, true);
    assert.equal(f.npc.enrolledReason, 'mentioned');
    assert.ok(f.chat.npcStates[f.npc.id]);
    const other = f.world.catalog.npcs.find(item => item.name === '顾宁');
    // 顾宁只是夹具手动加入且已追踪（manual），资料里未写到的未追踪名不应被误建。
    const discovered = f.api.discoverCatalog();
    const untouched = discovered.npcs.filter(item => item.name !== '林青' && item.tracked === true);
    assert.equal(untouched.length, 0);
});

test('buildInjectionText 在玩家地点未知时仍给出已提交公开事实，不把未发现痕迹写成已知', () => {
    const f = fixture({ trackNpc: true });
    f.store.preferences.autoMode = 'world';
    f.chat.player.locationId = 'unknown';
    f.chat.timeline = { events: [], turns: [{ id: 'turn:A' }], pausedReason: '' };
    f.chat.publicSettlements = [{ id: 'e1', npcIds: [f.npc.id], summary: '林青完成了事先计划的阅读', clockMinutes: 15 }];
    const text = f.api.buildInjectionText();
    assert.match(text, /mock world context:turn:A/);
    assert.doesNotMatch(text, /已经看见|已经知道/);
});


test('生产路径：extractStoryFacts 把正文中的发现写回资料库；路过不写回，已发现不再以机会注入', async () => {
    const f = fixture({ trackNpc: true });
    const ledger = f.chat.activityLedger = ledgerApi.normalizeLedger();
    const drafts = ledgerApi.draftsFromSettlement([{
        id: 'e-search', kind: 'activity',
        summary: '林青完成了事先计划的翻找藏书并翻乱了书架',
        npcIds: [f.npc.id], locationId: f.north.id, turnId: 't1', knownBy: [],
    }], [], { turnId: 't1', sourceKeys: ['src:act'], locationName: id => id === f.north.id ? '北塔' : id });
    assert.equal(drafts.traces.length, 1);
    assert.equal(drafts.traces[0].traceType, 'search');
    ledgerApi.appendSettlementDrafts(ledger, drafts, { turnId: 't1', sourceKeys: ['src:act'], createdAtTurn: 1 });
    ledgerApi.commitLedgerTurn(ledger, 't1', 5);
    const traceId = ledger.traces[0].id;
    f.chat.player.locationId = f.north.id;
    f.chat.player.scene = 'confirmed';

    // 先走一轮开始前的注入，记录「可发现机会」，不得当成已经看见。
    const offeredText = f.api.buildInjectionText();
    assert.match(offeredText, /可被发现的线索机会/);
    assert.match(offeredText, /搜寻痕迹：在北塔/);
    assert.doesNotMatch(offeredText, /已发现的线索/);
    assert.equal(ledgerApi.isDiscoveredCanon(f.chat.activityLedger, traceId), false);

    f.ctx.chat = [
        { is_user: true, mes: '我走进北塔，穿过大厅继续往里走。' },
        { is_user: false, mes: '你路过北塔的厅堂，没有停留，继续向前。' },
    ];
    f.respond({ facts: [] });
    await f.api.extractStoryFacts();
    assert.equal(ledgerApi.isDiscoveredCanon(f.chat.activityLedger, traceId), false, '路过正文不得写回已发现');
    const stillOffered = f.api.buildInjectionText();
    assert.match(stillOffered, /可被发现的线索机会/);
    assert.doesNotMatch(stillOffered, /已发现的线索/);

    f.ctx.chat.push(
        { is_user: true, mes: '我停下来，仔细调查北塔这里好像有没有人来过。' },
        { is_user: false, mes: '你蹲在地上查看，发现书架被翻乱，这里好像有人来过，留下了翻找的痕迹。' },
    );
    f.respond({ facts: [] });
    await f.api.extractStoryFacts();
    assert.equal(ledgerApi.isDiscoveredCanon(f.chat.activityLedger, traceId), true, '调查且正文写出发现后应写回资料库');
    const found = (f.chat.activityLedger.discoveries || []).find(item => item.traceId === traceId && item.knowledge === 'found' && item.status === 'active');
    assert.ok(found);
    assert.match(found.evidence, /发现书架被翻乱|好像有人来过/);
    assert.ok(found.sourceKeys?.length);
    const after = f.api.buildInjectionText();
    assert.match(after, /已发现的线索/);
    assert.match(after, /已发现：/);
    assert.doesNotMatch(after, /可被发现的线索机会/);

    // 编辑发现来源后撤销，发现回退，机会可以再次出现。
    const revoked = ledgerApi.revokeBySourceKeys(f.chat.activityLedger, found.sourceKeys);
    assert.ok(revoked.discoveries >= 1);
    assert.equal(ledgerApi.isDiscoveredCanon(f.chat.activityLedger, traceId), false);
    const again = f.api.buildInjectionText();
    assert.match(again, /可被发现的线索机会/);
    assert.doesNotMatch(again, /已发现的线索/);
});


test('生产路径：动态世界书按窗口淘汰旧条目，幕后活动不写成玩家已知，已确认状态不被覆盖', () => {
    const f = fixture({ trackNpc: true });
    Object.assign(f.store.preferences, { encounterProbability: 0, worldBookMaxEntries: 5, worldBookMaxTurns: 3 });
    const ledger = f.chat.activityLedger = ledgerApi.normalizeLedger();
    for (let turn = 1; turn <= 12; turn++) {
        ledgerApi.recordActivity(ledger, {
            id: `act:old:${turn}`, npcIds: [f.npc.id], phase: 'done',
            summary: `林青完成了第${turn}件旧事`, locationId: f.north.id,
            turnId: `t${turn}`, createdAtTurn: turn, source: 'settlement', publicCanon: false,
        });
    }
    ledgerApi.recordActivity(ledger, {
        id: 'act:doing', npcIds: [f.npc.id], phase: 'doing',
        summary: '林青正在南门守夜', locationId: f.south.id,
        turnId: 't12', createdAtTurn: 12, source: 'settlement',
    });
    ledgerApi.commitLedgerTurn(ledger, 't12', 12);
    f.chat.npcStates[f.npc.id].locationId = f.south.id;
    f.chat.npcStates[f.npc.id].activity = '守夜';
    f.chat.player.locationId = f.south.id;
    const text = f.api.buildInjectionText();
    assert.match(text, /动态世界书｜辅助上下文，不是正史/);
    assert.match(text, /不得覆盖当前正文和已确认状态/);
    assert.match(text, /世界后台状态|角色动态/);
    assert.match(text, /南门/);
    assert.match(text, /正在南门守夜|正在做：林青正在南门守夜/);
    assert.doesNotMatch(text, /第1件旧事|第8件旧事|第9件旧事/);
    assert.doesNotMatch(text, /已经看见|已经知道/);
});

test('生产路径：已提交桥断与途经该桥的意图进入本轮注入；无关意图不注入；未提交结果不进入本轮', () => {
    const f = fixture({ trackNpc: true });
    Object.assign(f.store.preferences, { encounterProbability: 0 });
    const ledger = f.chat.activityLedger = ledgerApi.normalizeLedger();
    ledgerApi.recordActivity(ledger, {
        id: 'act:bridge', npcIds: [f.npc.id], phase: 'done',
        summary: '山道上的石桥断了，无法再从这里过河', locationId: 'loc:bridge',
        turnId: 't-old', createdAtTurn: 3, source: 'settlement', publicWorld: true,
    });
    ledgerApi.commitLedgerTurn(ledger, 't-old', 3);
    ledgerApi.recordActivity(ledger, {
        id: 'act:gate', npcIds: [f.npc.id], phase: 'done',
        summary: '南门的城门被烧毁了', locationId: f.south.id,
        turnId: 't-pending', createdAtTurn: 4, source: 'settlement', publicWorld: true,
    });
    f.ctx.chat = [{ is_user: true, mes: '我要去打败魔王，路上会用到那座桥，随后再去南门。' }];
    const related = f.api.buildInjectionText();
    assert.match(related, /与本轮意图重合的世界状态/);
    assert.match(related, /石桥断了/);
    assert.doesNotMatch(related, /城门被烧毁/);

    f.ctx.chat = [{ is_user: true, mes: '我在客栈安静吃饭，不想出门。' }];
    const unrelated = f.api.buildInjectionText();
    assert.doesNotMatch(unrelated, /与本轮意图重合的世界状态/, '无关意图不得把世界状态变化注入本轮正文');
    // 动态世界书仍可把已提交结果列为后台记录，但不得出现意图重合栏。
});

test('生产路径：偶遇受低概率与上限约束，囚禁和未登场资料不足者不闯入，偶遇不把痕迹标为已发现', () => {
    const f = fixture({ trackNpc: true });
    f.npc.appeared = true;
    f.npc.hasProfile = true;
    f.npc.description = '林青是世界卡里已出场的人物，性格沉稳。';
    const prisoner = f.api.makeNpc('囚徒', 'manual');
    prisoner.tracked = true; prisoner.appeared = true; prisoner.hasProfile = true;
    prisoner.description = '囚徒是被关押的人，暂时不能行动。';
    f.world.catalog.npcs.push(prisoner);
    f.chat.npcStates[prisoner.id] = f.api.makeNpcState(prisoner.id);
    const ghost = f.api.makeNpc('未登场者', 'card');
    ghost.tracked = true; ghost.appeared = false; ghost.hasProfile = false; ghost.description = '';
    f.world.catalog.npcs.push(ghost);
    f.chat.npcStates[ghost.id] = f.api.makeNpcState(ghost.id);

    const ledger = f.chat.activityLedger = ledgerApi.normalizeLedger();
    const drafts = ledgerApi.draftsFromSettlement([{
        id: 'e-search', kind: 'activity', summary: '林青完成了事先计划的翻找藏书并翻乱了书架',
        npcIds: [f.npc.id], locationId: f.north.id, turnId: 't1', knownBy: [],
    }], [], { turnId: 't1', locationName: () => '北塔' });
    ledgerApi.appendSettlementDrafts(ledger, drafts, { turnId: 't1', createdAtTurn: 1 });
    ledgerApi.recordActivity(ledger, { id: 'act:qing', npcIds: [f.npc.id], phase: 'doing', summary: '林青正在北塔巡视', locationId: f.north.id, turnId: 't2' });
    ledgerApi.recordActivity(ledger, { id: 'act:lock', npcIds: [prisoner.id], phase: 'doing', summary: '囚徒仍被关押', locationId: f.north.id, turnId: 't2' });
    ledgerApi.recordActivity(ledger, { id: 'act:ghost', npcIds: [ghost.id], phase: 'doing', summary: '未登场者正在潜行', locationId: f.north.id, turnId: 't2' });
    ledgerApi.commitLedgerTurn(ledger, 't2', 5);
    const traceId = ledger.traces[0].id;

    Object.assign(f.chat.npcStates[f.npc.id], { locationId: f.north.id, activity: '巡视', mobility: 'free', scene: 'away' });
    Object.assign(f.chat.npcStates[prisoner.id], { locationId: f.north.id, activity: '关押', mobility: 'immobile', confinement: { value: 'imprisoned' }, scene: 'away' });
    Object.assign(f.chat.npcStates[ghost.id], { locationId: f.north.id, activity: '潜行', mobility: 'free', scene: 'away' });
    f.chat.player.locationId = f.north.id;
    f.ctx.chat = [{ is_user: true, mes: '我在院子里晒太阳。' }];

    Object.assign(f.store.preferences, { encounterProbability: 0, encounterMaxPerTurn: 1 });
    const silent = f.api.buildInjectionText();
    assert.doesNotMatch(silent, /偶遇机会/);
    assert.equal(ledgerApi.isDiscoveredCanon(f.chat.activityLedger, traceId), false);

    Object.assign(f.store.preferences, { encounterProbability: 1, encounterMaxPerTurn: 1 });
    const text = f.api.buildInjectionText();
    assert.match(text, /偶遇机会/);
    const encounterSection = text.includes('【偶遇机会】') ? text.slice(text.indexOf('【偶遇机会】')) : '';
    assert.match(encounterSection, /林青/);
    assert.match(encounterSection, /正在北塔巡视|正在：林青正在北塔巡视/);
    assert.doesNotMatch(encounterSection, /囚徒|未登场者/);
    assert.equal((f.chat.injection.encounterNpcIds || []).length, 1);
    assert.deepEqual(f.chat.injection.encounterNpcIds, [f.npc.id]);
    assert.equal(ledgerApi.isDiscoveredCanon(f.chat.activityLedger, traceId), false, '偶遇本身不得写回已发现');
    assert.equal((f.chat.activityLedger.discoveries || []).filter(item => item.knowledge === 'found').length, 0);
});

let failures = 0;
try {
    for (const { name, run } of tests) {
        try {
            await run();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures++;
            console.error(`FAIL ${name}\n${error.stack || error}`);
        }
    }
} finally {
    globalThis.fetch = originalFetch;
}
console.log(`\nCore regression: ${tests.length - failures}/${tests.length} passed, ${failures} failed.`);
if (failures) process.exitCode = 1;

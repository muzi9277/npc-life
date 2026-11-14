import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Standalone runner intentionally supports both `bun tests/core.test.mjs` and Node.
const tests = [];
const test = (name, run) => tests.push({ name, run });

// Portable seam: load the real core without ST imports or its browser bootstrap.
// Only the external generation service is replaced; state/render/save logic stays real.
const indexUrl = new URL('../index.js', import.meta.url);
const { normalizeConsolePreferences } = await import(new URL('../services.js', import.meta.url).href);
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
    'ensureCatalog', 'archiveNpc', 'restoreNpc', 'activeNpc', 'resolveEntity', 'confirmedLocation',
    'messageAnchors', 'canonFields', 'observeCanonFields', 'revokeCanonFact', 'revokeMissingCanonFacts',
    'normalizeFact', 'applyCanonFact', 'extractStoryFacts', 'addEvent', 'save', 'savePreferences',
    'findRoute', 'validateTransition', 'evaluateAppearanceRequest', 'evaluateRequestMotivation', 'confirmTravelPlan',
    'advanceTravelPlans', 'commitGameDay', 'validateSimulationEvents', 'simulateDay',
    'generateSceneGestures', 'checkIdentity', 'syncPrompt', 'setManualNpcLocation', 'openConnectionManager',
];
const loadCore = new Function('environment', `
    const { SillyTavern, $, jQuery, extension_prompt_types, extension_prompt_roles,
        document, window, normalizeConsolePreferences, mockConsoleFeatures, mountConsole,
        createConsoleFeatures, fetch, setInterval } = environment;
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

function fixture() {
    const calls = { requests: [], saves: 0, prompts: [] };
    const ctx = {
        extensionSettings: {}, characterId: 0, chatId: 'chat-a', name1: '沈遥', chat: [],
        characters: [
            { name: 'World A', avatar: 'world-a.png', data: { character_book: { entries: [
                { keys: ['林青'], comment: '人物', content: '林青住在北塔。' },
                { keys: ['北塔'], comment: '地点：北塔', content: '北塔是要塞。' },
                { keys: ['南门'], comment: '地点：南门', content: '南门是出口。' },
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
        mountConsole: forbidden('console mount'), createConsoleFeatures: forbidden('real generation service'),
        fetch: forbidden('network fetch'), setInterval: forbidden('init timer'),
    });
    const data = api.activeData();
    api.activeData(); // Normalize newly created chats exactly as subsequent host reads do.
    const npc = data.world.catalog.npcs.find(item => item.name === '林青');
    const north = data.world.catalog.locations.find(item => item.name === '北塔');
    const south = data.world.catalog.locations.find(item => item.name === '南门');
    assert.ok(npc && north && south, 'real card discovery should seed the fixture');
    npc.confirmed = true;
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
    assert.equal(fact.authority, 'canon');
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

test('extractStoryFacts automatically activates user canon with patches in the same ledger record; wishes remain proposals', async () => {
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
    const fact = f.chat.factLedger.find(item => item.authority === 'canon');
    assert.equal(fact.status, 'active'); assert.ok(fact.patches.length);
    assert.equal(state.confinement.value, 'escaped'); assert.equal(state.activityLock, null);
    assert.equal(state.locationId, 'unknown');
    assert.equal(f.chat.pendingFacts.length, 1); assert.equal(f.chat.pendingFacts[0].authority, 'proposal');
    await f.api.extractStoryFacts();
    assert.equal(f.chat.factLedger.length, 2, 'repeat synchronization does not duplicate facts');
    f.ctx.chat.shift(); f.api.revokeMissingCanonFacts(f.world, f.chat);
    assert.equal(fact.status, 'revoked'); assert.equal(state.activityLock.source, 'card');
});

test('restored source can reapply automatically revoked canon; manualRevoked continues suppressing identical extraction', async () => {
    for (const manual of [false, true]) {
        const f = fixture(), evidence = '林青正在北塔读书。';
        const message = { is_user: true, mes: evidence };
        f.ctx.chat = [message];
        f.respond({ facts: [{ type: 'activity', subjects: [f.npc.id], activity: '读书',
            summary: evidence, evidence, direct: true, confidence: 1 }] });
        await f.api.extractStoryFacts();
        const original = f.chat.factLedger[0];
        assert.equal(original.status, 'active');
        assert.equal(f.chat.npcStates[f.npc.id].activity, '读书');
        if (manual) {
            // Match the UI's explicit revoke marker without calling init or binding DOM handlers.
            original.manualRevoked = true;
            f.api.revokeCanonFact(f.chat, original);
            f.api.save();
        }
        f.ctx.chat = [];
        assert.equal(f.api.revokeMissingCanonFacts(f.world, f.chat), !manual);
        assert.equal(original.status, 'revoked');
        assert.equal(f.chat.npcStates[f.npc.id].activity, '原活动');
        f.ctx.chat = [{ ...message }];
        await f.api.extractStoryFacts();
        const active = f.chat.factLedger.filter(fact => fact.authority === 'canon' && fact.status === 'active');
        if (manual) {
            assert.equal(active.length, 0, 'manual revocation survives source deletion/restoration');
            assert.equal(f.chat.factLedger.length, 1);
            assert.equal(f.chat.npcStates[f.npc.id].activity, '原活动');
            assert.equal(f.chat.events.length, 0);
        } else {
            assert.equal(active.length, 1);
            assert.notEqual(active[0].id, original.id, 'reapplication creates a new auditable record');
            assert.ok(active[0].patches.length);
            assert.equal(active[0].messageKey, original.messageKey);
            assert.equal(f.chat.factLedger.length, 2);
            assert.equal(f.chat.npcStates[f.npc.id].activity, '读书');
            assert.equal(f.chat.events.length, 1);
            assert.equal(f.chat.events[0].derivedFrom, active[0].id);
        }
        await f.api.extractStoryFacts();
        assert.equal(f.chat.factLedger.length, manual ? 1 : 2, 'repeated extraction remains deduplicated');
    }
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

test('travel feasibility: confirmed directed shortest routes, missing mobility/rate, deadline and whole-party locks', () => {
    const f = fixture(), request = { npcId: f.npc.id, targetLocationId: f.south.id, deadlineDay: 2 };
    assert.equal(f.api.evaluateAppearanceRequest(f.world, f.chat, request).status, 'needs_info');
    const r = route(f);
    assert.equal(f.api.findRoute(f.world, f.south.id, f.north.id), null, 'routes are directed');
    assert.deepEqual(f.api.findRoute(f.world, f.north.id, f.south.id), { durationDays: 3, routeIds: [r.id] });
    let result = f.api.evaluateAppearanceRequest(f.world, f.chat, request);
    assert.equal(result.status, 'delayed'); assert.equal(result.earliestDay, 4);
    const middle = f.api.makeLocation('中驿', 'manual', true); f.world.catalog.locations.push(middle);
    f.world.catalog.routes.push(
        { id: 'fast:1', fromId: f.north.id, toId: middle.id, durationDays: 1, confirmed: true },
        { id: 'fast:2', fromId: middle.id, toId: f.south.id, durationDays: 1, confirmed: true },
        { id: 'unconfirmed', fromId: f.north.id, toId: f.south.id, durationDays: 1, confirmed: false },
    );
    assert.equal(f.api.findRoute(f.world, f.north.id, f.south.id).durationDays, 2);
    const state = f.chat.npcStates[f.npc.id]; state.mobility = 'unknown';
    assert.equal(f.api.evaluateAppearanceRequest(f.world, f.chat, request).status, 'needs_info');
    state.mobility = 'free'; state.travelRate = null;
    assert.equal(f.api.evaluateAppearanceRequest(f.world, f.chat, request).status, 'needs_info');
    state.travelRate = 1;
    f.chat.parties.push({ id: 'group', members: [f.npc.id, f.friend.id], locationId: f.north.id });
    f.chat.npcStates[f.friend.id].travelRate = 0.5;
    result = f.api.evaluateAppearanceRequest(f.world, f.chat, { ...request, deadlineDay: 0 });
    assert.equal(result.durationDays, 4, 'party moves at its slowest member');
    f.chat.npcStates[f.friend.id].activityLock = { active: true, reason: '闭关' };
    assert.equal(f.api.evaluateAppearanceRequest(f.world, f.chat, request).status, 'blocked');
    assert.equal(f.api.validateTransition(f.world, f.chat, [f.npc.id], f.south.id).code, 'party_split');
});

test('travel scheduling/ETA: require motivation/current revision, no instant move, arrival remains separate from scene', () => {
    const f = fixture(); route(f);
    const request = { id: 'request', type: 'appearance_request', npcId: f.npc.id,
        targetLocationId: f.south.id, stateRevision: f.chat.stateRevision, status: 'travel_required' };
    f.chat.appearanceRequests.push(request);
    assert.throws(() => f.api.confirmTravelPlan(request.id), /意愿|动机/);
    request.motivationDecision = 'accept'; request.stateRevision--;
    assert.throws(() => f.api.confirmTravelPlan(request.id), /状态已变化/);
    request.stateRevision = f.chat.stateRevision;
    f.api.confirmTravelPlan(request.id);
    const plan = f.chat.travelPlans[0];
    assert.equal(plan.arrivalDay, 4); assert.equal(plan.status, 'in_transit');
    assert.equal(plan.visibility, 'backstage'); assert.deepEqual(plan.knownBy, []);
    assert.equal(f.chat.npcStates[f.npc.id].locationId, f.north.id);
    assert.equal(f.chat.npcStates[f.npc.id].scene, 'away');
    assert.throws(() => f.api.confirmTravelPlan(request.id), /状态已变化|重复/);
    f.chat.day = 3; assert.equal(f.api.advanceTravelPlans(f.world, f.chat).length, 0);
    assert.equal(plan.remainingDays, 1);
    f.chat.day = 4; assert.equal(f.api.advanceTravelPlans(f.world, f.chat).length, 1);
    assert.equal(plan.status, 'arrival_ready'); assert.equal(f.chat.npcStates[f.npc.id].scene, 'away');
    assert.equal(f.chat.npcStates[f.npc.id].locationId, f.north.id, 'ETA alone does not confirm destination');
    assert.equal(f.api.advanceTravelPlans(f.world, f.chat).length, 0, 'arrival not emitted twice');
});

test('simulation validator rejects teleport, unknown/unconfirmed entities, locks, present, fresh, archived and partial parties', () => {
    const f = fixture();
    const event = eventFor(f);
    const validate = raw => f.api.validateSimulationEvents(f.world, f.chat, [raw], new Set([f.npc.id, f.friend.id]));
    assert.equal(validate(event).length, 1);
    for (const bad of [
        { locationId: f.south.id }, { locationId: 'unknown' }, { npcIds: ['npc:foreign'] },
        { participants: ['npc:foreign'] },
    ]) assert.equal(validate({ ...event, ...bad }).length, 0);
    for (const [key, value] of [['locked', true], ['activityLock', { active: true }], ['mobility', 'immobile'], ['scene', 'present'], ['updatedDay', 1]]) {
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
    const f = fixture(); f.friend.tracked = false;
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
    const f = fixture(); f.friend.tracked = false;
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
    const f = fixture(); f.friend.tracked = false;
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

test('no eligible NPCs still advance travel without generation; unstable chat identity blocks simulation', async () => {
    const f = fixture(); route(f);
    f.npc.tracked = f.friend.tracked = false;
    f.chat.travelPlans.push({ id: 'trip', npcIds: [f.npc.id], targetLocationId: f.south.id,
        lastProgressDay: 1, arrivalDay: 2, status: 'in_transit' });
    await f.api.simulateDay();
    assert.equal(f.chat.day, 2); assert.equal(f.chat.travelPlans[0].status, 'arrival_ready');
    assert.equal(f.chat.npcStates[f.npc.id].scene, 'away'); assert.equal(f.calls.requests.length, 0);
    f.ctx.chatId = undefined;
    await assert.rejects(f.api.simulateDay(), /稳定聊天标识/);
    assert.equal(f.calls.requests.length, 0);
});

test('scene gestures are presentation only and use the configured player name; preference saves do not invalidate state', async () => {
    const f = fixture();
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

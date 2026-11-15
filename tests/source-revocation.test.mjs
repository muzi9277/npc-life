import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLedger, recordActivity, recordTrace, recordDiscovery, revokeBySourceKeys, isDiscoveredCanon } from '../activity-ledger.js';

test('editing any source in a multi-message activity revokes that activity, trace and discovery', () => {
    const ledger = createLedger();
    recordActivity(ledger, { id: 'act-1', npcIds: ['qing'], phase: 'done', summary: '阿青搜查北塔', source: 'story', sourceKeys: ['user-key', 'assistant-key'], committed: true });
    recordTrace(ledger, { id: 'trace-1', activityId: 'act-1', npcIds: ['qing'], traceType: 'search', summary: '北塔留下搜查痕迹', source: 'story', sourceKeys: ['user-key', 'assistant-key'], committed: true });
    recordDiscovery(ledger, { id: 'found-1', traceId: 'trace-1', knowledge: 'found', source: 'story', sourceKeys: ['user-key', 'assistant-key'] });

    const result = revokeBySourceKeys(ledger, ['assistant-key']);

    assert.equal(result.activities, 1);
    assert.equal(result.traces, 1);
    assert.equal(result.discoveries, 1);
    assert.equal(ledger.activities[0].status, 'revoked');
    assert.equal(ledger.traces[0].status, 'revoked');
    assert.equal(ledger.discoveries[0].status, 'revoked');
    assert.equal(isDiscoveredCanon(ledger, 'trace-1'), false);
});

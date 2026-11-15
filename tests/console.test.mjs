import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { mountConsole } from '../console.js';

test('精简面板导出 mountConsole，不再包含五页手机式控制台', async () => {
    const source = await readFile(new URL('../console.js', import.meta.url), 'utf8');
    assert.match(source, /export function mountConsole/);
    assert.match(source, /3\.3\.0-sync/);
    assert.doesNotMatch(source, /const TABS = \['动态', '联系人', '地图', '档案', '设置'\]/);
    assert.doesNotMatch(source, /generateDiary/);
    assert.doesNotMatch(source, /testSecondaryProfile/);
    assert.doesNotMatch(source, /importMap/);
    assert.match(source, /名册/);
    assert.match(source, /近期结算结果/);
    assert.match(source, /活动与痕迹资料库/);
    assert.match(source, /高级设置（下载即可用，一般不用改）/);
    assert.match(source, /偶遇概率/);
    assert.match(source, /世界书条数上限/);
    assert.doesNotMatch(source, /默认同步分钟/);
});

test('没有 jQuery 或 adapter 时明确失败', () => {
    const previous = globalThis.jQuery;
    globalThis.jQuery = undefined;
    try {
        assert.throws(() => mountConsole({}), /jQuery/);
    } finally {
        globalThis.jQuery = previous;
    }
});

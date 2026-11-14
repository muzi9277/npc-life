import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture, TYPES, settle} from './auto.test.mjs';
assert.ok(process.env.ST_ROOT, 'Set ST_ROOT to the SillyTavern root');
const {Window} = await import(process.env.UI_HAPPY_DOM || 'happy-dom');
const {EventEmitter} = await import(pathToFileURL(path.join(process.env.ST_ROOT,'public/lib/eventemitter.js')).href);
const window = new Window({url:'http://localhost/'}), document=window.document;
window.confirm=()=>true;
globalThis.localStorage = window.localStorage;
document.body.innerHTML='<div id="extensions_settings2"></div>';
window.eval(fs.readFileSync(path.join(process.env.ST_ROOT,'public/lib/jquery-3.5.1.min.js'),'utf8'));
const $=window.$,bus=new EventEmitter();
const f=fixture({$,bus,window,document});
f.api.init();
assert.equal(document.querySelectorAll('#npc-life-auto-enabled').length,1);
const toggle=document.querySelector('#npc-life-auto-enabled');toggle.checked=true;$(toggle).trigger('change');
assert.equal(f.api.settings().enabled,true);
$('#npc-life-auto-name').val('顾宁').trigger('change');assert.equal(f.api.state().npcName,'顾宁');
$('#npc-life-auto-name').val('青灯会组织').trigger('change');assert.equal(f.api.state().npcName,'顾宁');
$('#npc-life-auto-name').val('').trigger('change');
$('#npc-life-auto-rate').val('999').trigger('change');assert.equal(f.api.state().minutes,120);
$('#npc-life-auto-every').val('0').trigger('change');assert.equal(f.api.state().every,1);
$('#npc-life-auto-rate').val('1').trigger('change');
await f.add();f.tick();await settle();assert.equal(f.calls.length,1);assert.equal(f.api.state().turns.length,1);
assert.match($('#npc-life-auto-history').text(),/叶青/);
await bus.emit(TYPES.GENERATION_STARTED,'normal',{},false);assert.equal(f.prompts.get('npc_life_auto'),'');
await bus.emit(TYPES.GENERATION_AFTER_COMMANDS,'normal',{},false);assert.match(f.prompts.get('npc_life_auto'),/需要药/);
f.c.chat.push({mes:'我独自在远处扎营。',is_user:true});await bus.emit(TYPES.MESSAGE_SENT,2);assert.equal(f.prompts.get('npc_life_auto'),'');
f.api.state().paused='虚构错误';f.api.resume();assert.equal(f.api.state().paused,'');assert.equal(f.calls.length,1);
f.api.state().paused='需要恢复';$('#npc-life-auto-resume').trigger('click');assert.equal(f.api.state().count,0);
const before=f.api.settings();await assert.rejects(f.api.importBackup({size:1,text:async()=>'{"bad":1}'}));assert.equal(f.api.settings(),before);
$('#npc-life-auto-rebuild').trigger('click');assert.equal(f.api.state().logs.length,0);
f.prompts.set('npc_life_auto','old');toggle.checked=false;$(toggle).trigger('change');assert.equal(f.prompts.get('npc_life_auto'),'');
assert.match($('#npc-life-auto-status').text(),/已关闭/);
assert.equal(document.querySelectorAll('.inline-drawer-content .inline-drawer-content').length,1);
console.log('PASS real EventEmitter + installed jQuery DOM: toggle, inputs, bounded run, prompt lifecycle, pause/resume, invalid import, rebuild, duplicate init');

if(process.env.UI_LAYOUT==='1') {
    const {chromium}=await import(process.env.UI_PLAYWRIGHT||'playwright');
    const browser=await chromium.launch({channel:'msedge',headless:true});
    try {
        const page=await browser.newPage();
        const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');
        const html=document.querySelector('.npc-life-auto-settings').outerHTML;
        await page.setContent(`<style>body{margin:0}.text_pole{box-sizing:border-box}.inline-drawer-content{display:block}.menu_button{padding:6px} ${css}</style>${html}`);
        for(const width of [279,360,560]) {
            await page.setViewportSize({width,height:800});
            const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
            assert.equal(overflow,false,`horizontal overflow at ${width}`);
        }
        console.log('PASS Edge layout: 279/360/560 px without horizontal overflow');
    } finally {await browser.close()}
}
window.happyDOM.abort();

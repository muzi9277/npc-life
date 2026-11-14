// 运行：ST_ROOT=/path/to/SillyTavern bun ./tests/console.test.mjs；也支持 node --test。需已有 happy-dom 与 playwright。
// 默认执行 DOM 回归；UI_LAYOUT=1 时另用本机 Edge 执行断网布局检查。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as nodeTest } from 'node:test';
// Bun 普通脚本支持会话已有依赖解析，Node 则使用标准测试运行器。
const cases = [];
const test = typeof Bun === 'undefined' ? nodeTest : (name, options, fn) => { cases.push({name,options:typeof options === 'function' ? {} : options,fn:fn || options}); };
// 无 package.json 的仓库可用 UI_HAPPY_DOM / UI_PLAYWRIGHT 传入现有依赖的模块 URL。
const { Window } = await import(process.env.UI_HAPPY_DOM || 'happy-dom');
const project = fileURLToPath(new URL('../', import.meta.url));
const stRoot = process.env.ST_ROOT;
if (!stRoot) throw new Error('请设置 ST_ROOT 指向 SillyTavern 根目录，以加载本机 public/lib/jquery-3.5.1.min.js；测试不下载依赖或联网。');
const jquery = await readFile(resolve(stRoot, 'public/lib/jquery-3.5.1.min.js'), 'utf8');
const consoleSource = await readFile(resolve(project, 'console.js'), 'utf8');
const consoleCss = await readFile(resolve(project, 'console.css'), 'utf8');
const fixture = () => ({identity:'a',day:4,npcs:[{id:'a',name:'角色甲',confirmed:true},{id:'b',name:'角色乙',confirmed:true}],archivedNpcs:[],locations:[{id:'l',name:'地点',confirmed:true,tags:['old']}],preferences:{userName:'保存的名字',diaryChars:800,secondaryProfileId:'p',routes:{analysis:'main'},templates:{chat:'旧模板'}},profiles:[{id:'p',name:'profile',model:'mock',preset:'P'}],diaries:[{id:'d',npcId:'a',day:1,text:'旧日记'}],events:[],conversations:{a:[{role:'user',content:'历史'}]}});

test('beta.2 草稿、身份隔离、归档历史、弹窗和工作台监听器', async () => {
 const win = new Window({url:'http://localhost/',settings:{enableJavaScriptEvaluation:true}});
 win.document.body.innerHTML='<button id="entry">entry</button><div id="top-settings-holder"></div>';
 win.eval(jquery);
 Object.assign(globalThis,{window:win,document:win.document,localStorage:win.localStorage,innerWidth:1440,innerHeight:1000});
 const {mountConsole}=await import('../console.js');
 let snap=fixture(), calls=[],pendingTest,pendingDiary;
 const wb=win.document.createElement('div');wb.className='npc-life-settings';wb.innerHTML='<button id="legacy">legacy</button>';win.document.body.append(wb);let legacy=0;win.jQuery(wb).on('click','#legacy',()=>legacy++);
 const adapter={snapshot:()=>structuredClone(snap),getWorkbench:()=>wb,savePreferences:async p=>{calls.push(['save',p]);snap.preferences={...snap.preferences,...p}},setLocationTags:async(id,value)=>{snap.locations[0].tags=value.split(',')},importMap:async()=>true,archiveNpc:async(id,ignored)=>{calls.push(['archive',id,ignored]);const n=snap.npcs.find(n=>n.id===id);snap.npcs=snap.npcs.filter(n=>n.id!==id);snap.archivedNpcs.push({...n,ignored})},restoreNpc:async id=>{snap.npcs.push(snap.archivedNpcs.find(n=>n.id===id));snap.archivedNpcs=snap.archivedNpcs.filter(n=>n.id!==id)},testSecondaryProfile:()=>new Promise(r=>pendingTest=r),generateDiary:()=>new Promise(r=>pendingDiary=r)};
 const app=mountConsole(adapter),q=s=>win.document.querySelector(s),qa=s=>[...win.document.querySelectorAll(s)],click=s=>{assert.ok(q(s),s);q(s).focus();q(s).click()},tab=name=>qa('.nlc-tabs button').find(b=>b.textContent===name).click(),input=(s,v,type='input')=>{q(s).value=v;q(s).dispatchEvent(new win.Event(type,{bubbles:true}))},flush=()=>new Promise(r=>setTimeout(r,0)),esc=()=>win.document.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 try {
  assert.equal(q('.nlc').hidden,true);assert.equal(q('.nlc').style.width,'560px');assert.equal(q('.nlc').style.height,'640px');assert.equal(localStorage.getItem('npc-life:console:v1'),null);q('#entry').focus();app.open();assert.equal(qa('.nlc-tabs button').length,5);
  tab('设置');input('[data-field="userName"]','草稿');input('[data-template="chat"]','模板草稿');q('[data-pref]').checked=true;q('[data-pref]').dispatchEvent(new win.Event('change',{bubbles:true}));input('[data-task="analysis"]','secondary','change');
  tab('地图');assert.equal(q('.nlc-map'),null);input('[data-field="map-json"]','{"hello":1}');input('[data-tags]','草稿标签');tab('设置');app.render();assert.equal(q('[data-field="userName"]').value,'草稿');assert.equal(q('[data-template="chat"]').value,'模板草稿');assert.equal(q('[data-pref]').checked,true);assert.equal(q('[data-task="analysis"]').value,'secondary');click('[data-action="cancel-preferences"]');assert.equal(q('[data-field="userName"]').value,'保存的名字');assert.equal(q('[data-template="chat"]').value,'旧模板');input('[data-field="userName"]','新保存');click('[data-action="save-preferences"]');await flush();assert.equal(snap.preferences.userName,'新保存');
  tab('地图');assert.equal(q('[data-field="map-json"]').value,'{"hello":1}');assert.equal(q('[data-tags]').value,'草稿标签');click('[data-action="save-tags"]');await flush();assert.deepEqual(snap.locations[0].tags,['草稿标签']);input('[data-tags]','不保存');click('[data-action="cancel-tags"]');assert.equal(q('[data-tags]').value,'草稿标签');click('[data-action="cancel-map"]');assert.equal(q('[data-field="map-json"]').value,'');
  tab('联系人');click('[data-npc="a"]');assert.equal(q('[data-custom-chars]').hidden,true);input('[data-field="diary-chars"]','custom','change');assert.equal(q('[data-custom-chars]').hidden,false);input('[data-field="diary-custom"]','777');input('[data-field="chat-text"]','甲的草稿');click('[data-npc="b"]');assert.equal(q('[data-field="chat-text"]').value,'');input('[data-field="chat-text"]','乙的草稿');click('[data-npc="a"]');assert.equal(q('[data-field="chat-text"]').value,'甲的草稿');assert.equal(q('[data-field="diary-custom"]').value,'777');q('[data-field="chat-text"]').focus();q('[data-field="chat-text"]').setSelectionRange(1,2);app.render();assert.equal(win.document.activeElement,q('[data-field="chat-text"]'));assert.equal(q('[data-field="chat-text"]').selectionStart,1);
  click('[data-action="archive-npc"]');assert.ok(q('.nlc-channel-body').textContent.includes('不会删除'));assert.equal(calls.filter(x=>x[0]==='archive').length,0);esc();assert.equal(app.isOpen(),true);assert.equal(q('.nlc-channel-overlay').hidden,true);
  click('[data-action="ignore-npc"]');assert.ok(q('.nlc-channel-body').textContent.includes('阻止后续自动重新加入'));click('[data-confirm-archive]');await flush();assert.deepEqual(calls.find(x=>x[0]==='archive'),['archive','a',true]);assert.equal(snap.diaries.length,1);assert.equal(snap.conversations.a.length,1);tab('档案');assert.ok(qa('[data-field="archive-npc"] option').some(n=>n.value==='a'));click('[data-action="restore-npc"]');await flush();assert.equal(snap.npcs.length,2);
  tab('设置');click('[data-action="edit-secondary-profile"]');assert.equal(qa('.nlc-channel-dialog input').length,0);assert.equal(q('[data-channel-manager]'),null);click('[data-channel-test]');pendingTest({name:'mock',result:'OK'});await flush();assert.ok(q('[data-channel-status]').textContent.includes('测试通过'));q('[data-channel-done]').focus();q('[data-channel-done]').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));assert.equal(win.document.activeElement,q('[data-channel-close]'));esc();assert.equal(win.document.activeElement,q('[data-action="edit-secondary-profile"]'));
  click('[data-action="edit-secondary-profile"]');click('[data-channel-test]');esc();pendingTest({result:'旧弹窗结果'});await flush();click('[data-action="edit-secondary-profile"]');assert.equal(q('[data-channel-status]').textContent.includes('旧弹窗结果'),false);esc();
  input('[data-field="userName"]','旧身份草稿');tab('联系人');click('[data-npc="a"]');click('[data-action="diary"]');snap={...snap,identity:'b',preferences:{...snap.preferences,userName:'新身份'},npcs:[{id:'a',name:'新角色',confirmed:true}]};app.render();click('[data-npc="a"]');input('[data-field="chat-text"]','新身份草稿');pendingDiary('旧日记结果');await flush();assert.equal(q('[data-field="chat-text"]').value,'新身份草稿');tab('设置');assert.equal(q('[data-field="userName"]').value,'新身份');
  tab('动态');click('#legacy');assert.equal(legacy,1);tab('设置');assert.equal(wb.isConnected,false);tab('动态');click('#legacy');assert.equal(legacy,2);click('[data-close]');assert.equal(win.document.activeElement,q('#entry'));globalThis.innerWidth=360;globalThis.innerHeight=700;app.open();assert.equal(q('.nlc').style.width,'344px');assert.ok(parseFloat(q('.nlc').style.height)<=680);
 } finally {app.destroy();assert.ok(wb.isConnected);q('#legacy').click();assert.equal(legacy,3);assert.equal(q('.nlc-channel-overlay'),null);await win.happyDOM.close();}
});

test('实际 root 宽度布局、按钮单行、无溢出与默认尺寸', {skip:process.env.UI_LAYOUT!=='1'}, async () => {
 const {chromium}=await import(process.env.UI_PLAYWRIGHT || 'playwright');
 const browser=await chromium.launch({headless:true,channel:process.env.UI_BROWSER_CHANNEL || 'msedge'});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.route('**/*',route=>route.abort());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<style>body{background:#222;color:#eee}.menu_button{display:flex;flex-direction:column;width:100%;white-space:normal;word-break:break-all}</style><div id="top-settings-holder"></div>');await page.addStyleTag({content:consoleCss});await page.addScriptTag({content:jquery});await page.addScriptTag({content:consoleSource.replace('export function mountConsole','window.mountConsole = function mountConsole')});
  await page.evaluate(snap=>{window.consoleApp=window.mountConsole({snapshot:()=>structuredClone(snap),getWorkbench:()=>null,testSecondaryProfile:async()=>({result:'OK'})});window.consoleApp.open('contacts')},fixture());await page.locator('.nlc-roster button').first().click();
  assert.deepEqual(await page.locator('.nlc').evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})),{width:560,height:640});
  for (const width of [360,480,720]) {
   await page.locator('.nlc').evaluate((el,width)=>{el.style.width=`${width}px`},width);
   const m=await page.evaluate(()=>{const root=document.querySelector('.nlc'),roster=root.querySelector('.nlc-roster').getBoundingClientRect(),detail=root.querySelector('.nlc-detail').getBoundingClientRect(),pages=root.querySelector('.nlc-pages');return{rosterBottom:roster.bottom,rosterRight:roster.right,detailTop:detail.top,detailLeft:detail.left,overflow:root.scrollWidth-root.clientWidth,pagesOverflow:pages.scrollWidth-pages.clientWidth,buttons:[...root.querySelectorAll('.menu_button')].map(el=>({text:el.textContent,whiteSpace:getComputedStyle(el).whiteSpace,shrink:getComputedStyle(el).flexShrink,overflow:el.scrollWidth-el.clientWidth}))}});
   if(width<=600) assert.ok(m.detailTop>=m.rosterBottom,`${width}px root must stack contacts`);else assert.ok(m.detailLeft>m.rosterRight);
   assert.ok(m.overflow<=1);assert.ok(m.pagesOverflow<=1);assert.ok(m.buttons.every(b=>b.whiteSpace==='nowrap'&&b.shrink==='0'&&b.overflow<=1),JSON.stringify(m.buttons));
  }
  for (const viewport of [{width:360,height:740},{width:279,height:1351}]) {
   await page.setViewportSize(viewport);await page.evaluate(()=>window.consoleApp.open('contacts'));
   const mobile=await page.locator('.nlc').evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,tabsOverflow:el.querySelector('.nlc-tabs').scrollWidth-el.querySelector('.nlc-tabs').clientWidth,pagesOverflow:el.querySelector('.nlc-pages').scrollWidth-el.querySelector('.nlc-pages').clientWidth}));
   assert.equal(mobile.width,viewport.width-16);assert.ok(mobile.height<=680);assert.ok(mobile.tabsOverflow<=1);assert.ok(mobile.pagesOverflow<=1);
  }
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});

for (const item of cases) { if (item.options.skip) { console.log(`SKIP ${item.name}（UI_LAYOUT=1 启用）`); continue; } await item.fn(); console.log(`PASS ${item.name}`); }

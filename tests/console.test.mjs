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

test('beta.3 草稿、身份隔离、归档历史、弹窗和工作台监听器', async () => {
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
  tab('设置');input('[data-field="userName"]','草稿');input('[data-template="chat"]','模板草稿');q('[data-pref="memoryEnabled"]').checked=true;q('[data-pref="memoryEnabled"]').dispatchEvent(new win.Event('change',{bubbles:true}));input('[data-task="analysis"]','secondary','change');
  tab('地图');assert.equal(q('.nlc-map'),null);input('[data-field="map-json"]','{"hello":1}');input('[data-tags]','草稿标签');tab('设置');app.render();assert.equal(q('[data-field="userName"]').value,'草稿');assert.equal(q('[data-template="chat"]').value,'模板草稿');assert.equal(q('[data-pref="memoryEnabled"]').checked,true);assert.equal(q('[data-task="analysis"]').value,'secondary');click('[data-action="cancel-preferences"]');assert.equal(q('[data-field="userName"]').value,'保存的名字');assert.equal(q('[data-template="chat"]').value,'旧模板');input('[data-field="userName"]','新保存');click('[data-action="save-preferences"]');await flush();assert.equal(snap.preferences.userName,'新保存');
  tab('地图');assert.equal(q('[data-field="map-json"]').value,'{"hello":1}');assert.equal(q('[data-tags]').value,'草稿标签');click('[data-action="save-tags"]');await flush();assert.deepEqual(snap.locations[0].tags,['草稿标签']);input('[data-tags]','不保存');click('[data-action="cancel-tags"]');assert.equal(q('[data-tags]').value,'草稿标签');click('[data-action="cancel-map"]');assert.equal(q('[data-field="map-json"]').value,'');
  tab('联系人');click('[data-npc="a"]');assert.equal(q('[data-custom-chars]').hidden,true);input('[data-field="diary-chars"]','custom','change');assert.equal(q('[data-custom-chars]').hidden,false);input('[data-field="diary-custom"]','777');input('[data-field="chat-text"]','甲的草稿');click('[data-npc="b"]');assert.equal(q('[data-field="chat-text"]').value,'');input('[data-field="chat-text"]','乙的草稿');click('[data-npc="a"]');assert.equal(q('[data-field="chat-text"]').value,'甲的草稿');assert.equal(q('[data-field="diary-custom"]').value,'777');q('[data-field="chat-text"]').focus();q('[data-field="chat-text"]').setSelectionRange(1,2);app.render();assert.equal(win.document.activeElement,q('[data-field="chat-text"]'));assert.equal(q('[data-field="chat-text"]').selectionStart,1);
  click('[data-action="archive-npc"]');assert.ok(q('.nlc-channel-body').textContent.includes('不会删除'));assert.ok(q('.nlc-channel-body').textContent.includes('扫描不会自动恢复'));assert.equal(calls.filter(x=>x[0]==='archive').length,0);esc();assert.equal(app.isOpen(),true);assert.equal(q('.nlc-channel-overlay').hidden,true);
  click('[data-action="ignore-npc"]');assert.ok(q('.nlc-channel-body').textContent.includes('阻止后续自动重新加入'));click('[data-confirm-archive]');await flush();assert.deepEqual(calls.find(x=>x[0]==='archive'),['archive','a',true]);assert.equal(snap.diaries.length,1);assert.equal(snap.conversations.a.length,1);tab('档案');assert.ok(qa('[data-field="archive-npc"] option').some(n=>n.value==='a'));click('[data-action="restore-npc"]');await flush();assert.equal(snap.npcs.length,2);
  tab('设置');click('[data-action="edit-secondary-profile"]');assert.equal(qa('.nlc-channel-dialog input').length,0);assert.equal(q('[data-channel-manager]').textContent,'新增/管理连接');click('[data-channel-test]');pendingTest({name:'mock',result:'OK'});await flush();assert.ok(q('[data-channel-status]').textContent.includes('测试通过'));q('[data-channel-done]').focus();q('[data-channel-done]').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));assert.equal(win.document.activeElement,q('[data-channel-close]'));esc();assert.equal(win.document.activeElement,q('[data-action="edit-secondary-profile"]'));
  click('[data-action="edit-secondary-profile"]');click('[data-channel-test]');esc();pendingTest({result:'旧弹窗结果'});await flush();click('[data-action="edit-secondary-profile"]');assert.equal(q('[data-channel-status]').textContent.includes('旧弹窗结果'),false);esc();
  input('[data-field="userName"]','旧身份草稿');tab('联系人');click('[data-npc="a"]');click('[data-action="diary"]');snap={...snap,identity:'b',preferences:{...snap.preferences,userName:'新身份'},npcs:[{id:'a',name:'新角色',confirmed:true}]};app.render();click('[data-npc="a"]');input('[data-field="chat-text"]','新身份草稿');pendingDiary('旧日记结果');await flush();assert.equal(q('[data-field="chat-text"]').value,'新身份草稿');tab('设置');assert.equal(q('[data-field="userName"]').value,'新身份');
  tab('动态');click('#legacy');assert.equal(legacy,1);tab('设置');assert.equal(wb.isConnected,false);tab('动态');click('#legacy');assert.equal(legacy,2);click('[data-close]');assert.equal(win.document.activeElement,q('#entry'));globalThis.innerWidth=360;globalThis.innerHeight=700;app.open();assert.equal(q('.nlc').style.width,'344px');assert.ok(parseFloat(q('.nlc').style.height)<=680);
 } finally {app.destroy();assert.ok(wb.isConnected);q('#legacy').click();assert.equal(legacy,3);assert.equal(q('.nlc-channel-overlay'),null);await win.happyDOM.close();}
});

test('beta.3 连接管理、空态与失效选择、自动偏好和记录', async () => {
 const win=new Window({url:'http://localhost/',settings:{enableJavaScriptEvaluation:true}});win.eval(jquery);
 Object.assign(globalThis,{window:win,document:win.document,localStorage:win.localStorage,innerWidth:1440,innerHeight:1000});
 const {mountConsole}=await import('../console.js');let snap=fixture(),calls=[],managerError='',bubbled=0,managerState;
 snap.profiles=[];
 const adapter={snapshot:()=>structuredClone(snap),openConnectionManager:()=>{managerState={rootHidden:q('.nlc').hidden,dialogHidden:q('.nlc-channel-overlay').hidden,inert:q('.nlc').hasAttribute('inert')};calls.push('manager');if(managerError)throw new Error(managerError)},savePreferences:async p=>{calls.push(['save',p]);snap.preferences={...snap.preferences,...p}},pauseAutomation:async()=>{calls.push('pause');snap.automation.enabled=false;snap.automation.status='disabled'},resetAutomation:async()=>{calls.push('reset');snap.automation.count=0;snap.automation.error='';snap.automation.pending=false}};
 const app=mountConsole(adapter),q=s=>win.document.querySelector(s),qa=s=>[...win.document.querySelectorAll(s)],click=s=>{assert.ok(q(s),s);q(s).click()},input=(s,v)=>{q(s).value=v;q(s).dispatchEvent(new win.Event('input',{bubbles:true}))},check=(s,v)=>{q(s).checked=v;q(s).dispatchEvent(new win.Event('change',{bubbles:true}))},flush=()=>new Promise(r=>setTimeout(r,0));
 win.document.body.addEventListener('click',()=>bubbled++);
 try {
  app.open('settings');assert.equal(q('.nlc-version').textContent,'3.0.0-beta.3');assert.equal(q('[data-pref="autoEnabled"]').checked,false);assert.equal(q('[data-field="autoEveryReplies"]').value,'5');assert.equal(q('[data-field="autoEveryReplies"]').min,'1');assert.equal(q('[data-field="autoEveryReplies"]').max,'100');
  assert.equal(q('[data-action="manage-connections"]').textContent,'新增/管理连接');assert.ok(q('[data-profile-empty]'));assert.equal(q('[data-profile-error]'),null);assert.equal(q('[data-field="secondaryProfileId"]').value,'p');assert.equal(q('[data-field="secondaryProfileId"] option[value="p"]').disabled,true);
  const guide=q('.nlc-connection-guide');assert.equal(guide.querySelectorAll('li').length,5);assert.ok(guide.textContent.includes('API 抽屉'));assert.ok(guide.textContent.includes('切回原来的主 profile'));assert.ok(guide.textContent.includes('不能保证'));guide.open=true;
  input('[data-field="userName"]','连接草稿');input('[data-template="analysis"]','分析草稿');input('[data-task="analysis"]','secondary');check('[data-pref="autoEnabled"]',true);input('[data-field="autoEveryReplies"]','7');
  snap.profileError='权限不足';click('[data-action="refresh-profiles"]');assert.ok(q('[data-profile-error]').textContent.includes('权限不足'));assert.equal(q('[data-profile-empty]'),null);assert.equal(q('[data-field="userName"]').value,'连接草稿');assert.equal(q('[data-field="secondaryProfileId"]').value,'p');assert.equal(q('.nlc-connection-guide').open,true);
  click('[data-action="save-preferences"]');await flush();assert.equal(snap.preferences.secondaryProfileId,'p');assert.equal(snap.preferences.autoEnabled,true);assert.equal(snap.preferences.autoEveryReplies,7);assert.equal(snap.preferences.templates.analysis,'分析草稿');assert.equal(snap.preferences.routes.analysis,'secondary');
  for(const invalid of ['0','101','1.5','']){input('[data-field="autoEveryReplies"]',invalid);const saves=calls.filter(Array.isArray).length;click('[data-action="save-preferences"]');await flush();assert.equal(calls.filter(Array.isArray).length,saves);assert.ok(q('.nlc-status.is-error'));}
  click('[data-action="cancel-preferences"]');assert.equal(q('[data-field="autoEveryReplies"]').value,'7');
  input('[data-field="userName"]','管理器草稿');managerError='管理器打开失败';const before=bubbled;click('[data-action="manage-connections"]');await flush();assert.deepEqual(managerState,{rootHidden:true,dialogHidden:true,inert:false});assert.equal(bubbled,before);assert.equal(app.isOpen(),true);assert.ok(q('.nlc-status.is-error').textContent.includes(managerError));assert.equal(q('[data-field="userName"]').value,'管理器草稿');
  click('[data-action="edit-secondary-profile"]');assert.equal(q('[data-channel-test]').disabled,true);managerError='';const beforeModal=bubbled;click('[data-channel-manager]');await flush();assert.equal(bubbled,beforeModal);assert.deepEqual(managerState,{rootHidden:true,dialogHidden:true,inert:false});assert.equal(app.isOpen(),false);
  snap.profileError='';snap.profiles=[{id:'p',name:'恢复的 profile',model:'mock'},{id:'q',name:'新副连接',model:'mock'}];app.open('settings');click('[data-action="refresh-profiles"]');assert.equal(q('[data-field="userName"]').value,'管理器草稿');assert.equal(q('[data-field="secondaryProfileId"]').value,'p');assert.equal(q('[data-field="secondaryProfileId"] option[value="p"]').disabled,false);input('[data-field="secondaryProfileId"]','q');snap.profiles=[];click('[data-action="refresh-profiles"]');assert.equal(q('[data-field="secondaryProfileId"]').value,'q');assert.equal(q('[data-field="secondaryProfileId"] option[value="q"]').disabled,true);
  check('[data-pref="autoEnabled"]',false);input('[data-field="autoEveryReplies"]','12');app.open('overview');assert.ok(q('[data-auto-notes="latest"]').textContent.includes('暂无自动记录'));assert.ok(q('[data-automation-status]').textContent.includes('已关闭'));
  snap.automation={enabled:true,count:4,every:7,status:'waiting_busy',error:'测试错误',pending:true,unsupported:true};snap.busy=true;
  snap.autoNotes=[{id:'old',npcId:'a',npcName:'角色甲',day:2,kind:'gesture',text:'旧动作',ts:1,sourceKey:'1'},{id:'b-note',npcId:'b',npcName:'角色乙',day:4,kind:'activity',text:'乙的活动',ts:3,sourceKey:'2'},{id:'new',npcId:'a',npcName:'角色甲',day:4,kind:'psychology',text:'<img src=x onerror=alert(1)>\n新侧写',ts:5,sourceKey:'3'}];app.render();
  assert.ok(q('[data-automation-status]').textContent.includes('4 / 7'));assert.ok(q('[data-automation-status]').textContent.includes('等待其他任务结束'));assert.ok(q('[data-automation]').textContent.includes('有待处理'));assert.ok(q('[data-automation]').textContent.includes('测试错误'));assert.ok(q('[data-automation]').textContent.includes('当前宿主不支持'));assert.deepEqual(qa('[data-note-id]').map(n=>n.getAttribute('data-note-id')),['new','b-note','old']);assert.equal(q('[data-note-id="new"] img'),null);
  click('[data-action="pause-automation"]');await flush();assert.ok(calls.includes('pause'));assert.equal(q('[data-action="pause-automation"]').disabled,true);click('[data-action="reset-automation"]');await flush();assert.ok(calls.includes('reset'));assert.ok(q('[data-automation-status]').textContent.includes('0 / 7'));
  app.open('contacts');click('[data-npc="a"]');assert.deepEqual(qa('[data-note-id]').map(n=>n.getAttribute('data-note-id')),['new','old']);click('[data-npc="b"]');assert.deepEqual(qa('[data-note-id]').map(n=>n.getAttribute('data-note-id')),['b-note']);snap.autoNotes=[];app.render();assert.ok(q('[data-auto-notes="b"]').textContent.includes('此联系人暂无自动记录'));
  app.open('settings');assert.equal(q('[data-pref="autoEnabled"]').checked,false);assert.equal(q('[data-field="autoEveryReplies"]').value,'12');assert.equal(q('[data-field="userName"]').value,'管理器草稿');click('[data-action="cancel-preferences"]');assert.equal(q('[data-pref="autoEnabled"]').checked,true);assert.equal(q('[data-field="autoEveryReplies"]').value,'7');
 }finally{app.destroy();await win.happyDOM.close();}
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
   for(const tab of ['settings','overview']) {
    await page.evaluate(tab=>window.consoleApp.open(tab),tab);
    const added=await page.locator('.nlc-pages').evaluate(el=>({overflow:el.scrollWidth-el.clientWidth,buttons:[...el.querySelectorAll('.menu_button')].map(b=>({text:b.textContent,overflow:b.scrollWidth-b.clientWidth,whiteSpace:getComputedStyle(b).whiteSpace}))}));
    assert.ok(added.overflow<=1,`${width}px ${tab} overflow`);assert.ok(added.buttons.every(b=>b.overflow<=1&&b.whiteSpace==='nowrap'),JSON.stringify(added.buttons));
   }
   await page.evaluate(()=>window.consoleApp.open('contacts'));
  }
  for (const viewport of [{width:360,height:740},{width:279,height:1351}]) {
   await page.setViewportSize(viewport);await page.evaluate(()=>window.consoleApp.open('contacts'));
   const mobile=await page.locator('.nlc').evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,tabsOverflow:el.querySelector('.nlc-tabs').scrollWidth-el.querySelector('.nlc-tabs').clientWidth,pagesOverflow:el.querySelector('.nlc-pages').scrollWidth-el.querySelector('.nlc-pages').clientWidth}));
   assert.equal(mobile.width,viewport.width-16);assert.ok(mobile.height<=680);assert.ok(mobile.tabsOverflow<=1);assert.ok(mobile.pagesOverflow<=1);
   await page.evaluate(()=>window.consoleApp.open('settings'));await page.locator('.nlc-pages .nlc-connection-guide summary').click();
   assert.ok(await page.locator('.nlc-pages').evaluate(el=>el.scrollWidth-el.clientWidth<=1));
   await page.locator('[data-action="edit-secondary-profile"]').click();
   assert.ok(await page.locator('.nlc-channel-dialog').evaluate(el=>el.scrollWidth-el.clientWidth<=1));
   assert.equal(await page.locator('.nlc-channel-dialog input').count(),0);
   await page.locator('[data-channel-close]').click();
  }
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});

for (const item of cases) { if (item.options.skip) { console.log(`SKIP ${item.name}（UI_LAYOUT=1 启用）`); continue; } await item.fn(); console.log(`PASS ${item.name}`); }

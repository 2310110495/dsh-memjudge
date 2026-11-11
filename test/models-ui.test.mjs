import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Isolated hook driver: executes the actual registered settings component.
// No host, network, secrets or database is opened.
const source = fs.readFileSync(process.env.UI_SOURCE || new URL('../client.js', import.meta.url), 'utf8');
const ids = ['chat', 'embed', 'rerank'];
const titles = ['对话模型', '向量模型', '重排模型'];
function config() {
  return { flags: {}, envLockedSettings: {}, groups: Object.fromEntries(ids.map(id => [id, {
    mode: 'independent', migrationRequired: false, enabled: true,
    baseUrl: 'https://' + id + '.invalid/v1', model: id + '-model',
    baseUrlSource: 'config', modelSource: 'config', keySource: 'none',
    keyConfigured: false, keyEnvLocked: false, inheritedEnv: {},
  }])) };
}
async function harness(cfg = config(), responder) {
  let states = [], cursor = 0, effects = [], tree, panel, exported, dirty;
  const calls = [];
  const react = {
    createElement(type, props, ...children) { return {type, props: {...props, children}}; },
    useState(init) { const i=cursor++; if (!(i in states)) states[i]=typeof init==='function'?init():init;
      return [states[i], v=>{states[i]=typeof v==='function'?v(states[i]):v; dirty=true;}]; },
    useRef(init) { const i=cursor++; return states[i] ||= {current:init}; },
    useCallback(fn, deps) { const i=cursor++; const old=states[i];
      if (!old || deps.some((v,j)=>v!==old.deps[j])) states[i]={fn,deps}; return states[i].fn; },
    useEffect(fn, deps) { const i=cursor++; const old=states[i];
      if (!old || deps.some((v,j)=>v!==old.deps[j])) { states[i]={deps}; effects.push(fn); } },
  };
  function expand(n) {
    if (Array.isArray(n)) return n.map(expand).flat();
    if (!n || typeof n!=='object') return n;
    if (typeof n.type==='function') return expand(n.type(n.props));
    return {...n, props:{...n.props, children:expand(n.props.children)}};
  }
  // 面板改用同源 Fetch 路由后，唯一的下行口是全局 fetch：
  // 这里按 /api/memjudge.<endpoint> 解析端点，把 responder 的返回包当成 JSON 响应体。
  const fetch = async (url, opts) => {
    const endpoint = String(url).replace(/^.*\/api\/memjudge\./, '');
    const payload = opts && opts.body ? JSON.parse(opts.body) : {};
    try {
      return { ok: true, status: 200, json: async () => await rpc(endpoint, payload) };
    } catch (err) {
      return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'call', message: String(err && err.message ? err.message : err) } }) };
    }
  };
  vm.runInNewContext(source, {window:{__ModuleLoader__:{load({factory}){exported=factory(()=>react);}}},
    document:{getElementById(){return true;}}, console:{log(){}}, setTimeout(){return 1;},clearTimeout(){}, fetch});
  const rpc = async (name, payload) => {
    calls.push({name,payload:JSON.parse(JSON.stringify(payload))});
    const r=responder && await responder(name,payload,cfg); if(r!==undefined) return r;
    if(name==='status') return {ok:true,value:{config:structuredClone(cfg),stats:{}}};
    if(name==='memories') return {ok:true,value:{rows:[]}};
    if(name==='conflicts') return {ok:true,value:{conflicts:[]}};
    if(name==='saveSettings') for(const [k,v] of Object.entries(payload.settings)) {
      const id=ids.find(g=>k.startsWith(g)); if(id) {
        const prop=k.slice(id.length); cfg.groups[id][prop==='Mode'?'mode':prop==='BaseUrl'?'baseUrl':'model']=v;
        if(prop==='Mode') cfg.groups[id].migrationRequired=false;
      }
    }
    if(name==='saveKey') cfg.groups[payload.group].keyConfigured=true;
    if(name==='clearKey') {cfg.groups[payload.group].keyConfigured=false; cfg.groups[payload.group].mode='independent';}
    return {ok:true,value:{ok:true,latencyMs:1}};
  };
  exported.apply({connection:{rpc:{call:rpc}},effect(fn,label){if(label.includes('settings section'))fn();},
    slots:{inject(_,fn){return fn();},register(_,render){panel=render();}}});
  async function flush(){ for(let i=0;i<40;i++){if(i===0||dirty){dirty=false;cursor=0;tree=expand(panel);const pending=effects;effects=[];pending.forEach(f=>f());} await Promise.resolve();} }
  function all(pred,n=tree){if(Array.isArray(n))return n.flatMap(x=>all(pred,x));if(!n||typeof n!=='object')return [];return [...(pred(n)?[n]:[]),...all(pred,n.props.children)];}
  function text(n=tree){if(Array.isArray(n))return n.map(text).join('');if(n==null||typeof n==='boolean')return '';return typeof n==='object'?text(n.props.children):String(n);}
  function one(pred){const ns=all(pred);assert.equal(ns.length,1,'expected one element');return ns[0];}
  const api={calls,cfg,all,text,flush,one,
    field(label){return one(n=>n.props['aria-label']===label);},
    async change(label,value){const n=this.field(label);assert.ok(!n.props.disabled);n.props.onChange({target:{value}});await flush();},
    async click(label,group){let scope=group?one(n=>n.props['data-group']===group):tree;
      const ns=all(n=>n.type==='button'&&(n.props['aria-label']===label||text(n)===label),scope);assert.equal(ns.length,1,label);
      assert.ok(!ns[0].props.disabled,label+' disabled');ns[0].props.onClick();await flush();},
    async remount(){states=[];await flush();},
  };
  await flush();return api;
}
test('three groups have independent modes; chat never offers inherit or legacy',async()=>{
 const h=await harness();for(let i=0;i<3;i++) {const n=h.field(titles[i]+' 模式');assert.equal(n.props.value,'independent');const values=h.all(x=>x.type==='option',n).map(x=>x.props.value);assert.ok(!values.includes('legacy'));assert.equal(values.includes('inherit'),i!==0);}
});
test('mode save is sparse and persisted on remount',async()=>{
 const h=await harness();await h.change('向量模型 模式','inherit');await h.click('保存');assert.deepEqual(h.calls.find(x=>x.name==='saveSettings').payload,{settings:{embedMode:'inherit'}});await h.remount();assert.equal(h.field('向量模型 模式').props.value,'inherit');assert.equal(h.field('对话模型 模式').props.value,'independent');
});
test('untouched and blank endpoint drafts do not clear config',async()=>{
 const h=await harness();await h.click('保存');await h.change('对话模型 接口地址','');await h.click('保存');assert.equal(h.calls.filter(x=>x.name==='saveSettings').length,0);
});
test('explicit endpoint clear sends empty string only for that group',async()=>{
 const h=await harness();await h.click('清空向量模型 接口地址');await h.click('保存');assert.deepEqual(h.calls.find(x=>x.name==='saveSettings').payload,{settings:{embedBaseUrl:''}});
});
test('blank key input tests current key by omitting key and cannot save',async()=>{
 const h=await harness();await h.click('测试连接','chat');assert.deepEqual(h.calls.find(x=>x.name==='testKey').payload,{group:'chat'});assert.ok(h.all(n=>n.type==='button'&&h.text(n)==='保存密钥').every(n=>n.props.disabled));
});
test('three independent unsaved keys are routed only to selected group',async()=>{
 const h=await harness();for(let i=0;i<3;i++)await h.change(titles[i]+' 密钥','fixture-'+ids[i]);for(const id of ids)await h.click('测试连接',id);assert.deepEqual(h.calls.filter(x=>x.name==='testKey').map(x=>x.payload),ids.map(group=>({group,key:'fixture-'+group})));
});
test('save key clears input; explicit clear is double confirmed',async()=>{
 const h=await harness();await h.change('对话模型 密钥','fixture-chat');await h.click('保存密钥','chat');assert.equal(h.calls.filter(x=>x.name==='saveKey').length,1);await h.click('清除','chat');assert.equal(h.calls.filter(x=>x.name==='clearKey').length,0);await h.click('确认清除','chat');assert.equal(h.calls.filter(x=>x.name==='clearKey').length,1);assert.equal(h.field('对话模型 密钥').props.value,'');
});
test('disabled group cannot test, edit or save key',async()=>{
 const cfg=config();cfg.groups.embed.mode='disabled';const h=await harness(cfg);const scope=h.one(n=>n.props['data-group']==='embed');assert.ok(h.all(n=>n.type==='button'&&h.text(n)==='测试连接',scope)[0].props.disabled);assert.ok(h.field('向量模型 密钥').props.disabled);assert.ok(h.text().includes('已禁用'));assert.equal(h.calls.filter(x=>x.name==='testKey').length,0);
});
test('environment and inherited source locks are visible',async()=>{
 const cfg=config();Object.assign(cfg.groups.chat,{keyEnvLocked:true,keyEnv:'MEMJUDGE_CHAT_KEY',baseUrlEnv:'MEMJUDGE_CHAT_BASE_URL'});Object.assign(cfg.groups.embed,{mode:'inherit',keyInherited:true,keyConfigured:true,inheritedEnv:{key:'MEMJUDGE_CHAT_KEY',baseUrl:'MEMJUDGE_CHAT_BASE_URL'}});const h=await harness(cfg);assert.ok(h.field('对话模型 密钥').props.disabled);assert.ok(h.field('对话模型 接口地址').props.disabled);assert.ok(h.field('向量模型 接口地址').props.disabled);assert.ok(h.text().includes('继承源环境锁'));
});
test('legacy is display-only and migrates through explicit selection',async()=>{
 const cfg=config();cfg.groups.chat.mode='legacy';cfg.groups.chat.migrationRequired=true;const h=await harness(cfg);assert.ok(h.text().includes('legacy'));assert.equal(h.field('对话模型 模式').props.value,'');await h.change('对话模型 模式','independent');await h.click('保存');assert.deepEqual(h.calls.find(x=>x.name==='saveSettings').payload,{settings:{chatMode:'independent'}});
});
for(const [kind,response] of [['outer',{ok:false,error:{code:'missing-key',message:'SECRET_BODY'}}],['inner',{ok:true,value:{ok:false,code:'http-error',message:'SECRET_BODY'}}]]) {
 test(kind+' test failure is not success and does not echo provider text',async()=>{const h=await harness(config(),name=>name==='testKey'?response:undefined);await h.click('测试连接','chat');assert.ok(h.text().includes('连接失败'));assert.ok(!h.text().includes('SECRET_BODY'));assert.ok(!h.text().includes('连接正常'));});
 test(kind+' save failure is not success and preserves draft',async()=>{const h=await harness(config(),name=>name==='saveSettings'?response:undefined);await h.change('向量模型 模式','disabled');await h.click('保存');assert.ok(h.text().includes('保存失败'));assert.ok(!h.text().includes('SECRET_BODY'));assert.equal(h.field('向量模型 模式').props.value,'disabled');});
}
test('initial status failure hides exception and supports retry',async()=>{
 let failing=true;const h=await harness(config(),name=>name==='status'&&failing?{ok:false,error:{message:'SECRET_BODY'}}:undefined);
 assert.ok(!h.text().includes('SECRET_BODY'));assert.ok(h.text().includes('配置读取失败'));failing=false;
 const retry=h.all(n=>n.type==='button'&&h.text(n).includes('重试'))[0];assert.ok(retry);retry.props.onClick();await h.flush();assert.equal(h.field('对话模型 模式').props.value,'independent');
});
test('explicit model clear and inheritance endpoint clear are persisted',async()=>{
 const cfg=config();cfg.groups.embed.mode='inherit';const h=await harness(cfg);await h.click('清空向量模型 接口地址');await h.click('清空重排模型 模型名');await h.click('保存');assert.deepEqual(h.calls.find(x=>x.name==='saveSettings').payload,{settings:{embedBaseUrl:'',rerankModel:'',embedMode:'independent'}});await h.remount();assert.equal(h.field('向量模型 模式').props.value,'independent');assert.equal(h.field('重排模型 模型名').props.value,'');
});
test('all three endpoint and model edits remain independent',async()=>{
 const h=await harness();for(let i=0;i<3;i++){await h.change(titles[i]+' 接口地址','https://new-'+ids[i]+'.invalid/v1');await h.change(titles[i]+' 模型名','new-'+ids[i]);}await h.click('保存');const expected={};for(const id of ids){expected[id+'BaseUrl']='https://new-'+id+'.invalid/v1';expected[id+'Model']='new-'+id;}assert.deepEqual(h.calls.find(x=>x.name==='saveSettings').payload,{settings:expected});
});
test('saving a key inner failure retains input and reports failure',async()=>{
 const h=await harness(config(),name=>name==='saveKey'?{ok:true,value:{ok:false,code:'http-error',message:'SECRET_BODY'}}:undefined);await h.change('对话模型 密钥','fixture-key');await h.click('保存密钥','chat');assert.equal(h.field('对话模型 密钥').props.value,'fixture-key');assert.ok(h.text().includes('保存失败'));assert.ok(!h.text().includes('SECRET_BODY'));
});
test('clear key outer failure leaves masked state intact',async()=>{
 const cfg=config();cfg.groups.chat.keyConfigured=true;const h=await harness(cfg,name=>name==='clearKey'?{ok:false,error:{code:'bad-request',message:'SECRET_BODY'}}:undefined);await h.click('清除','chat');await h.click('确认清除','chat');assert.ok(h.text().includes('清除失败'));assert.ok(!h.text().includes('SECRET_BODY'));assert.ok(h.field('对话模型 密钥掩码'));
});
test('save acknowledgement followed by status failure is not shown as success',async()=>{
 let saved=false;const h=await harness(config(),name=>{if(name==='saveSettings'){saved=true;return {ok:true,value:{}};}if(name==='status'&&saved)return {ok:false,error:{message:'SECRET_BODY'}};});await h.change('向量模型 模式','disabled');await h.click('保存');assert.ok(h.text().includes('配置读取失败'));assert.ok(!h.text().includes('已保存。'));assert.ok(!h.text().includes('SECRET_BODY'));
});
test('mode pending blocks old-config test until save',async()=>{const h=await harness();await h.change('向量模型 模式','disabled');const scope=h.one(n=>n.props['data-group']==='embed');assert.ok(h.all(n=>n.type==='button'&&h.text(n)==='测试连接',scope)[0].props.disabled);assert.equal(h.calls.filter(c=>c.name==='testKey').length,0);});
test('rejected test RPC hides exception body',async()=>{const h=await harness(config(),name=>{if(name==='testKey')throw Error('SECRET_BODY');});await h.click('测试连接','chat');assert.ok(h.text().includes('连接失败'));assert.ok(!h.text().includes('SECRET_BODY'));});

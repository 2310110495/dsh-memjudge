import test from 'node:test';
import assert from 'node:assert/strict';
import {open} from '../src/store.mjs';
import {gate, gateSlots} from '../src/judge.mjs';
import {extractSlots} from '../src/slots.mjs';
import {shouldDenyRecall} from '../src/index.mjs';
const q='星河项目的重试次数是3吗？';
const cases=[
 ['星河项目的重试次数是3。',q,false],
 ['星河项目的重试次数不是3。',q,true],
 ['在开发环境下，星河项目的重试次数是3。',q,true],
 ['在开发环境下星河项目的重试次数是3。',q,true],
 ['在开发环境下，星河项目的重试次数是3。','在开发环境下星河项目的重试次数是3吗？',false],
 ['在开发环境下，星河项目的重试次数是3。','在生产环境下星河项目的重试次数是3吗？',true],
 ['星河项目的重试次数不超过3。',q,true],
 ['星河项目的重试次数不超过3。','星河项目的重试次数是多少？',false],
 ['乙项目的次数不超过3。星河项目的重试次数是3。',q,false],
];
for(const [text,query,deny] of cases)test('indexed positive slot cannot override quote: '+query+' / '+text,()=>{
 const s=open(':memory:');try{s.put({text,slots:[{entity:'星河项目',attr:'重试次数',value:'3',polarity:1,quote:text}]});assert.equal(gateSlots(query,s).deny,deny);}finally{s.close();}
});
test('negative polarity is rejected in exact-value index fast path',()=>{const s=open(':memory:');try{s.put({text:'星河项目的重试次数不是3。',slots:[{entity:'星河项目',attr:'重试次数',value:'3',polarity:-1}]});assert.equal(gateSlots(q,s).deny,true);}finally{s.close();}});
test('extractor keeps grounded comma-separated condition on quote',()=>{const text='在开发环境下，星河项目的重试次数是3。';const slots=extractSlots(text);assert.ok(slots.length);assert.ok(slots.every(r=>r.quote.includes('在开发环境下')&&text.includes(r.quote)));});
test('bound denial wins, but grounded no-facts window recovery remains supported',()=>{const hit={deny:false,reason:'hit',hits:[{memoryId:'m'}]};assert.equal(shouldDenyRecall({deny:true,reason:'value-not-recorded',evidenceBound:true},hit),true);assert.equal(shouldDenyRecall({deny:true,reason:'no-facts'},hit),false);assert.equal(shouldDenyRecall({deny:true,reason:'no-facts'},{...hit,hits:[]}),true);});

for (const prefix of ['- ', '* ', '+ ', '• ', '> ', '> - ', '1. ']) for (const comma of ['，', '']) {
 test('markdown condition stays grounded: '+prefix+' comma='+Boolean(comma),()=>{
  const text=prefix+'在开发环境下'+comma+'星河项目的重试次数是3。';
  const slots=extractSlots(text);
  assert.ok(slots.length);
  assert.ok(slots.every(s=>s.quote.includes('在开发环境下')&&text.includes(s.quote)));
  const s=open(':memory:');try{
   s.put({text,slots});
   for(const query of [q,'在生产环境下星河项目的重试次数是3吗？']){
    assert.equal(gate(query,text).deny,true);
    assert.equal(gateSlots(query,s).deny,true);
   }
   const query='在开发环境下星河项目的重试次数是3吗？';
   assert.equal(gate(query,text).deny,false);
   assert.equal(gateSlots(query,s).deny,false);
  }finally{s.close();}
 });
}
for(const reverse of [false,true])test('distinct conditional proofs survive persistence, reverse='+reverse,()=>{
 const conditional='在开发环境下，星河项目的重试次数是3。';
 const unconditional='星河项目的重试次数是3。';
 for(const other of [unconditional,'在生产环境下，星河项目的重试次数是3。']){
  const parts=[conditional,other];if(reverse)parts.reverse();const text=parts.join('');
  const slots=extractSlots(text);assert.equal(slots.length,2);
  const s=open(':memory:');try{
   s.put({text,slots});
   assert.equal(gateSlots(q,s).deny,other!==unconditional);
   for(const environment of ['开发','生产'])assert.equal(gateSlots('在'+environment+'环境下星河项目的重试次数是3吗？',s).deny,false);
  }finally{s.close();}
 }
});

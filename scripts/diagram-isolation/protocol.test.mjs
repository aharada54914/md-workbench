import test from 'node:test';
import assert from 'node:assert/strict';
import {receiver,envelope,LIMITS} from '../../src-tauri/src/diagram_spike/protocol.mjs';
const session='a'.repeat(32), source={}, origin='http://mdwdiagramfixture.localhost';
const make=(extra={})=>receiver({source,origin,session,steps:[{seq:0,kinds:['ready']},{seq:2,kinds:['candidate','cancel']}],...extra});
const event=(data,extra={})=>({source,origin,data,...extra});
test('fixed ready and candidate accepted exactly once',()=>{
 const g=make(); assert.equal(g.receive(event(envelope(session,0,'ready'))).status,'accepted');
 assert.equal(g.receive(event(envelope(session,2,'candidate','fixed'))).value.text,'fixed');
 assert.equal(g.receive(event(envelope(session,2,'candidate','fixed'))).reason,'sequence');
 assert.equal(g.receive(event(envelope(session,0,'ready'))).status,'retired');
});
test('cancel is terminal valid outcome',()=>{
 const g=make();g.receive(event(envelope(session,0,'ready')));
 assert.equal(g.receive(event(envelope(session,2,'cancel'))).status,'accepted');
});
test('source, sibling, foreign and opaque origin ignored before data access',()=>{
 for(const extra of [{source:{}},{origin:'https://foreign.invalid'},{origin:'null'},{origin:origin+'.evil'}]){
  const e=event(null,extra); Object.defineProperty(e,'data',{get(){throw Error('must not parse')}});
  const g=make();assert.equal(g.receive(e).status,'ignored');assert.equal(g.receive(event(envelope(session,0,'ready'))).status,'accepted');
 }
});
test('unsupported peer identity and nonce cannot initialize',()=>{
 for(const extra of [{origin:'null'},{origin:''},{source:null},{session:'old'}]) assert.throws(()=>make(extra),/unsupported_session/);
});
test('closed schema, malformed and non-string reject selected peer',()=>{
 const good=JSON.parse(envelope(session,0,'ready'));
 for(const data of [null,{},'null','[]','{',JSON.stringify({...good,extra:true}),JSON.stringify({...good,text:''}),
  JSON.stringify({...good,seq:-1}),JSON.stringify({...good,seq:0.5}),JSON.stringify({...good,seq:32}),
  JSON.stringify({...good,v:2}),JSON.stringify({...good,session:'b'.repeat(32)}),JSON.stringify({...good,kind:'save'}),
  '{"__proto__":{},"v":1,"session":"'+session+'","seq":0,"kind":"ready"}',
  JSON.stringify({...good,kind:'candidate',text:{value:'x'}}),'['.repeat(1000)+']'.repeat(1000)]){
  assert.equal(make().receive(event(data)).status,'rejected');
 }
});
test('sequence reversal and old generation reject',()=>{
 assert.equal(make().receive(event(envelope(session,2,'candidate','x'))).reason,'sequence');
 const g=make();g.retire();assert.equal(g.receive(event(envelope(session,0,'ready'))).status,'retired');
 assert.equal(make({session:'b'.repeat(32)}).receive(event(envelope(session,0,'ready'))).reason,'schema');
});
test('deadline is exact and checked independently of valid payload',()=>{
 let time=0;const g=make({now:()=>time});time=LIMITS.timeout;
 assert.equal(g.receive(event(envelope(session,0,'ready'))).reason,'timeout');
});
test('UTF8 text limit exact and plus one including multibyte',()=>{
 for(const text of ['x'.repeat(LIMITS.text),'é'.repeat(LIMITS.text/2)]){
 const g=make();g.receive(event(envelope(session,0,'ready')));assert.equal(g.receive(event(envelope(session,2,'candidate',text))).status,'accepted');
 const h=make();h.receive(event(envelope(session,0,'ready')));assert.equal(h.receive(event(envelope(session,2,'candidate',text+'a'))).reason,'schema');
 }
});
test('envelope fast and UTF8 bounds, cumulative and count are enforced',()=>{
 assert.equal(make().receive(event('x'.repeat(LIMITS.envelope+1))).reason,'envelope');
 assert.equal(make().receive(event('é'.repeat(LIMITS.envelope))).reason,'budget');
 const data=envelope(session,0,'ready'), size=new TextEncoder().encode(data).length;
 assert.equal(make({limits:{...LIMITS,cumulative:size}}).receive(event(data)).status,'accepted');
 assert.equal(make({limits:{...LIMITS,cumulative:size-1}}).receive(event(data)).reason,'budget');
 assert.equal(make({limits:{...LIMITS,messages:0}}).receive(event(data)).reason,'budget');
});

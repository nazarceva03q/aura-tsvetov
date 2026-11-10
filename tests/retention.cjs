'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRetention, TTL, RECEIPT_TTL } = require('../bot/src/retention');
const { createPrivateDb } = require('../bot/src/privateDb');
function fixture(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k,v]) => [k,{ data: structuredClone(v), etag: 1 }]));
  const cfg = { bucket: 'synthetic' };
  let version = 1, failWrite = false, failGet = false;
  const calls = [];
  const transport = {
    async getVersioned(c,k) { if(failGet)throw Error('DOWN');return data.has(k)?structuredClone(data.get(k)):null; },
    async putConditional(c,k,v,etag) { if(failWrite)throw Error('DOWN');const current=data.get(k);if((current?.etag)!==etag)return false;data.set(k,{data:structuredClone(v),etag:++version});return true; },
    async removePrivate(c,k) { calls.push(['delete',k]);data.delete(k); },
    async listPrivate(c,prefix,after) { const keys=[...data.keys()].filter(k=>k.startsWith(prefix)&&k>(after||'')).sort();return {keys:keys.slice(0,2),more:keys.length>2}; }
  };
  let clock = Date.parse('2026-01-01T00:00:00Z'), deleteOK = true;
  const make = () => createRetention({db:createPrivateDb(cfg,transport,''),now:()=>clock,pause:async()=>{},removeMessage:async mid=>{calls.push(['max',mid]);return deleteOK;}});
  return {data,calls,make,transport,cfg,get time(){return clock},advance:n=>{clock+=n},deleteFails:()=>{deleteOK=false},failWrites:()=>{failWrite=true},failReads:()=>{failGet=true}};
}
const sent = mid => ({ok:true,status:200,body:{message:{body:{mid}}}});

test('30-day boundary: all own personal files purged, catalogs and dedup untouched; all tracked messages removed',async()=>{
 const f=fixture(),t=f.time;
 for(const name of ['customers','questions','sessions'])f.data.set(name+'.json',{data:{person:{name:'SYNTHETIC',createdAt:t,expiresAt:t+TTL}},etag:1});
 f.data.set('leads.json',{data:[{createdAt:t,expiresAt:t+TTL,phone:'synthetic'}],etag:1});
 f.data.set('catalog.json',{data:{products:['keep']},etag:1});f.data.set('processed_updates/keep.json',{data:{claimedAt:t},etag:1});
 const r=f.make();for(let i=0;i<5;i++)await r.send(async()=>sent('mid'+i),'send'+i);
 f.advance(TTL-1);assert.equal((await r.cleanup({apply:true})).cloudRemoved,0);assert(!f.calls.some(c=>c[0]==='max'));
 f.advance(1);const result=await r.cleanup({apply:true});assert.equal(result.cloudRemoved,4);assert.equal(result.maxDeleted,5);assert(f.data.has('catalog.json'));assert(f.data.has('processed_updates/keep.json'));assert.deepEqual(f.data.get('leads.json').data,[]);
});
test('preview mutates no payload, removes no MAX messages',async()=>{
 const f=fixture({'leads.json':[{createdAt:0,phone:'synthetic'}]});const r=f.make();await r.send(async()=>sent('mid'),'send');f.advance(TTL);const s=await r.cleanup({apply:false});assert.equal(s.cloudRemoved,1);assert.equal(s.messagesDue,1);assert.equal(f.data.get('leads.json').data.length,1);assert.equal(f.calls.length,0);
});
test('separate instances cannot lose parallel updates to legacy JSON files',async()=>{
 const f=fixture();const a=createPrivateDb(f.cfg,f.transport,''),b=createPrivateDb(f.cfg,f.transport,'');await Promise.all([a.update('questions.json',old=>({...old,a:{}})),b.update('questions.json',old=>({...old,b:{}}))]);assert.deepEqual(Object.keys(f.data.get('questions.json').data).sort(),['a','b']);
});
test('send intent is durable before external call; replay keeps expiry and conflict rejects',async()=>{
 const f=fixture();let sends=0;const work=async()=>{assert([...f.data.values()].some(r=>r.data.state==='intent'));sends++;return sent('same')};const a=f.make(),b=f.make();const results=await Promise.allSettled([a.send(work,'same',{fingerprint:'a'}),b.send(work,'same',{fingerprint:'a'})]);assert.equal(sends,1);assert(results.some(r=>r.status==='fulfilled'));const receipt=[...f.data.values()].find(r=>r.data.mid==='same').data;const expiry=receipt.expiresAt;f.advance(1000);await a.send(work,'same',{fingerprint:'a'});assert.equal(receipt.expiresAt,expiry);await assert.rejects(a.send(work,'same',{fingerprint:'different'}),/CONFLICT/);assert.equal(sends,1);
});
test('storage read/write failure prevents sending; unknown send is never resent blindly',async()=>{
 const f=fixture();const r=f.make();let sentCount=0;await assert.rejects(r.send(async()=>{sentCount++;throw Error('lost response')},'unknown'));await assert.rejects(r.send(async()=>{sentCount++;return sent('x')},'unknown'));assert.equal(sentCount,1);f.failWrites();await assert.rejects(r.send(async()=>{sentCount++;return sent('y')},'new'));assert.equal(sentCount,1);const g=fixture();g.failReads();await assert.rejects(g.make().send(async()=>{sentCount++;return sent('z')},'bad'));assert.equal(sentCount,1);
});
test('MAX failure never retains own payload, retries bounded, receipts expire at 37 days',async()=>{
 const f=fixture({'leads.json':[{createdAt:0,phone:'synthetic'}]});const r=f.make();await r.send(async()=>sent('failure'),'send');f.advance(TTL);f.deleteFails();for(let i=0;i<7;i++){await r.cleanup({apply:true});f.advance(86400000)}assert.deepEqual(f.data.get('leads.json').data,[]);assert.equal(f.calls.filter(c=>c[0]==='max').length,5);await r.cleanup({apply:true});assert(![...f.data.keys()].some(k=>k.startsWith('retention/messages/')));
});
test('undated legacy rows have explicit one-time migration window, not an invented received date',async()=>{
 const f=fixture({'sessions.json':{user:{phone:'synthetic'}}});const r=f.make();let s=await r.cleanup({apply:false});assert.equal(s.legacyUndated,1);assert.equal(s.cloudRemoved,0);f.advance(TTL);s=await r.cleanup({apply:true});assert.equal(s.cloudRemoved,1);assert.deepEqual(f.data.get('sessions.json').data,{});
});
test('concurrent cleanup serialized; repeated run does not resend deletes already confirmed',async()=>{
 const f=fixture();const r=f.make();await r.send(async()=>sent('mid'),'s');f.advance(TTL);await Promise.all([r.cleanup({apply:true}),f.make().cleanup({apply:true})]);await r.cleanup({apply:true});assert.equal(f.calls.filter(c=>c[0]==='max').length,1);
});
test('unknown outcome counted without contacts, partial failure recovered by following run',async()=>{
 const f=fixture();const r=f.make();await assert.rejects(r.send(async()=>{throw Error('lost')},'u'));f.advance(TTL);const s=await r.cleanup({apply:true});assert.equal(s.unknownDelivery,1);const serialized=JSON.stringify([...f.data.values()]);assert(!serialized.includes('phone'));assert(!serialized.includes('text'));
});
test('website idempotency returns same acceptance and rejects conflicting content without another send',async()=>{
 const f=fixture(),r=f.make();let calls=0;const send=async()=>{calls++;return {ok:true}};await r.request('id','a',send);f.advance(1000);assert.equal((await r.request('id','a',send)).ok,true);assert.equal(calls,1);await assert.rejects(r.request('id','b',send),/CONFLICT/);f.advance(TTL);await assert.rejects(r.request('id','a',send),/EXPIRED/);assert.equal(calls,1);
});
test('cleanup safety scope and local versioned JSON implementation',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aura-retention-'));
 try{const db=createPrivateDb({},null,dir);await db.update('sessions.json',()=>({a:{step:'x'}}));assert.equal((await db.get('sessions.json')).data.a.step,'x');await db.update('retention/messages/a.json',()=>({x:1}));assert.deepEqual((await db.list('retention/messages/')).keys,['retention/messages/a.json']);await assert.rejects(db.remove('sessions.json'),/SCOPE/);await assert.rejects(db.get('../secret'),/PRIVATE_KEY/);await db.remove('retention/messages/a.json');assert.equal(await db.get('retention/messages/a.json'),null);}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('MAX wrapper records every send variant and validates success boolean for DELETE even on HTTP 200',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{EventEmitter}=require('node:events');const f=fixture();const responses=[];let transportCalls=0;
 const fakeHttps={Agent:class{},request(options,cb){transportCalls++;return {on(){},setTimeout(){},write(){},end(){const res=new EventEmitter();res.statusCode=200;cb(res);res.emit('data',Buffer.from(JSON.stringify(responses.shift())));res.emit('end')}}}};
 const dep={https:fakeHttps,fs:{readFileSync:()=>''},path:require('node:path'),tls:{rootCertificates:[]},crypto:require('node:crypto'),'./config':{botToken:'synthetic'},'./operation':require('../bot/src/operation'),'./store':{retention:f.make()}};
 const box={module:{exports:{}},__dirname:'unused',require:n=>{if(!(n in dep))throw Error(n);return dep[n]},console:{error(){},warn(){}},Buffer};vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../bot/src/maxApi.js'),'utf8'),box);const api=box.module.exports;
 for(const [method,args] of [['sendMessage',[{userId:1},'SYNTHETIC']],['sendMarkdownMessage',[{userId:1},'SYNTHETIC']],['sendPhotoUrlMessage',[{userId:1},'SYNTHETIC',null,'https://example.test/photo']]]){responses.push({message:{body:{mid:'mid'+transportCalls}}});assert.equal((await api[method](...args)).ok,true)}
 assert.equal([...f.data.values()].filter(r=>r.data.mid).length,3);
 responses.push({success:false});assert.equal(await api.deleteMessage('test'),false);responses.push({success:true});assert.equal(await api.deleteMessage('test'),true);
 responses.push({ok:true});await assert.rejects(api.sendMessage({userId:1},'SYNTHETIC'),/UNKNOWN/);
});
test('an uncertain HTTP response stops photo fallback, keeping cloud receipts for later review',async()=>{
 const f=fixture(),r=f.make();await assert.rejects(r.send(async()=>({ok:false,status:503,body:{}}),'server-failure'),/UNKNOWN/);assert([...f.data.values()].some(r=>r.data.state==='unknown'));
});
test('state corruption and denied storage cannot become an empty successful cleanup',async()=>{
 const f=fixture();f.failReads();await assert.rejects(f.make().cleanup({apply:true}),/DOWN/);
});
test('failed receipt acknowledgement after MAX deletion is recovered without retaining payload',async()=>{
 const f=fixture({'leads.json':[{createdAt:0,phone:'synthetic'}]});let fail=true;const base=f.transport.putConditional;
 const r=f.make();await r.send(async()=>sent('mid'),'a');f.advance(TTL);
 f.transport.putConditional=async(c,k,v,e)=>{if(fail&&v.state==='deleted'){fail=false;throw Error('ACK_FAILED')}return base(c,k,v,e)};
 const first=await r.cleanup({apply:true});assert.equal(first.errors,1);assert.deepEqual(f.data.get('leads.json').data,[]);f.advance(86400000);const second=await r.cleanup({apply:true});assert.equal(second.errors,0);assert.equal(second.maxDeleted,1);
});
test('website retries keep request ID on the same payload; another submission receives a new ID',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');const code=html.match(/  var lastLeadFingerprint[\s\S]*?(?=\n  \/\/)/)[0];const bodies=[];
 const box={crypto,AbortController,setTimeout,clearTimeout,MAX_LEAD_WEBHOOK_URL:'https://example.test',fetch:async(u,o)=>{bodies.push(JSON.parse(o.body));return {ok:true,json:async()=>({ok:true})}}};vm.createContext(box);vm.runInContext(code,box);await box.sendToMaxBot({name:'SYNTHETIC',phone:'synthetic'});await box.sendToMaxBot({name:'SYNTHETIC',phone:'synthetic'});assert.equal(bodies[0].requestId,bodies[1].requestId);await box.sendToMaxBot({name:'SYNTHETIC-OTHER',phone:'synthetic'});assert.notEqual(bodies[0].requestId,bodies[2].requestId);
});
test('reply/profile previews can never extend the source request message lifetime',async()=>{
 const op=require('../bot/src/operation'),f=fixture(),r=f.make();await op.run('test',async()=>{const expiry=f.time+1000;op.limit(expiry);const next=op.next();await r.send(async()=>sent('profile'),next.id,{expiresAt:next.expiresAt});});const rec=[...f.data.values()].find(v=>v.data.mid==='profile').data;assert.equal(rec.expiresAt,f.time+1000);f.advance(1000);assert.equal((await r.cleanup({apply:true})).maxDeleted,1);
});

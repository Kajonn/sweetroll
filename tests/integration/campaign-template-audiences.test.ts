import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { buildI6Harness, ctxFor, type I6Harness } from './i6-app.js';
import { d20Document } from '../../src/systems/implementation/package/fixtures/index.js';
const db = process.env.TEST_DATABASE_URL ? describe : describe.skip;
function value(r:any):any { if(!r.ok) throw Error(JSON.stringify(r.error)); return r.value; }
db('restricted campaign template audiences',()=>{
 let h:I6Harness;
 beforeAll(async()=>{const document=structuredClone(d20Document);document.slots=[{id:'inventory',label:'Inventory',accepts:['item','spell','talent','effect']}];document.sheets[0]!.sections[0]!.elements.push({kind:'slot',id:'inventory_element',slotId:'inventory'});h=await buildI6Harness({document});});
 afterAll(async()=>{await h?.close()});
 async function setup(){const id=value(await h.campaigns.create(ctxFor(h.users.gm),{systemVersionId:h.versionId,title:'Secret drafts',description:'',idempotencyKey:randomUUID()})).campaignId;for(const who of ['player','other'] as const)await h.pool.query("INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,'player','active',1)",[id,h.users[who].actorId]);return id;}
 async function request(id:string,who:keyof I6Harness['users'],method:'GET'|'POST',suffix:string,body?:unknown){return h.app.inject({method,url:`/campaigns/${id}/${suffix}`,headers:{cookie:h.users[who].cookie},...(body===undefined?{}:{payload:body as any})});}
 async function create(id:string,audience='gm_only',grants:unknown[]=[],kind='item'){const r=await request(id,'gm','POST','item-templates',{kind,audience,grants,content:{name:'Secret key'},expectedTemplateRevision:0,idempotencyKey:randomUUID()});expect(r.statusCode,r.body).toBe(201);return r.json().template;}
 async function page(id:string,who:keyof I6Harness['users'],query=''){const r=await request(id,who,'GET','item-templates'+query);expect(r.statusCode,r.body).toBe(200);return r.json();}
 function sharing(t:any,audience:string,grants:unknown[]=[]){return {expectedTemplateRevision:t.revision,idempotencyKey:randomUUID(),audience,grants};}
 it('filters discovery and IDs, previews the real player policy and reveals atomically',async()=>{
  const id=await setup();let t=await create(id);expect((await page(id,'player')).templates).toEqual([]);expect((await request(id,'player','GET',`item-templates/${t.templateId}`)).statusCode).toBe(404);
  const r=await request(id,'gm','POST',`item-templates/${t.templateId}/sharing`,sharing(t,'selected_players',[{userId:h.users.player.actorId,generation:1}]));expect(r.statusCode,r.body).toBe(200);t=r.json().template;
  const actual=await page(id,'player');expect(actual.templates).toHaveLength(1);expect(actual.templates[0].grants).toEqual([]);expect((await page(id,'other')).templates).toEqual([]);
  const preview=await request(id,'gm','POST','item-template-preview',{targetUserId:h.users.player.actorId});expect(preview.statusCode,preview.body).toBe(200);expect(preview.json().templates).toEqual(actual.templates);
  expect((await request(id,'player','POST','item-template-preview',{targetUserId:h.users.other.actorId})).statusCode).toBe(403);
  expect((await h.pool.query("SELECT count(*)::int AS n FROM campaign_activity_events WHERE campaign_id=$1 AND kind LIKE 'template_%'",[id])).rows[0].n).toBe(0);
  const body=sharing(t,'all_players');const reveal=await request(id,'gm','POST',`item-templates/${t.templateId}/sharing`,body);expect(reveal.statusCode,reveal.body).toBe(200);expect(reveal.json().template.contentRevision).toBe(t.contentRevision);
  expect((await request(id,'gm','POST',`item-templates/${t.templateId}/sharing`,body)).json().template).toEqual(reveal.json().template);expect((await page(id,'other')).templates).toHaveLength(1);
 });
 it('binds grants to membership generation and rejects invalid/stale recipient sets',async()=>{
  const id=await setup();const t=await create(id,'selected_players',[{userId:h.users.player.actorId,generation:1}]);await h.pool.query('UPDATE campaign_members SET generation=2 WHERE campaign_id=$1 AND user_id=$2',[id,h.users.player.actorId]);expect((await page(id,'player')).templates).toEqual([]);
  for(const grants of [[],[{userId:h.users.player.actorId,generation:1}],[{userId:h.users.outsider.actorId,generation:1}],[{userId:h.users.player.actorId,generation:2},{userId:h.users.player.actorId,generation:2}]])expect((await request(id,'gm','POST',`item-templates/${t.templateId}/sharing`,sharing(t,'selected_players',grants))).statusCode).toBe(400);
  expect((await request(id,'gm','GET',`item-templates/${t.templateId}`)).json().template.revision).toBe(t.revision);
 });
 it('filters before paging and refuses another actor or preview cursor',async()=>{
  const id=await setup();await create(id);await create(id,'all_players');await create(id,'all_players');const first=await page(id,'player','?limit=1');expect(first.templates).toHaveLength(1);expect(first.nextCursor).toBeTruthy();const second=await page(id,'player','?limit=1&cursor='+first.nextCursor);expect(second.templates).toHaveLength(1);expect(second.nextCursor).toBeNull();expect((await request(id,'other','GET','item-templates?cursor='+first.nextCursor)).statusCode).toBe(400);
 });
 it('never places restricted drafts, even for GM; committed copies survive narrowing',async()=>{
  const id=await setup();const r=await request(id,'gm','POST','characters',{name:'Hero',entityDefinitionId:'character',controllerUserIds:[h.users.player.actorId],expectedCampaignRevision:1,idempotencyKey:randomUUID()});expect(r.statusCode,r.body).toBe(201);const characterId=r.json().character.characterId;
  let t=await create(id);const make=()=>({kind:'addEntry' as const,characterId,entry:{entryId:randomUUID(),slotId:'inventory',templateId:null,values:{},source:{kind:'campaign' as const,campaignId:id,templateId:t.templateId,templateRevision:t.revision,contentRevision:t.contentRevision}},expectedRevision:1,idempotencyKey:randomUUID()});
  for(const actor of [h.users.gm,h.users.player]){expect((await h.characters.apply(ctxFor(actor),make())).ok).toBe(false);expect(value(await h.characters.listEntryTemplates(ctxFor(actor),{characterId})).filter((x:any)=>x.source?.kind==='campaign')).toEqual([]);}
  const reveal=await request(id,'gm','POST',`item-templates/${t.templateId}/sharing`,sharing(t,'all_players'));t=reveal.json().template;const command=make();const placed=await h.characters.apply(ctxFor(h.users.player),command);expect(placed.ok).toBe(true);
  const narrowed=await request(id,'gm','POST',`item-templates/${t.templateId}/sharing`,sharing(t,'gm_only'));expect(narrowed.statusCode,narrowed.body).toBe(200);expect(await h.characters.apply(ctxFor(h.users.player),command)).toEqual(placed);expect((await h.characters.apply(ctxFor(h.users.gm),{...make(),expectedRevision:2})).ok).toBe(false);
 });
});

import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';

const source='https://holodori.best/tools/holomem';
const api='https://api.holodori.best';
const feed='leaderboards/v1/global.json';
const memberPattern=/^chr-\d{5}$/;
const fanPattern=/^fan_mark-[A-Za-z0-9_-]{1,151}$/;
const emblemPattern=/^emblem-[A-Za-z0-9_-]{1,153}$/;
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'});

async function readJson(response){
  if(!response.ok())throw Error(`The leaderboard page returned HTTP ${response.status()}.`);
  const bytes=await response.body();
  if(bytes.length>512_000)throw Error('The leaderboard response exceeds the supported size.');
  return JSON.parse(bytes.toString('utf8'));
}

function readMembers({holomems}){
  if(!Array.isArray(holomems)||!holomems.length||holomems.length>128||
    holomems.some(member=>!memberPattern.test(member?.id??'')||typeof member.name!=='string'||!member.name.trim())||
    new Set(holomems.map(member=>member.id)).size!==holomems.length)
    throw Error('The leaderboard roster was invalid.');
  return holomems.map(({id,name})=>({id,name}));
}

function boardFor(payload,characterId,previous){
  if(payload.region!=='us'||payload.characterId!==characterId||
    !Array.isArray(payload.rows)||!payload.rows.length||payload.rows.length>100)
    throw Error(`Invalid Global board for ${characterId}.`);
  const captured=Date.parse(payload.updatedAt);
  if(!Number.isFinite(captured)||captured>Date.now()+10*60_000||
    (previous&&captured<Date.parse(previous.capturedAt)))
    throw Error(`Invalid or older standings timestamp for ${characterId}.`);
  const rows=payload.rows.map(({rank,score,name,fanMark,emblems},index)=>{
    if(!Number.isSafeInteger(rank)||rank<1||rank>100||!Number.isSafeInteger(score)||score<0||
      typeof name!=='string'||Buffer.byteLength(name)>1024||
      (index&&rank<=payload.rows[index-1].rank))
      throw Error(`Invalid standings row for ${characterId}.`);
    const row={rank,rating:score,name};
    if(typeof fanMark?.fanMarkId==='string'&&fanPattern.test(fanMark.fanMarkId))row.fanMarkId=fanMark.fanMarkId;
    if(Array.isArray(emblems)){
      const ids=emblems.map(emblem=>emblem?.emblemId).filter(id=>typeof id==='string'&&emblemPattern.test(id));
      if(ids.length)row.emblems=ids.slice(0,16);
    }
    return row;
  });
  return {characterId,region:2,capturedAt:new Date(captured).toISOString(),rows};
}

function isGlobalBoard(response,id){
  const url=new URL(response.url());
  return url.origin===api&&url.pathname==='/api/holomem/leaderboard'&&
    url.searchParams.get('region')==='us'&&(!id||url.searchParams.get('character_id')===id);
}

async function collect(previous,probe){
  const executablePath=process.env.LEADERBOARD_CHROMIUM_PATH;
  const browser=await chromium.launch(executablePath?{executablePath}:{channel:'chromium'});
  try{
    const page=await browser.newPage({locale:'en-US'});
    await page.route('**/*',route=>['image','font','media'].includes(route.request().resourceType())?
      route.abort():route.continue());
    const [rosterResponse,firstResponse,navigation]=await Promise.all([
      page.waitForResponse(api+'/api/holomem/list',{timeout:20_000}),
      page.waitForResponse(response=>isGlobalBoard(response),{timeout:20_000}),
      page.goto(source,{waitUntil:'domcontentloaded',timeout:20_000}),
    ]);
    if(!navigation?.ok()||page.url()!==source)throw Error('The public leaderboard page is unavailable.');
    const members=readMembers(await readJson(rosterResponse));
    const first=await readJson(firstResponse);
    const dismissIntro=page.locator('.first-visit .first-visit-actions button');
    if(await dismissIntro.isVisible())await dismissIntro.click();
    if(!members.some(({id})=>id===first.characterId)||
      Object.keys(previous).some(id=>!members.some(member=>member.id===id)))
      throw Error('The current leaderboard roster omitted an existing Holomem.');
    const boards={[first.characterId]:boardFor(first,first.characterId,previous[first.characterId])};
    const pending=members.filter(member=>member.id!==first.characterId);
    for(const {id,name} of probe?pending.slice(0,1):pending){
      await delay(1000);
      await page.locator('.holomem-picker .board-picker-btn').click({timeout:12_000});
      const tile=page.locator('button.holomem-modal-chip').and(page.getByTitle(name,{exact:true}));
      const [response]=await Promise.all([
        page.waitForResponse(candidate=>isGlobalBoard(candidate,id),{timeout:15_000}),
        tile.click({timeout:12_000}),
      ]);
      boards[id]=boardFor(await readJson(response),id,previous[id]);
    }
    return boards;
  }finally{
    await browser.close();
  }
}

async function main(){
  const [mode,...extra]=process.argv.slice(2);
  if(extra.length||![undefined,'--probe'].includes(mode))throw Error('Expected an optional --probe argument.');
  const probe=mode==='--probe';
  const previous=probe?{}:JSON.parse(await fs.readFile(feed,'utf8'));
  if(!probe&&(previous.schema!==1||previous.region!=='global'||!Object.keys(previous.boards??{}).length))
    throw Error('The last Global snapshot is invalid.');
  const now=new Date();
  if(!probe&&previous.collectedAt&&day.format(new Date(previous.collectedAt))===day.format(now)){
    console.log('Global standings were already collected today.');
    return;
  }
  const boards=await collect(previous.boards??{},probe);
  console.log(`Verified ${Object.keys(boards).length} Global boards and ${Object.values(boards)
    .reduce((total,board)=>total+board.rows.length,0)} ranked rows.`);
  if(probe)return;
  const snapshot=JSON.stringify({schema:1,region:'global',collectedAt:now.toISOString(),boards})+'\n';
  if(Buffer.byteLength(snapshot)>3_000_000)throw Error('The Global snapshot exceeds the feed size limit.');
  await fs.writeFile(feed,snapshot);
}

await main();

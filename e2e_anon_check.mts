import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const R = "/Users/hrvojekolaric/Projects/poker-hand-converter";
const { convertAny } = await import(`${R}/frontend/src/lib/parsers/index.js`);
const { toStandardText } = await import(`${R}/frontend/src/lib/phf/serialize.js`);
const { handInsertFromPhf } = await import(`${R}/frontend/src/lib/db/mapping.js`);
const { detectAnonymization } = await import(`${R}/frontend/src/lib/db/anonymization.js`);

const env: Record<string,string> = {};
for (const l of readFileSync(`${R}/frontend/.env.local`,"utf8").split("\n")) {
  const i=l.indexOf("="); if(i>0&&!l.trimStart().startsWith("#")) env[l.slice(0,i).trim()]=l.slice(i+1).trim().replace(/^["']|["']$/g,"");
}
const URL=env.VITE_SUPABASE_URL, KEY=env.VITE_SUPABASE_ANON_KEY;
const H={apikey:KEY,Authorization:`Bearer ${KEY}`,"Content-Type":"application/json"};
const rpc=async(fn:string,a:unknown)=>{const r=await fetch(`${URL}/rest/v1/rpc/${fn}`,{method:"POST",headers:H,body:JSON.stringify(a)});return {status:r.status,body:await r.json().catch(()=>null)};};

function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => { const p = join(d,f); return statSync(p).isDirectory() ? walk(p) : (f.endsWith(".txt")||f.endsWith(".hand") ? [p] : []); });
}
const rows: any[] = [];
const bySite: Record<string, Record<string, number>> = {};
for (const dir of ["ignition","acr","acrwpn","ggpoker","pokerstars"]) {
  const base = `${R}/fixtures/samples/${dir}`;
  let files: string[] = []; try { files = walk(base).slice(0, 12); } catch { continue; }
  for (const f of files) {
    let res; try { res = await convertAny(readFileSync(f), { sourceFilename: f.split("/").pop()! }); } catch { continue; }
    for (const h of res.hands) {
      const a = detectAnonymization(h);
      bySite[h.meta.siteId] ??= {}; bySite[h.meta.siteId][a] = (bySite[h.meta.siteId][a]??0)+1;
      try { rows.push(handInsertFromPhf(h, toStandardText(h))); } catch {}
    }
  }
}
console.log("classification by site:", JSON.stringify(bySite));
const pos = rows.filter(r=>r.site_anonymization==="positional");
const opq = rows.filter(r=>r.site_anonymization==="opaque-id");
console.log(`rows: ${rows.length}  positional: ${pos.length}  opaque-id: ${opq.length}`);
if (pos[0]) console.log("POSITIONAL sample:", JSON.stringify({site:pos[0].site, hero_name:pos[0].hero_name, hero_position:pos[0].hero_position,
  player_names:pos[0].player_names, winners:pos[0].winners, player_positions:pos[0].player_positions,
  showdown_positions:pos[0].showdown_positions, winner_positions:pos[0].winner_positions, player_count:pos[0].player_count}));
if (opq[0]) console.log("OPAQUE sample:", JSON.stringify({site:opq[0].site, hero_name:opq[0].hero_name,
  player_names:opq[0].player_names.slice(0,4), winners:opq[0].winners, winner_positions:opq[0].winner_positions}));
const leak = pos.find(r=>r.player_names.length>0||r.winners.length>0);
console.log("INVARIANT pseudonyms never stored:", leak ? "VIOLATED" : "ok");

// save everything
let ins=0,dup=0;
for (let i=0;i<rows.length;i+=80){ const r=await rpc("save_hands",{p_hands:rows.slice(i,i+80)});
  if(r.status!==200){console.log("SAVE FAIL",r.status,JSON.stringify(r.body));break;} ins+=r.body.inserted; dup+=r.body.duplicates; }
console.log("saved:",ins,"dupes:",dup);

console.log("\n--- server rejects a lying client (positional + pseudonyms) ---");
if (pos[0]) {
  const bad = {...pos[0], hand_key: pos[0].hand_key+"-LIE", player_names:["Dealer","UTG+1"], winners:["Dealer"]};
  const r = await rpc("save_hands",{p_hands:[bad]});
  console.log(r.status, JSON.stringify(r.body).slice(0,180));
}
console.log("--- server rejects a bogus position ---");
if (rows[0]) {
  const bad = {...rows[0], hand_key: rows[0].hand_key+"-BADPOS", showdown_positions:["MIDDLE"]};
  const r = await rpc("save_hands",{p_hands:[bad]});
  console.log(r.status, JSON.stringify(r.body).slice(0,180));
}

console.log("\n--- position filters over live data ---");
for (const f of [{heroPositions:["BTN"]},{heroPositions:["BTN","CO"]},{showdownPositions:["CO"]},{winnerPositions:["BTN"]},
                 {anonymization:"positional"},{anonymization:"none"},{anonymization:"opaque-id"},
                 {heroPositions:["btn"]}, {winnerPositions:["BTN"],heroPositions:["BB"]}])
  console.log(JSON.stringify(f).padEnd(48), "=> total", (await rpc("search_hands",{p_filters:f,p_limit:1})).body.total);
const fc = (await rpc("hands_facets",{})).body;
console.log("\nfacet heroPositions:", JSON.stringify(fc.heroPositions));
console.log("facet showdownPositions:", JSON.stringify(fc.showdownPositions));
console.log("facet anonymizations:", JSON.stringify(fc.anonymizations));
const one = (await rpc("search_hands",{p_filters:{anonymization:"positional"},p_limit:1})).body.rows[0];
if (one) console.log("\nstored positional row:", JSON.stringify({site:one.site,hero_name:one.hero_name,hero_position:one.hero_position,
  player_names:one.player_names,winners:one.winners,player_positions:one.player_positions,
  winner_positions:one.winner_positions,showdown_positions:one.showdown_positions,site_anonymization:one.site_anonymization,player_count:one.player_count}));

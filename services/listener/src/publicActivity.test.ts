import {test} from "node:test";
import assert from "node:assert/strict";
import {isPublicTradeEvent,summariseSession,type SessionTrade} from "./publicActivity.js";

const t0=new Date("2026-09-06T23:09:00.000Z");
const at=(sec:number)=>new Date(t0.getTime()+sec*1000);
const buy=(sec:number,q:number,before="0",after="1000"):SessionTrade=>({action:"BUY",state:before==="0"?"BOUGHT":"ADDED",quoteAmount:q,amountUsd:q*240,observedAt:at(sec),balanceBeforeRaw:before,balanceAfterRaw:after});
const sell=(sec:number,q:number,before="1000",after="500"):SessionTrade=>({action:"SELL",state:after==="0"?"EXITED":"TRIMMED",quoteAmount:q,amountUsd:q*240,observedAt:at(sec),balanceBeforeRaw:before,balanceAfterRaw:after});

const base={walletIsAdminTracked:true,swapVerified:true};

test("hard gates: a non-admin wallet or unverified swap can never be public",()=>{
  assert.equal(isPublicTradeEvent({...base,walletIsAdminTracked:false,incoming:buy(0,1),priorTrades:[]}).push,false);
  assert.equal(isPublicTradeEvent({...base,swapVerified:false,incoming:buy(0,1),priorTrades:[]}).push,false);
  const transfer:SessionTrade={action:"TRANSFER_IN",state:"TRANSFER_IN",observedAt:at(0)};
  assert.equal(isPublicTradeEvent({...base,incoming:transfer,priorTrades:[]}).push,false);
});

test("the first verified buy of a session always alerts immediately",()=>{
  const d=isPublicTradeEvent({...base,incoming:buy(0,0.95),priorTrades:[]});
  assert.equal(d.push,true);assert.equal(d.reason,"FIRST_VERIFIED_BUY");
});

test("churn inside a live session is aggregated, not pushed",()=>{
  const prior=[buy(0,0.95),sell(2,0.9),buy(4,0.23),sell(6,0.25)];
  const d=isPublicTradeEvent({...base,incoming:buy(8,0.23,"1000","2000"),priorTrades:prior});
  assert.equal(d.push,false);assert.equal(d.aggregate,true);
  assert.equal(d.reason,"AGGREGATED_SCALPING");
});

test("a genuinely large add breaks through the throttle",()=>{
  const prior=[buy(0,0.2),buy(2,0.2)];
  const d=isPublicTradeEvent({...base,incoming:buy(4,5.0,"1000","9000"),priorTrades:prior});
  assert.equal(d.push,true);assert.equal(d.reason,"LARGE_ADD_DOUBLES_SESSION");
});

test("a full exit always breaks through, even mid-churn",()=>{
  const prior=[buy(0,0.95),sell(2,0.9),buy(4,0.23)];
  const d=isPublicTradeEvent({...base,incoming:sell(6,1.2,"1000","0"),priorTrades:prior});
  assert.equal(d.push,true);assert.equal(d.reason,"FULL_EXIT");
});

test("a 50%+ position reduction breaks through, and respects the sell-alert preference",()=>{
  const prior=[buy(0,0.95),buy(2,0.5)];
  const on=isPublicTradeEvent({...base,incoming:sell(4,1.0,"1000","400"),priorTrades:prior,sellAlertsEnabled:true});
  assert.equal(on.push,true);assert.equal(on.reason,"MAJOR_SELL_50PCT_PLUS");
  const off=isPublicTradeEvent({...base,incoming:sell(4,1.0,"1000","400"),priorTrades:prior,sellAlertsEnabled:false});
  assert.equal(off.push,false);assert.equal(off.aggregate,true);
});

test("another tracked trader entering the same mint always breaks through",()=>{
  const prior=[buy(0,0.95),sell(2,0.9),buy(4,0.23)];
  const d=isPublicTradeEvent({...base,incoming:buy(6,0.1,"1000","1100"),priorTrades:prior,otherTrackedTradersOnMint:2});
  assert.equal(d.push,true);assert.equal(d.reason,"MULTI_TRADER_CONVERGENCE");
});

test("a new session after the idle window alerts again (throttle is not permanent)",()=>{
  const prior=[buy(0,0.95),sell(2,0.9)];
  const d=isPublicTradeEvent({...base,incoming:buy(20*60,1.0),priorTrades:prior});
  assert.equal(d.push,true);assert.equal(d.reason,"FIRST_VERIFIED_BUY");
});

test("net conviction is not gross volume: 20 in / 19.5 out is SCALPING, not accumulation",()=>{
  const trades=[buy(0,10),sell(2,9.8),buy(4,10),sell(6,9.7)];
  const s=summariseSession(trades,at(8));
  assert.equal(s.behaviour,"SCALPING");
  assert.equal(s.grossQuoteBought,20);
  assert.ok(Math.abs(s.netQuoteFlow-0.5)<1e-9,"net flow must be 0.5, not 20");
  assert.ok(s.netRatio<0.5);
});

test("clean accumulation is NOT classified as scalping",()=>{
  const trades=[buy(0,5,"0","1000"),buy(60,5,"1000","2000"),buy(120,5,"2000","3000")];
  const s=summariseSession(trades,at(130));
  assert.equal(s.behaviour,"ACTIVE_ACCUMULATION");
  assert.equal(s.netQuoteFlow,15);
  assert.equal(s.roundTrips,0);
});

test("market cap is never an input -- a $4K MC entry is judged only on behaviour",()=>{
  // One clean buy at any market cap is a first verified buy and must alert.
  const d=isPublicTradeEvent({...base,incoming:buy(0,0.05),priorTrades:[]});
  assert.equal(d.push,true);
});

// The decisive production replay: the exact MARTINSHKRELI burst audited on 2026-09-06, which
// generated 40 separate pushes under the old logic. Shape reproduced from the forensic table:
// alternating BuyV2/SellV2 on one mint, ~0.24-0.95 SOL a side, all inside ~7 minutes.
test("MARTINSHKRELI production replay: 40 verified swaps produce a handful of alerts, not 40",()=>{
  const burst:SessionTrade[]=[];
  for(let i=0;i<40;i++){
    const isBuy=i%2===0;
    burst.push(isBuy
      ?{action:"BUY",state:i===0?"BOUGHT":"ADDED",quoteAmount:0.2375,amountUsd:57,observedAt:at(i*10),balanceBeforeRaw:i===0?"0":"1000",balanceAfterRaw:"2000"}
      :{action:"SELL",state:"TRIMMED",quoteAmount:0.95,amountUsd:228,observedAt:at(i*10),balanceBeforeRaw:"2000",balanceAfterRaw:"1500"});
  }
  let pushes=0;const reasons:string[]=[];
  for(let i=0;i<burst.length;i++){
    const d=isPublicTradeEvent({...base,incoming:burst[i],priorTrades:burst.slice(0,i)});
    if(d.push){pushes++;reasons.push(`#${i}:${d.reason}`)}
  }
  // Every one of the 40 is still a real, recorded, PNL-counting trade -- but the user is not
  // carpet-bombed. A small number of genuinely meaningful alerts is the target.
  assert.ok(pushes<=6,`expected a handful of pushes, got ${pushes}: ${reasons.join(", ")}`);
  assert.ok(pushes>=1,"the first verified buy must still alert");
  assert.equal(reasons[0],"#0:FIRST_VERIFIED_BUY");
  console.log(`    MARTINSHKRELI replay: 40 verified swaps -> ${pushes} public pushes (${reasons.join(", ")})`);
});

test("replaying the identical burst twice never changes the push count (idempotent decisions)",()=>{
  const trades=[buy(0,0.95),sell(2,0.9),buy(4,0.23)];
  const first=trades.map((_,i)=>isPublicTradeEvent({...base,incoming:trades[i],priorTrades:trades.slice(0,i)}).push);
  const second=trades.map((_,i)=>isPublicTradeEvent({...base,incoming:trades[i],priorTrades:trades.slice(0,i)}).push);
  assert.deepEqual(first,second);
});

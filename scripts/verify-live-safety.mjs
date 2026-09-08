#!/usr/bin/env node
import fs from "node:fs";
const read=p=>fs.readFileSync(p,"utf8");
const checks=[
 ["packages/strategy/src/tradeSettings.ts","USER_STOP_LOSS","stop-loss branch"],
 ["packages/strategy/src/tradeSettings.ts","5000))","hard slippage ceiling"],
 ["services/exits/src/index.ts","priceDrawdownFromPeakPct(Math.max(p.peakPriceUsd??entry,current),current)","correct trailing direction"],
 ["services/exits/src/index.ts","live:position-sell:","shared exit sell lock"],
 ["services/exits/src/index.ts","positionCursor","exit pagination"],
 ["services/executor/src/index.ts","live:user-entry:","user entry lock"],
 ["services/executor/src/index.ts","LIVE_EXECUTION_PENDING_RECONCILE","immediate cash reconciliation"],
 ["services/listener/src/index.ts","const tx:any=existing?.rawJson??await fetchParsedTransactionWithRetry(signature)","listener repair"],
 ["services/listener/src/index.ts","durable=await db.sourceTransaction.findFirst","durable listener cursor"],
 ["services/listener/src/index.ts",'priorSignal&&(["COMPLETED","SKIPPED"] as string[]).includes(priorSignal.status)',"historical completed-signal replay guard"],
 ["services/balance-worker/src/index.ts","DEPOSIT_TX_TEMPORARILY_UNAVAILABLE","lossless deposit cursor"],
 ["apps/api/src/providerHealth.ts","/v1/key_quorums/","Privy quorum verification"],
 ["apps/api/src/providerHealth.ts","/v1/policies/","Privy policy verification"],
 ["services/market-worker/src/index.ts","dangerousExtension:security.dangerousExtension","token security persisted"],
 ["deployment/windows/install-services.example.ps1","ensure-indexes.mjs","deployment index enforcement"],
 [".github/workflows/ci.yml","pnpm verify:live-safety","CI safety gate"]
];
let failed=0;for(const [file,needle,label] of checks){const ok=read(file).includes(needle);console.log(ok?("PASS "+label):("FAIL "+label));if(!ok)failed++}
if(failed){console.error("Live-safety invariant failures: "+failed);process.exit(1)}
console.log("Live-safety invariants passed: "+checks.length);

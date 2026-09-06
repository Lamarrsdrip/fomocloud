import {startHeartbeat} from "@memecloud/ops";
startHeartbeat("discovery-worker",()=>({status:"RETIRED",reason:"Wallet-first v1: Admin-curated wallets are the only discovery source; broad candidate/token discovery is disabled."}));
console.log("[discovery-worker] RETIRED — no provider calls, no broad token/wallet discovery");
setInterval(()=>{},60_000);

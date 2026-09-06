import {startHeartbeat} from "@memecloud/ops";
startHeartbeat("paper-worker",()=>({status:"RETIRED",reason:"Wallet-first v1: its only consumer was the retired candidate-scoring lifecycle; Admin curation replaces promotion evidence."}));
console.log("[paper-worker] RETIRED — no provider calls");
setInterval(()=>{},60_000);

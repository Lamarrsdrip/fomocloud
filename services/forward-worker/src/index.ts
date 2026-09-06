import {startHeartbeat} from "@memecloud/ops";
startHeartbeat("forward-worker",()=>({status:"RETIRED",reason:"Wallet-first v1: its only consumer was the retired candidate-scoring lifecycle; Admin curation replaces promotion evidence."}));
console.log("[forward-worker] RETIRED — no provider calls");
setInterval(()=>{},60_000);

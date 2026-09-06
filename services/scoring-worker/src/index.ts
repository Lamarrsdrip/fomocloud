import {startHeartbeat} from "@memecloud/ops";
startHeartbeat("scoring-worker",()=>({status:"RETIRED",reason:"Wallet-first v1: old candidate lifecycle/scoring is no longer a signal source."}));
console.log("[scoring-worker] RETIRED — no candidate provider calls");
setInterval(()=>{},60_000);

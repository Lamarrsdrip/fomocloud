import test from "node:test";
import assert from "node:assert/strict";
import {JupiterExecution} from "./index.js";

test("Jupiter quote is rejected when provider response changes swap intent",async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=(async()=>new Response(JSON.stringify({inputMint:"WRONG",outputMint:"B",inAmount:"100",outAmount:"90"}),{status:200,headers:{"content-type":"application/json"}})) as any;
 try{await assert.rejects(()=>new JupiterExecution("https://example.test").quote({inputMint:"A",outputMint:"B",amountRaw:"100",slippageBps:100}),(e:any)=>e?.code==="QUOTE_INTENT_MISMATCH")}finally{globalThis.fetch=original}
});

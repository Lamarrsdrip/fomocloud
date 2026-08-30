import assert from "node:assert/strict";
import test from "node:test";
import {FLOW_PROCESSING_STALE_MS,shouldQueue,shouldRecoverProcessing,terminalAfterFailure} from "./ingestion.js";

test("only unfinished ingestion states are queueable",()=>{
  assert.equal(shouldQueue("SEEN"),true);
  assert.equal(shouldQueue("QUEUED"),true);
  assert.equal(shouldQueue("RETRYING"),true);
  assert.equal(shouldQueue("PROCESSING"),false);
  assert.equal(shouldQueue("PERSISTED"),false);
  assert.equal(shouldQueue("TERMINAL_FAILURE"),false);
});

test("a crashed worker's stale processing lease is recoverable without retrying fresh work",()=>{
  const now=1_000_000;
  assert.equal(shouldRecoverProcessing("PROCESSING",new Date(now-FLOW_PROCESSING_STALE_MS-1),now),true);
  assert.equal(shouldRecoverProcessing("PROCESSING",new Date(now-FLOW_PROCESSING_STALE_MS),now),false);
  assert.equal(shouldRecoverProcessing("QUEUED",new Date(0),now),false);
  assert.equal(shouldRecoverProcessing("PROCESSING",null,now),false);
});

test("only exhausted queue attempts are terminal failures",()=>{
  assert.equal(terminalAfterFailure(7,8),false);
  assert.equal(terminalAfterFailure(8,8),true);
});

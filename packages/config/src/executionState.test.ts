import test from "node:test";
import assert from "node:assert/strict";
import {resolveExecutionState,type ExecutionStateInput} from "./executionState.js";

const healthy:ExecutionStateInput={
  liveTradingRequested:false,environmentMode:"live",emergencyPaused:false,
  rpcCredentialsVerified:true,rpcOperational:true,chainDataFresh:true,scannerDegraded:false,
  jupiterVerified:true,jupiterOperational:true,signerConfigured:true,signerVerified:true,signerOperational:true,
  activeDelegatedWallets:2,requiredWorkersHealthy:true,openLivePositions:0
};

test("production safety fixture selects simulation and cannot reach live construction",()=>{
  const state=resolveExecutionState({...healthy,environmentMode:"simulation",rpcOperational:false,scannerDegraded:true});
  assert.equal(state.actualRuntimeMode,"SIMULATION");
  assert.equal(state.nextQualifiedSignalAction,"SIMULATION");
  assert.equal(state.newEntriesLive,false);
  assert.ok(state.blockers.some(b=>b.code==="EXECUTION_RUNTIME_SIMULATION"));
  assert.ok(state.blockers.some(b=>b.code==="RPC_DEGRADED"));
});

test("requested LIVE plus simulation runtime is explicitly LIVE_BLOCKED",()=>{
  const state=resolveExecutionState({...healthy,liveTradingRequested:true,environmentMode:"simulation"});
  assert.equal(state.status,"LIVE_BLOCKED");
  assert.equal(state.actualRuntimeMode,"SIMULATION");
  assert.equal(state.nextQualifiedSignalAction,"SIMULATION");
});

test("only every satisfied gate selects live transaction construction",()=>{
  const state=resolveExecutionState({...healthy,liveTradingRequested:true});
  assert.equal(state.status,"LIVE");
  assert.equal(state.actualRuntimeMode,"LIVE");
  assert.equal(state.nextQualifiedSignalAction,"LIVE_TRANSACTION");
});

test("RPC rate limiting blocks live construction even with valid credentials",()=>{
  const state=resolveExecutionState({...healthy,liveTradingRequested:true,rpcOperational:false});
  assert.equal(state.status,"LIVE_BLOCKED");
  assert.equal(state.nextQualifiedSignalAction,"BLOCKED");
  assert.ok(state.blockers.some(b=>b.code==="RPC_DEGRADED"));
});

test("kill switch is PAUSED and blocks every entry branch",()=>{
  const state=resolveExecutionState({...healthy,liveTradingRequested:true,emergencyPaused:true});
  assert.equal(state.status,"PAUSED");
  assert.equal(state.nextQualifiedSignalAction,"BLOCKED");
});

test("healthy live-capable runtime with request OFF is READY_FOR_LIVE but does not trade",()=>{
  const state=resolveExecutionState(healthy);
  assert.equal(state.status,"READY_FOR_LIVE");
  assert.equal(state.nextQualifiedSignalAction,"BLOCKED");
  assert.equal(state.newEntriesLive,false);
});

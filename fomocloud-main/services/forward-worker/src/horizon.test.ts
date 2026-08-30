import assert from "node:assert/strict";
import test from "node:test";
import {classifyObservation,toleranceForHorizonMs} from "./horizon.js";

test("forward horizons keep their evidence window bounded",()=>{
  assert.equal(toleranceForHorizonMs(30),15_000);
  assert.equal(toleranceForHorizonMs(3600),900_000);
  assert.equal(toleranceForHorizonMs(86400),2_700_000);
});

test("missing source or bounded market evidence never becomes a successful return",()=>{
  assert.equal(classifyObservation(100,100,20,false,true),"INVALID");
  assert.equal(classifyObservation(100,100,20,true,false),"MISSING");
});

test("a delayed job can retain bounded price evidence but is visibly late",()=>{
  assert.equal(classifyObservation(110,100,20,true,true),"OK");
  assert.equal(classifyObservation(121,100,20,true,true),"LATE");
});

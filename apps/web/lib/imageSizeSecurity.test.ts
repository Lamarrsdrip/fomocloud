import test from "node:test";
import assert from "node:assert/strict";
import {imageSize} from "image-size";

function ascii(target:Uint8Array,offset:number,value:string){
  target.set(Buffer.from(value,"ascii"),offset);
}

function u32(target:Uint8Array,offset:number,value:number){
  new DataView(target.buffer).setUint32(offset,value,false);
}

test("patched image-size rejects a zero-length ICNS entry instead of looping",()=>{
  const input=new Uint8Array(16);
  ascii(input,0,"icns"); u32(input,4,16); ascii(input,8,"ic07"); u32(input,12,0);
  assert.throws(()=>imageSize(input),/Invalid ICNS entry length/);
});

test("patched image-size rejects a zero-length JXL partial stream instead of looping",()=>{
  const input=new Uint8Array(40);
  u32(input,0,12); ascii(input,4,"JXL ");
  u32(input,12,20); ascii(input,16,"ftyp"); ascii(input,20,"jxl ");
  u32(input,32,0); ascii(input,36,"jxlp");
  assert.throws(()=>imageSize(input),/Invalid JXL partial stream box size/);
});

test("patched image-size rejects a zero-length HEIF image-property box instead of looping",()=>{
  const input=new Uint8Array(52);
  u32(input,0,16); ascii(input,4,"ftyp"); ascii(input,8,"heic");
  u32(input,16,12); ascii(input,20,"meta");
  u32(input,28,8); ascii(input,32,"iprp");
  u32(input,36,16); ascii(input,40,"ipco");
  u32(input,44,0); ascii(input,48,"ispe");
  assert.throws(()=>imageSize(input),/Invalid HEIF image property box size/);
});

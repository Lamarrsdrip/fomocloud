import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const db=new PrismaClient();

function encryptionKey(){
  const source=process.env.ENVELOPE_ENCRYPTION_KEY??"";
  if(!source||source.startsWith("replace-"))throw new Error("ENVELOPE_ENCRYPTION_KEY is required to migrate legacy secret AppConfig rows");
  try{const b64=Buffer.from(source,"base64");if(b64.length===32)return b64}catch{}
  if(/^[a-f0-9]{64}$/i.test(source))return Buffer.from(source,"hex");
  throw new Error("ENVELOPE_ENCRYPTION_KEY must be a real 32-byte base64 key or 64-character hex key");
}
function encryptLegacy(value:unknown){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",encryptionKey(),iv);
  const body=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return [iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),body.toString("base64url")].join(".");
}

async function updateMissing(collection:string,field:string,value:unknown){
  const result:any=await db.$runCommandRaw({
    update:collection,
    updates:[{q:{[field]:{$exists:false}},u:{$set:{[field]:value}},multi:true}]
  } as any);
  return Number(result?.nModified??result?.n??0);
}

async function pipeline(collection:string,query:Record<string,unknown>,stages:Record<string,unknown>[]){
  const result:any=await db.$runCommandRaw({update:collection,updates:[{q:query,u:stages,multi:true}]} as any);
  return Number(result?.nModified??result?.n??0);
}

const changed:Record<string,number>={};
async function set(collection:string,field:string,value:unknown){changed[`${collection}.${field}`]=await updateMissing(collection,field,value)}

try{
  // This migration is deliberately additive/idempotent. It backfills required fields introduced by
  // v0.5 without deleting historical account/trade documents. Make a mongodump before running it.
  await set("User","publicProfileEnabled",false);
  await set("User","role","USER");
  await set("User","status","ACTIVE");

  await set("Trader","kind","PLATFORM");
  await set("Trader","enabled",true);
  await set("Trader","featured",false);
  await set("Trader","recommended",false);
  await set("Trader","defaultSelected",false);
  await set("Trader","trackingStatus","TRACKING");

  await set("UserFollow","copyAdditionalBuys",true);
  await set("UserFollow","copyReentries",true);
  await set("UserFollow","exitMode","ADAPTIVE");

  // The pre-v0.5 deployment was simulation-only. Missing Position.mode therefore migrates to
  // SIMULATION rather than ever mis-labelling an old test position as live money.
  await set("Position","mode","SIMULATION");
  await set("Position","unrealizedPnlUsd",0);
  await set("Position","profitTakenUsd",0);

  await set("TradingCashAllocation","asset","USDC");
  await set("Broadcast","targetCount",0);
  await set("Broadcast","skippedCount",0);

  changed["Notification.deliveryKey"]=await pipeline(
    "Notification",
    {deliveryKey:{$exists:false}},
    [{$set:{deliveryKey:{$concat:["legacy:",{$toString:"$_id"}]}}}]
  );

  changed["Order.idempotencyKey"]=await pipeline(
    "Order",
    {idempotencyKey:{$exists:false}},
    [{$set:{idempotencyKey:{$concat:["legacy:",{$toString:"$_id"}]}}}]
  );
  changed["CopyDecision.action"]=await pipeline(
    "CopyDecision",
    {action:{$exists:false}},
    [{$set:{action:{$cond:["$allowed","BUY","SKIP"]}}}]
  );

  // v0.4 stored owner-entered provider secrets in AppConfig.valueJson. v0.5 never reads secret
  // plaintext from that field. Encrypt each legacy secret in place before the new services start.
  const legacySecrets=await db.appConfig.findMany({where:{isSecret:true,encryptedValue:{isSet:false}}});
  if(legacySecrets.length) encryptionKey(); // fail before changing anything if the master key is not ready.
  let encrypted=0;
  for(const row of legacySecrets){
    const legacy=row.valueJson;
    if(!legacy||typeof legacy!=="object")continue;
    await db.appConfig.update({where:{id:row.id},data:{encryptedValue:encryptLegacy(legacy),valueJson:{configured:true}}});
    encrypted++;
  }
  changed["AppConfig.legacySecretsEncrypted"]=encrypted;

  console.log("v0.5 additive backfill complete",changed);
  console.log("No documents were deleted. Review counts above, then run Prisma db push/validation.");
} finally {
  await db.$disconnect();
}

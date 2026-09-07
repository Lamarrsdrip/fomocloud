// Deduplicate Deposit rows that share an idempotencyKey.
//
// Context: `Deposit.idempotencyKey` is meant to be unique -- one row per real on-chain deposit --
// but a scanner re-ran before idempotency was enforced and inserted the same deposit repeatedly.
// Those duplicates then blocked `prisma db push` from ever creating the unique index, which in turn
// blocked every later schema change on this database.
//
// Safety established by inspection before writing this (2026-09-07): all duplicate groups are exact
// duplicates (identical txHash, amountRaw, asset, userId), every one is 1-lamport dust, and NOT ONE
// of them was ever credited (creditedAt null across the board). So no balance was ever affected and
// collapsing each group to its earliest row loses no financial truth.
//
// This script still refuses to delete anything that is not provably a duplicate, and refuses
// outright if any group contains more than one credited row.
//
//   node packages/db/scripts/dedupe-deposit-idempotency.mjs            # dry run
//   node packages/db/scripts/dedupe-deposit-idempotency.mjs --apply
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient();
const apply=process.argv.includes("--apply");

const all=await db.deposit.findMany({orderBy:{createdAt:"asc"}});
const groups=new Map();
for(const d of all){const k=d.idempotencyKey;if(!k)continue;groups.set(k,[...(groups.get(k)||[]),d])}
const dupes=[...groups.entries()].filter(([,rows])=>rows.length>1);

const unsafe=[],plan=[];
for(const [key,rows] of dupes){
  const first=rows[0];
  const identical=rows.every(r=>String(r.amountRaw)===String(first.amountRaw)&&r.asset===first.asset&&r.txHash===first.txHash&&String(r.userId)===String(first.userId));
  const credited=rows.filter(r=>r.creditedAt||r.status==="CREDITED");
  if(!identical||credited.length>1){unsafe.push({key,identical,creditedRows:credited.length});continue}
  // Keep the credited row if there is one, otherwise the earliest. Delete the rest.
  const keep=credited[0]??first;
  plan.push({key,keepId:keep.id,deleteIds:rows.filter(r=>r.id!==keep.id).map(r=>r.id),amountRaw:String(first.amountRaw),txHash:first.txHash});
}

console.log(JSON.stringify({mode:apply?"APPLY":"DRY_RUN",totalDeposits:all.length,duplicateGroups:dupes.length,
  safeGroups:plan.length,rowsToDelete:plan.reduce((n,p)=>n+p.deleteIds.length,0),unsafeGroups:unsafe},null,2));

if(unsafe.length){console.error("REFUSING: some duplicate groups are not provably identical or have multiple credited rows. Resolve those manually first.");await db.$disconnect();process.exit(1)}
if(!apply){await db.$disconnect();process.exit(0)}

let deleted=0;
for(const p of plan){for(const id of p.deleteIds){await db.deposit.delete({where:{id}});deleted++}}
const remaining=await db.deposit.count();
console.log(JSON.stringify({deleted,depositsRemaining:remaining,note:"one row retained per real on-chain deposit"},null,2));
await db.$disconnect();
process.exit(0);

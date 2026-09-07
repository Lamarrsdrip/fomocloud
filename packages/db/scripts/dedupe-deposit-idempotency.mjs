// Deposit duplicate cleanup required before Prisma can create the intended unique indexes.
// SAFETY: dry-run by default. It only removes rows that are byte-for-byte equivalent as a deposit
// identity and keeps the one row that owns any accounting ledger reference (otherwise earliest).
// It never deletes the canonical row and refuses any group with conflicting financial references.
//
// node packages/db/scripts/dedupe-deposit-idempotency.mjs
// node packages/db/scripts/dedupe-deposit-idempotency.mjs --apply
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient();
const apply=process.argv.includes("--apply");

const all=await db.deposit.findMany({orderBy:{createdAt:"asc"}});
const groups=new Map();
for(const d of all){if(!d.idempotencyKey)continue;groups.set(d.idempotencyKey,[...(groups.get(d.idempotencyKey)||[]),d])}
const dupes=[...groups.entries()].filter(([,rows])=>rows.length>1);
const depositIds=dupes.flatMap(([,rows])=>rows.map(r=>r.id));
const ledgers=depositIds.length?await db.ledgerEntry.findMany({where:{referenceType:"Deposit",referenceId:{in:depositIds}},select:{id:true,referenceId:true,userId:true,type:true,amountUsdMicros:true,asset:true}}):[];
const ledgerByDeposit=new Map();for(const l of ledgers)ledgerByDeposit.set(l.referenceId,[...(ledgerByDeposit.get(l.referenceId)||[]),l]);

const unsafe=[],plan=[];
for(const [key,rows] of dupes){
  const first=rows[0];
  const identical=rows.every(r=>String(r.amountRaw)===String(first.amountRaw)&&r.assetMint===first.assetMint&&r.txHash===first.txHash&&String(r.userId)===String(first.userId)&&String(r.walletId)===String(first.walletId)&&r.walletAddress===first.walletAddress&&r.chain===first.chain);
  const withLedger=rows.filter(r=>(ledgerByDeposit.get(r.id)||[]).length>0);
  const ledgerCount=withLedger.reduce((n,r)=>n+(ledgerByDeposit.get(r.id)||[]).length,0);
  if(!identical||withLedger.length>1||ledgerCount>1){unsafe.push({key,identical,rows:rows.map(r=>r.id),ledgerReferencedRows:withLedger.map(r=>r.id),ledgerCount});continue}
  const keep=withLedger[0]??rows[0];
  const deleteRows=rows.filter(r=>r.id!==keep.id);
  plan.push({key,keepId:keep.id,deleteIds:deleteRows.map(r=>r.id),userId:first.userId,walletId:first.walletId,txHash:first.txHash,assetMint:first.assetMint,amountRaw:String(first.amountRaw),status:first.status,supported:first.supported,createdAt:rows.map(r=>({id:r.id,createdAt:r.createdAt})),ledgerReference:(ledgerByDeposit.get(keep.id)||[])[0]??null});
}

console.log(JSON.stringify({
  mode:apply?"APPLY":"DRY_RUN",totalDeposits:all.length,duplicateGroups:dupes.length,safeGroups:plan.length,
  rowsToDelete:plan.reduce((n,p)=>n+p.deleteIds.length,0),unsafeGroups:unsafe,
  plan
},(_,v)=>typeof v==="bigint"?v.toString():v,2));
if(unsafe.length){console.error("REFUSING: conflicting duplicate group or multiple financial ledger references found.");await db.$disconnect();process.exit(1)}
if(!apply){await db.$disconnect();process.exit(0)}

// Re-check every row immediately before destructive work so a stale dry-run cannot delete a row
// that acquired an accounting reference in the meantime.
let deleted=0;
for(const p of plan){
  const fresh=await db.deposit.findMany({where:{id:{in:[p.keepId,...p.deleteIds]}}});
  if(fresh.length!==p.deleteIds.length+1)throw new Error(`REFUSING ${p.key}: duplicate group changed since plan`);
  const refs=await db.ledgerEntry.findMany({where:{referenceType:"Deposit",referenceId:{in:p.deleteIds}}});
  if(refs.length)throw new Error(`REFUSING ${p.key}: a row scheduled for deletion now has a ledger reference`);
  for(const id of p.deleteIds){await db.deposit.delete({where:{id}});deleted++}
}
const remaining=await db.deposit.findMany({select:{id:true,idempotencyKey:true}});
const seen=new Set(),stillDuplicate=[];for(const r of remaining){if(seen.has(r.idempotencyKey))stillDuplicate.push(r.idempotencyKey);seen.add(r.idempotencyKey)}
console.log(JSON.stringify({deleted,depositsRemaining:remaining.length,remainingDuplicateIdempotencyKeys:[...new Set(stillDuplicate)]},null,2));
if(stillDuplicate.length)process.exitCode=2;
await db.$disconnect();

// Sparse unique indexes that Prisma's MongoDB connector cannot express declaratively (a bare
// @unique on a nullable field is NOT sparse in this connector — verified empirically: two
// documents with the field absent collide under a plain unique index). Safe to re-run; each
// createIndex call is a no-op if the index already exists with the same options.
import { db } from "../dist/index.js";

const indexes = [
  {
    collection: "Position",
    name: "Position_entryTxHash_sparse_unique",
    keys: { entryTxHash: 1 },
    options: { unique: true, sparse: true }
  },
  {
    collection: "PositionExit",
    name: "PositionExit_txHash_sparse_unique",
    keys: { txHash: 1 },
    options: { unique: true, sparse: true }
  },
  // Entry theses are immutable and one-to-one with positions. Prisma's MongoDB schema
  // declaration alone does not create this index on an already-running deployment.
  // Keeping it here makes the production rollout additive and idempotent.
  {
    collection: "EntryThesis",
    name: "EntryThesis_positionId_unique",
    keys: { positionId: 1 },
    options: { unique: true }
  }
];

async function main() {
  for (const idx of indexes) {
    const result = await db.$runCommandRaw({
      createIndexes: idx.collection,
      indexes: [{ key: idx.keys, name: idx.name, ...idx.options }]
    });
    console.log(`${idx.collection}.${idx.name}:`, JSON.stringify(result));
  }
  await db.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

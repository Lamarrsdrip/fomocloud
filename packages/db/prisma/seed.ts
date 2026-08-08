import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
for (const t of [
  { handle:"loganlim_x", displayName:"Logan Lim" },
  { handle:"0xAvast", displayName:"Avast" },
  { handle:"techquant", displayName:"TechQuant" }
]) {
  await db.trader.upsert({ where:{handle:t.handle}, update:{}, create:{...t, verification:"UNVERIFIED"} });
}
console.log("Seeded display-only trader profiles. Add verified wallet mappings through admin before monitoring.");
await db.$disconnect();

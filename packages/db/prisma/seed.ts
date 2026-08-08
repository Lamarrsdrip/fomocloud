import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// Production intentionally starts with no fabricated trader performance or wallet mapping.
// Admin adds real platform traders and verified public wallets from the control center.
if (process.env.SEED_SAMPLE_TRADERS === "true") {
  for (const t of [
    { handle:"sample_early", displayName:"Sample Early Trader" },
    { handle:"sample_momentum", displayName:"Sample Momentum Trader" }
  ]) {
    await db.trader.upsert({
      where:{handle:t.handle},
      update:{},
      create:{...t,kind:"PLATFORM",enabled:false,trackingStatus:"SAMPLE_NEEDS_VERIFIED_WALLET",verification:"UNVERIFIED"}
    });
  }
  console.log("Created disabled sample traders. They cannot be monitored until Admin attaches verified public wallets and enables them.");
} else {
  console.log("No sample traders seeded. Add genuine platform traders through Admin.");
}
await db.$disconnect();

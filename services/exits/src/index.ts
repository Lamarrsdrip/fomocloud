import { db } from "@fomocloud/db";
import { targetPrice, stopPrice } from "@fomocloud/shared";
import { JupiterExecution } from "@fomocloud/execution";

const jupiter = new JupiterExecution();

async function tick() {
  const positions = await db.position.findMany({
    where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
    take: 500
  });

  for (const p of positions) {
    if (!p.avgEntryPriceUsd) continue;

    // Exit decisions must be based on an executable quote, not a decorative chart price.
    // To avoid inventing token decimals / quote-mint conversion, this scaffold leaves
    // the live price adapter explicit. Production should inject decimals and quote->USD.
    // A missing adapter means no fake TP is triggered.
    const liveEnabled = process.env.EXECUTION_MODE === "live" && process.env.LIVE_EXECUTION_ENABLED === "true";
    if (!liveEnabled) continue;

    const tp = targetPrice(Number(p.avgEntryPriceUsd), Number(p.takeProfitPct));
    const sl = p.stopLossPct === null ? null : stopPrice(Number(p.avgEntryPriceUsd), Number(p.stopLossPct));
    void tp; void sl; void jupiter;
  }
}

setInterval(() => tick().catch(e => console.error("[exits]", e)), 1000);
console.log("[exits] monitoring positions");

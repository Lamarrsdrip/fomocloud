import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { db } from "@fomocloud/db";
import { decideCopy } from "@fomocloud/shared";

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

const worker = new Worker("signals", async job => {
  const signal = await db.signal.findUnique({ where: { id: job.data.signalId }, include: { trader: true } });
  if (!signal || signal.action !== "BUY") return;

  const follows = await db.userFollow.findMany({ where: { traderId: signal.traderId, mode: "AUTO_COPY" } });

  for (const follow of follows) {
    // DB unique constraint makes this idempotent across retries/workers.
    const existing = await db.copyDecision.findUnique({
      where: { signalId_userId: { signalId: signal.id, userId: follow.userId } }
    });
    if (existing) continue;

    const open = await db.position.findMany({ where: { userId: follow.userId, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } } });
    const currentExposureUsd = open.reduce((a, p) => a + Number(p.costUsd), 0);
    const tokenExposureUsd = open.filter(p => p.mint === signal.outputMint).reduce((a, p) => a + Number(p.costUsd), 0);

    // In production these come from the balance + executable quote/market-data adapters.
    // Unknown data does not get invented. The executor should enrich before live order creation.
    const availableUsd = Number(follow.maxTotalExposureUsd) - currentExposureUsd;

    const decision = decideCopy({
      settings: {
        enabled: true,
        sizingMode: "FIXED",
        fixedAmountUsd: Number(follow.fixedAmountUsd),
        percentBalance: 2,
        takeProfitPct: Number(follow.takeProfitPct),
        stopLossPct: follow.stopLossPct === null ? null : Number(follow.stopLossPct),
        maxChasePct: Number(follow.maxChasePct),
        maxSlippageBps: follow.maxSlippageBps,
        maxPositionUsd: Number(follow.maxPositionUsd),
        maxTotalExposureUsd: Number(follow.maxTotalExposureUsd),
        minLiquidityUsd: Number(follow.minLiquidityUsd),
        exitMode: follow.exitMode as any
      },
      availableUsd,
      currentExposureUsd,
      tokenExposureUsd
    });

    const row = await db.copyDecision.create({
      data: {
        signalId: signal.id,
        userId: follow.userId,
        allowed: decision.allowed,
        reason: decision.allowed ? null : decision.reason,
        amountUsd: decision.allowed ? Number(decision.amountUsd) : null
      }
    });

    if (!decision.allowed) continue;

    // Deliberate fail-closed behavior:
    // live execution cannot happen until wallet permission + balance + market/safety adapters
    // are configured. No fake order is created here.
    if (process.env.EXECUTION_MODE === "live" && process.env.LIVE_EXECUTION_ENABLED !== "true") {
      await db.copyDecision.update({ where: { id: row.id }, data: { allowed: false, reason: "LIVE_EXECUTION_NOT_ENABLED" } });
      continue;
    }

    // For simulation mode, record an explicit simulation order.
    if ((process.env.EXECUTION_MODE ?? "simulation") === "simulation") {
      await db.order.create({
        data: {
          decisionId: row.id,
          userId: follow.userId,
          chain: signal.chain,
          mode: "SIMULATION",
          side: "BUY",
          inputMint: signal.inputMint,
          outputMint: signal.outputMint,
          requestedInputRaw: decision.amountUsd,
          expectedOutputRaw: "0",
          status: "CONFIRMED",
          confirmedAt: new Date(),
          quoteJson: { simulation: true, note: "No live funds moved" }
        }
      });
    }
  }
}, { connection, concurrency: 20 });

worker.on("failed", (job, err) => console.error("[executor] failed", job?.id, err));
console.log("[executor] running");

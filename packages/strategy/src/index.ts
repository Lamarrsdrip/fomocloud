export type TokenAgeClass = "JUST_LAUNCHED" | "NEW" | "EARLY" | "ESTABLISHED";
export type TrendState = "HYPER" | "ACCELERATING" | "HEALTHY" | "PULLBACK" | "COOLING" | "BROKEN";
export type RiskState = "LOWER_RISK" | "WATCH" | "HIGH_RISK" | "BLOCKED";
export type EntryAction = "BUY_NOW" | "BUY_SMALLER" | "WAIT_PULLBACK" | "SKIP";

export type MarketSnapshot = {
  ageMinutes: number;
  liquidityUsd: number;
  marketCapUsd?: number;
  sourceMarketCapUsd?: number;
  priceFromSourcePct?: number;
  priceFromEntryPct: number;
  peakProfitPct: number;
  drawdownFromPeakPct: number;

  volume1mUsd: number;
  volume5mUsd: number;
  volume15mUsd: number;
  volumeAcceleration1m: number;   // current 1m volume / previous-5m per-minute baseline
  volumeAcceleration5m: number;   // current 5m / prior comparable 5m
  buys1m: number;
  sells1m: number;
  buys5m: number;
  sells5m: number;
  buyVolume5mUsd: number;
  sellVolume5mUsd: number;
  uniqueBuyers1m: number;
  uniqueBuyers5m: number;
  uniqueSellers5m: number;

  holderCount?: number;
  holderGrowth5mPct?: number;
  top10EffectivePct?: number;     // LP/burn/system accounts excluded
  largestRealWalletPct?: number;
  bundledSupplyPct?: number;
  creatorHoldingPct?: number;
  creatorNetSell5mPct?: number;
  smartMoneyNetFlow5mUsd?: number;
  sourceTraderStillHolding?: boolean;
  sourceTraderSoldPct?: number;

  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  token2022DangerousExtension?: boolean;
  sellRouteAvailable: boolean;
  executablePriceImpactPct: number;
  exitLiquidityForPositionUsd?: number;
  liquidityChange5mPct?: number;
  lpRiskScore?: number;           // provider-normalized 0..100

  socialMentions1m?: number;
  socialMentions5m?: number;
  socialMentions15m?: number;
  socialUniqueAuthors5m?: number;
  socialVelocity?: number;
  socialSentiment?: number;       // -1..+1
  socialSpamRatio?: number;
  influencerQualityScore?: number;// 0..100
  narrativeScore?: number;        // 0..100

  launchpadGraduated?: boolean;
  migrationHealthy?: boolean;
};

export type PositionState = {
  tp1Taken: boolean;
  tp2Taken: boolean;
  tp3Taken: boolean;
  principalRecoveredPct: number;
  peakProfitPct: number;
  remainingPct: number;
};

export type EntryDecision = {
  action: EntryAction;
  confidence: number;
  sizeMultiplier: number;
  chaseCapPct: number;
  reasons: string[];
  warnings: string[];
};

export type ExitInstruction =
  | { action:"HOLD"; reason:string; trailPct:number; trend:TrendState }
  | { action:"PARTIAL_TP"; sellPct:number; reason:string; nextTargetPct?:number }
  | { action:"EXIT"; sellPct:number; reason:string }
  | { action:"REDUCE"; sellPct:number; reason:string };

export const MEME_POLICY = {
  chase: {
    justLaunchedBasePct: 40,
    newBasePct: 35,
    earlyBasePct: 30,
    establishedBasePct: 22,
    hyperMaxPct: 55,
    pullbackWaitFromPct: 55,
    absoluteLatePct: 120
  },
  established: {
    tp1: 50, tp2: 100,
    tp1SellNormalPct: 30, tp2SellNormalPct: 25,
    runnerPct: 45,
    catastrophicLossPct: 45
  },
  newToken: {
    tp1: 100, tp2: 150, tp3: 200,
    tp1SellNormalPct: 30, tp2SellNormalPct: 20, tp3SellNormalPct: 15,
    runnerPct: 35,
    catastrophicLossPct: 55
  }
} as const;

const clamp = (n:number, min:number, max:number) => Math.min(max, Math.max(min, n));
const ratio = (a:number, b:number) => a / Math.max(1e-9, b);

export function classifyAge(ageMinutes:number):TokenAgeClass {
  if (ageMinutes <= 30) return "JUST_LAUNCHED";
  if (ageMinutes <= 24 * 60) return "NEW";
  if (ageMinutes <= 7 * 24 * 60) return "EARLY";
  return "ESTABLISHED";
}

/**
 * Only objective catastrophic conditions are hard blockers.
 * Everything else becomes a score/warning so the bot is selective without becoming rigid.
 */
export function hardBlockers(m:MarketSnapshot):string[] {
  const reasons:string[] = [];
  if (!m.sellRouteAvailable) reasons.push("NO_EXECUTABLE_SELL_ROUTE");
  if (m.token2022DangerousExtension) reasons.push("DANGEROUS_TOKEN_EXTENSION");
  if (m.freezeAuthorityActive && (m.creatorHoldingPct ?? 0) > 5) reasons.push("FREEZE_CONTROL_PLUS_CREATOR_EXPOSURE");
  if (m.liquidityUsd < 5_000) reasons.push("EXTREME_LOW_LIQUIDITY");
  if (m.executablePriceImpactPct > 35) reasons.push("UNUSABLE_PRICE_IMPACT");
  if ((m.liquidityChange5mPct ?? 0) < -65) reasons.push("LIQUIDITY_COLLAPSE");
  if ((m.creatorNetSell5mPct ?? 0) > 70) reasons.push("CREATOR_DUMPING");
  return reasons;
}

export function riskScore(m:MarketSnapshot):{state:RiskState; score:number; reasons:string[]} {
  const blockers = hardBlockers(m);
  if (blockers.length) return {state:"BLOCKED", score:100, reasons:blockers};

  let score = 0;
  const reasons:string[] = [];
  if (m.liquidityUsd < 20_000) { score += 25; reasons.push("Thin liquidity"); }
  else if (m.liquidityUsd < 50_000) { score += 10; reasons.push("Light liquidity"); }

  if (m.executablePriceImpactPct > 18) { score += 25; reasons.push("High price impact"); }
  else if (m.executablePriceImpactPct > 9) { score += 10; reasons.push("Noticeable price impact"); }

  if (m.mintAuthorityActive) { score += 10; reasons.push("Mint authority still active"); }
  if ((m.top10EffectivePct ?? 0) > 75) { score += 25; reasons.push("Very concentrated holders"); }
  else if ((m.top10EffectivePct ?? 0) > 60) { score += 12; reasons.push("Concentrated holders"); }

  if ((m.bundledSupplyPct ?? 0) > 35) { score += 24; reasons.push("High bundled supply"); }
  else if ((m.bundledSupplyPct ?? 0) > 20) { score += 10; reasons.push("Bundled supply worth watching"); }

  if ((m.creatorHoldingPct ?? 0) > 15) { score += 18; reasons.push("Creator still controls a large share"); }
  if ((m.socialSpamRatio ?? 0) > .70) { score += 12; reasons.push("Social hype looks heavily automated"); }
  if ((m.lpRiskScore ?? 0) > 75) { score += 20; reasons.push("Liquidity structure is risky"); }

  const state:RiskState = score >= 65 ? "HIGH_RISK" : score >= 30 ? "WATCH" : "LOWER_RISK";
  return {state, score:clamp(score,0,100), reasons};
}

export function momentumScore(m:MarketSnapshot):number {
  const flowRatio = ratio(m.buyVolume5mUsd, m.sellVolume5mUsd);
  const txRatio = ratio(m.buys5m, m.sells5m);
  let score = 50;
  score += clamp((m.volumeAcceleration1m - 1) * 18, -20, 28);
  score += clamp((m.volumeAcceleration5m - 1) * 12, -16, 20);
  score += clamp((flowRatio - 1) * 18, -22, 26);
  score += clamp((txRatio - 1) * 8, -10, 12);
  score += clamp((m.holderGrowth5mPct ?? 0) * 1.5, -8, 12);
  score += clamp((m.smartMoneyNetFlow5mUsd ?? 0) / Math.max(5_000, m.liquidityUsd) * 30, -14, 18);
  return clamp(Math.round(score), 0, 100);
}

export function socialScore(m:MarketSnapshot):number {
  // Missing social data is neutral. It must never silently become a hard block.
  if (m.socialMentions5m == null) return 50;
  let score = 48;
  score += clamp(((m.socialVelocity ?? 1) - 1) * 22, -22, 28);
  score += clamp((m.socialSentiment ?? 0) * 18, -18, 18);
  score += clamp(((m.socialUniqueAuthors5m ?? 0) / Math.max(1, m.socialMentions5m) - .25) * 25, -8, 10);
  score += clamp(((m.influencerQualityScore ?? 50) - 50) * .16, -8, 8);
  score += clamp(((m.narrativeScore ?? 50) - 50) * .12, -6, 6);
  score -= clamp((m.socialSpamRatio ?? 0) * 25, 0, 25);
  return clamp(Math.round(score), 0, 100);
}

export function trendState(m:MarketSnapshot):TrendState {
  const mom = momentumScore(m);
  const social = socialScore(m);
  const flow = ratio(m.buyVolume5mUsd, m.sellVolume5mUsd);
  const liquidityDamage = (m.liquidityChange5mPct ?? 0) < -25;
  const sourceDump = (m.sourceTraderSoldPct ?? 0) > 70;

  if (liquidityDamage || (mom < 25 && flow < .65) || (sourceDump && mom < 35)) return "BROKEN";
  if (mom >= 88 && social >= 68 && m.volumeAcceleration1m >= 1.8) return "HYPER";
  if (mom >= 72 && social >= 55) return "ACCELERATING";
  if (m.drawdownFromPeakPct >= 12 && mom >= 55 && flow >= .85) return "PULLBACK";
  if (mom >= 48 && flow >= .85) return "HEALTHY";
  return "COOLING";
}

/**
 * Dynamic chase is intentionally much looser for fast memes.
 * 30-40% is normal for fresh momentum; exceptional HYPER flow can allow up to 55%.
 * It tightens for older/slower coins.
 */
export function dynamicChaseCapPct(m:MarketSnapshot):number {
  const age = classifyAge(m.ageMinutes);
  const trend = trendState(m);
  let base =
    age === "JUST_LAUNCHED" ? MEME_POLICY.chase.justLaunchedBasePct :
    age === "NEW" ? MEME_POLICY.chase.newBasePct :
    age === "EARLY" ? MEME_POLICY.chase.earlyBasePct :
    MEME_POLICY.chase.establishedBasePct;

  if (trend === "HYPER") base += 15;
  else if (trend === "ACCELERATING") base += 7;
  else if (trend === "COOLING") base -= 7;
  else if (trend === "BROKEN") base -= 12;

  return clamp(base, 12, MEME_POLICY.chase.hyperMaxPct);
}

/**
 * Smart entry:
 * - hard blockers are rare and objective
 * - risk warnings lower size instead of automatically rejecting
 * - 30-40% chase is allowed for fresh memes
 * - if price is beyond chase but not absurdly late, WAIT_PULLBACK instead of permanent skip
 * - HYPER momentum can justify a larger chase window, never beyond user limits
 */
export function evaluateEntry(m:MarketSnapshot, sourceQualityScore=70):EntryDecision {
  const blockers = hardBlockers(m);
  if (blockers.length) return {
    action:"SKIP", confidence:0, sizeMultiplier:0, chaseCapPct:dynamicChaseCapPct(m),
    reasons:[], warnings:blockers
  };

  const risk = riskScore(m);
  const momentum = momentumScore(m);
  const social = socialScore(m);
  const trend = trendState(m);
  const chaseCap = dynamicChaseCapPct(m);
  const moved = m.priceFromSourcePct ?? 0;

  const liquidityScore = clamp(35 + Math.log10(Math.max(1, m.liquidityUsd)) * 10 - m.executablePriceImpactPct * 1.5, 0, 100);
  const safetyScore = 100 - risk.score;
  const sourceScore = clamp(sourceQualityScore, 0, 100);

  // Fast signals dominate. Social is useful but intentionally lower weight because it can lag.
  const confidence = Math.round(
    momentum * .34 +
    safetyScore * .24 +
    sourceScore * .20 +
    liquidityScore * .14 +
    social * .08
  );

  const reasons:string[] = [];
  const warnings:string[] = [...risk.reasons];
  if (momentum >= 75) reasons.push("Buying momentum is strong");
  if (m.volumeAcceleration1m >= 1.5) reasons.push("Volume is accelerating");
  if ((m.smartMoneyNetFlow5mUsd ?? 0) > 0) reasons.push("Tracked smart wallets are net buying");
  if (social >= 65) reasons.push("Social attention is growing");
  if ((m.holderGrowth5mPct ?? 0) > 3) reasons.push("Holder count is expanding");
  if (trend === "HYPER") reasons.push("Hyper-momentum setup detected");

  if (moved > MEME_POLICY.chase.absoluteLatePct && trend !== "HYPER")
    return {action:"SKIP", confidence, sizeMultiplier:0, chaseCapPct:chaseCap, reasons, warnings:[...warnings,"Move is already extremely extended"]};

  if (moved > chaseCap) {
    if (trend === "HYPER" && moved <= MEME_POLICY.chase.absoluteLatePct)
      return {action:"BUY_SMALLER", confidence, sizeMultiplier:.55, chaseCapPct:chaseCap, reasons:[...reasons,"Exceptional momentum justifies a smaller catch-up entry"], warnings};
    return {action:"WAIT_PULLBACK", confidence, sizeMultiplier:0, chaseCapPct:chaseCap, reasons, warnings:[...warnings,"Price is above the current chase window; watching for a re-entry"]};
  }

  if (confidence >= 72) return {action:"BUY_NOW", confidence, sizeMultiplier:1, chaseCapPct:chaseCap, reasons, warnings};
  if (confidence >= 58) return {action:"BUY_SMALLER", confidence, sizeMultiplier:.65, chaseCapPct:chaseCap, reasons, warnings};
  if (momentum >= 55 && trend !== "BROKEN") return {action:"WAIT_PULLBACK", confidence, sizeMultiplier:0, chaseCapPct:chaseCap, reasons, warnings};
  return {action:"SKIP", confidence, sizeMultiplier:0, chaseCapPct:chaseCap, reasons, warnings};
}

export function adaptiveTrailPct(m:MarketSnapshot):number {
  const trend = trendState(m);
  const profit = m.priceFromEntryPct;

  // Huge winners need room. The trail gets wider with true hyper momentum.
  if (trend === "HYPER") return profit >= 1000 ? 38 : 32;
  if (trend === "ACCELERATING") return profit >= 500 ? 30 : 26;
  if (trend === "PULLBACK") return 24;
  if (trend === "HEALTHY") return 20;
  if (trend === "COOLING") return 12;
  return 7;
}

function dynamicPartial(base:number, trend:TrendState):number {
  // On monster momentum, harvest less so more capital stays in the runner.
  if (trend === "HYPER") return Math.max(12, Math.round(base * .55));
  if (trend === "ACCELERATING") return Math.max(15, Math.round(base * .75));
  if (trend === "COOLING") return Math.min(55, Math.round(base * 1.35));
  return base;
}

/**
 * Profit ladder is a floor for harvesting, not a ceiling on winners.
 * A runner has no fixed final TP and may remain open far beyond +5000%.
 */
export function evaluateExit(m:MarketSnapshot, p:PositionState):ExitInstruction {
  const blockers = hardBlockers(m);
  if (blockers.length) return {action:"EXIT", sellPct:100, reason:`Emergency protection: ${blockers[0]}`};

  const risk = riskScore(m);
  const age = classifyAge(m.ageMinutes);
  const isFresh = age !== "ESTABLISHED";
  const cfg = isFresh ? MEME_POLICY.newToken : MEME_POLICY.established;
  const profit = m.priceFromEntryPct;
  const trend = trendState(m);

  if (profit <= -cfg.catastrophicLossPct)
    return {action:"EXIT", sellPct:100, reason:"Catastrophic loss protection reached"};

  // Source trader exits do not automatically kill a strong runner.
  if ((m.sourceTraderSoldPct ?? 0) >= 90 && (trend === "COOLING" || trend === "BROKEN"))
    return {action:"EXIT", sellPct:100, reason:"Source trader exited and momentum also broke"};

  if (!p.tp1Taken && profit >= cfg.tp1)
    return {
      action:"PARTIAL_TP",
      sellPct:dynamicPartial(cfg.tp1SellNormalPct, trend),
      reason:`First profit harvest at +${cfg.tp1}% while ${trend.toLowerCase()} momentum continues`,
      nextTargetPct:cfg.tp2
    };

  if (!p.tp2Taken && profit >= cfg.tp2)
    return {
      action:"PARTIAL_TP",
      sellPct:dynamicPartial(cfg.tp2SellNormalPct, trend),
      reason:`Second profit harvest at +${cfg.tp2}%`,
      nextTargetPct:isFresh ? (cfg as typeof MEME_POLICY.newToken).tp3 : undefined
    };

  if (isFresh) {
    const n = cfg as typeof MEME_POLICY.newToken;
    if (!p.tp3Taken && profit >= n.tp3)
      return {action:"PARTIAL_TP", sellPct:dynamicPartial(n.tp3SellNormalPct, trend), reason:`Third profit harvest at +${n.tp3}% — runner stays open`};
  }

  // Risk rising but not catastrophic: de-risk rather than binary panic sell.
  if (risk.state === "HIGH_RISK" && profit > 0 && trend !== "HYPER")
    return {action:"REDUCE", sellPct:25, reason:"Risk increased, so KAIRO locks some profit without killing the whole runner"};

  const trail = adaptiveTrailPct(m);
  // Use actual drawdown from the peak PRICE, not percentage-point distance between
  // peak profit and current profit. On a +5000% winner, 5200 -> 5000 is only a
  // small price drawdown and must not be treated as a 200% collapse.
  if (p.peakProfitPct > 0 && m.drawdownFromPeakPct >= trail) {
    if (trend === "HYPER" || trend === "ACCELERATING")
      return {action:"REDUCE", sellPct:30, reason:"Fast pullback inside a strong trend — reduce, do not fully kill the runner"};
    return {action:"EXIT", sellPct:100, reason:`Adaptive runner protection hit after momentum turned ${trend.toLowerCase()}`};
  }

  if (trend === "BROKEN")
    return {action:"EXIT", sellPct:100, reason:"Buyer flow, liquidity or momentum broke down"};

  return {action:"HOLD", reason:`${trend.toLowerCase()} trend still supports the runner`, trailPct:trail, trend};
}

export type TokenAgeClass = "UNKNOWN" | "JUST_LAUNCHED" | "NEW" | "EARLY" | "ESTABLISHED";
export type TrendState = "HYPER" | "ACCELERATING" | "HEALTHY" | "PULLBACK" | "COOLING" | "BROKEN";
export type RiskState = "LOWER_RISK" | "WATCH" | "HIGH_RISK" | "BLOCKED";
export type EntryAction = "BUY_NOW" | "BUY_SMALLER" | "WAIT_PULLBACK" | "SKIP";
export type ThesisState = "THESIS_STRENGTHENING" | "THESIS_HEALTHY" | "THESIS_WEAKENING" | "DISTRIBUTION" | "BROKEN" | "UNKNOWN";

export type MarketSnapshot = {
  ageMinutes?: number;
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
  /** Whether the token is worth caring about, independent of this exact fill. */
  opportunityQuality: QualityAssessment;
  /** Whether the current executable moment is attractive. */
  entryQuality: QualityAssessment;
  confidence: number;
  sizeMultiplier: number;
  chaseCapPct: number;
  reasons: string[];
  warnings: string[];
};

export type QualityAssessment = {
  score: number;
  reasons: string[];
  warnings: string[];
};

export type ThesisReference = {
  marketEvidence?: unknown;
};

export type ThesisAssessment = {
  state: ThesisState;
  reasons: string[];
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
    hyperMaxPct: 250,
    pullbackWaitFromPct: 0
  },
  established: {
    tp1: 50, tp2: 100,
    tp1SellNormalPct: 30, tp2SellNormalPct: 25,
    runnerPct: 45
  },
  newToken: {
    tp1: 100, tp2: 150, tp3: 200,
    tp1SellNormalPct: 30, tp2SellNormalPct: 20, tp3SellNormalPct: 15,
    runnerPct: 35
  }
} as const;

const clamp = (n:number, min:number, max:number) => Math.min(max, Math.max(min, n));
const ratio = (a:number, b:number) => a / Math.max(1e-9, b);

/**
 * The one canonical definition used by every position producer.  This deliberately
 * works from prices, not from percentage profit.  A move from $51 to $49 after a
 * $1 entry is a ~3.9% drawdown, not a fictitious 200-point collapse.
 */
export function priceDrawdownFromPeakPct(peakPriceUsd:number, currentPriceUsd:number):number {
  if (!Number.isFinite(peakPriceUsd) || peakPriceUsd <= 0 || !Number.isFinite(currentPriceUsd)) return 0;
  return clamp(((peakPriceUsd - currentPriceUsd) / peakPriceUsd) * 100, 0, 100);
}

export function classifyAge(ageMinutes?:number):TokenAgeClass {
  if (!Number.isFinite(ageMinutes) || ageMinutes == null || ageMinutes < 0) return "UNKNOWN";
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
  // Professional-degen rule: unusual token structure, concentration, drawdown and prior pump are
  // evidence, not automatic rejection. Only execution-impossible conditions are hard blockers.
  if (!m.sellRouteAvailable) reasons.push("NO_EXECUTABLE_SELL_ROUTE");
  if (!Number.isFinite(m.executablePriceImpactPct) || m.executablePriceImpactPct >= 75) reasons.push("UNUSABLE_EXECUTION_ROUTE");
  if (!Number.isFinite(m.liquidityUsd) || m.liquidityUsd <= 0) reasons.push("NO_EXECUTABLE_LIQUIDITY");
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
    age === "UNKNOWN" ? MEME_POLICY.chase.newBasePct :
    age === "EARLY" ? MEME_POLICY.chase.earlyBasePct :
    MEME_POLICY.chase.establishedBasePct;

  if (trend === "HYPER") base += 15;
  else if (trend === "ACCELERATING") base += 7;
  else if (trend === "COOLING") base -= 7;
  else if (trend === "BROKEN") base -= 12;

  return clamp(base, 12, MEME_POLICY.chase.hyperMaxPct);
}

/**
 * Token opportunity is deliberately independent from timing. A ridiculous-looking meme with
 * independent buying flow can score well here; utility, polish and narrative seriousness are
 * intentionally not inputs.
 */
export function evaluateOpportunityQuality(m:MarketSnapshot, sourceQualityScore=70):QualityAssessment {
  const risk = riskScore(m);
  const momentum = momentumScore(m);
  const social = socialScore(m);
  const liquidityScore = clamp(35 + Math.log10(Math.max(1, m.liquidityUsd)) * 10 - m.executablePriceImpactPct * 1.5, 0, 100);
  const sourceScore = clamp(sourceQualityScore, 0, 100);
  const score = Math.round(
    momentum * .34 +
    (100 - risk.score) * .24 +
    sourceScore * .20 +
    liquidityScore * .14 +
    social * .08
  );
  const reasons:string[]=[];
  const warnings=[...risk.reasons];
  if (classifyAge(m.ageMinutes)==="UNKNOWN") warnings.push("Token age is unknown; age-sensitive timing is not being assumed");
  if (momentum >= 75) reasons.push("Buying momentum is strong");
  if (m.volumeAcceleration1m >= 1.5) reasons.push("Volume is accelerating");
  if ((m.smartMoneyNetFlow5mUsd ?? 0) > 0) reasons.push("Tracked smart wallets are net buying");
  if (social >= 65) reasons.push("Social attention is growing");
  if ((m.holderGrowth5mPct ?? 0) > 3) reasons.push("Holder count is expanding");
  if (trendState(m) === "HYPER") reasons.push("Hyper-momentum setup detected");
  return {score:clamp(score,0,100),reasons,warnings};
}

/**
 * Entry quality answers a different question: should MemeCloud buy at this executable price now?
 * Catch-up is allowed when a fresh expansion is actually being confirmed, but a good token that
 * has gone quiet after smart money entered becomes WAIT_PULLBACK instead of exit liquidity.
 */
export function evaluateEntryQuality(m:MarketSnapshot, opportunityScore:number):QualityAssessment {
  const risk=riskScore(m);
  const momentum=momentumScore(m);
  const chaseCap=dynamicChaseCapPct(m);
  const moved=m.priceFromSourcePct ?? 0;
  let score=clamp(68 + (opportunityScore-50)*.35 + (momentum-50)*.12 - risk.score*.12 - Math.max(0,m.executablePriceImpactPct-5)*1.2,0,100);
  const reasons:string[]=[];
  const warnings:string[]=[];

  const expansionEvidence=[
    m.volumeAcceleration1m >= 1.5,
    m.volumeAcceleration5m >= 1.3,
    (m.liquidityChange5mPct ?? 0) > 0,
    (m.smartMoneyNetFlow5mUsd ?? 0) > 0,
    m.sourceTraderStillHolding === true
  ].filter(Boolean).length;
  if (moved > chaseCap) {
    // A wide chase needs every available confirmation of a *continuing* expansion. Four stale
    // supportive fields are not enough when the current one-minute tape has stopped accelerating.
    if (expansionEvidence === 5) {
      score -= 8;
      reasons.push("Catch-up expansion is confirmed by fresh flow, liquidity and source conviction");
    } else {
      score -= Math.min(55,18 + (moved-chaseCap)*.75);
      warnings.push(`Entry is ${moved.toFixed(1)}% above source execution without enough fresh expansion evidence`);
    }
  }
  if (m.sourceTraderStillHolding === false || (m.sourceTraderSoldPct ?? 0) >= 50) {
    score -= 18;
    warnings.push("Source conviction is fading");
  }
  if ((m.liquidityChange5mPct ?? 0) < -15) {
    score -= 14;
    warnings.push("Liquidity is deteriorating");
  }
  if (m.drawdownFromPeakPct >= 8 && momentum >= 55) reasons.push("Pullback may offer a cleaner entry");
  return {score:clamp(Math.round(score),0,100),reasons,warnings};
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
    action:"SKIP", opportunityQuality:{score:0,reasons:[],warnings:blockers}, entryQuality:{score:0,reasons:[],warnings:blockers}, confidence:0, sizeMultiplier:0, chaseCapPct:dynamicChaseCapPct(m),
    reasons:[], warnings:blockers
  };

  const trend = trendState(m);
  const chaseCap = dynamicChaseCapPct(m);
  const opportunityQuality=evaluateOpportunityQuality(m,sourceQualityScore);
  const entryQuality=evaluateEntryQuality(m,opportunityQuality.score);
  const confidence=entryQuality.score;
  const reasons=[...opportunityQuality.reasons,...entryQuality.reasons];
  const warnings=[...opportunityQuality.warnings,...entryQuality.warnings];

  if (opportunityQuality.score >= 65 && entryQuality.score >= 72)
    return {action:"BUY_NOW",opportunityQuality,entryQuality,confidence,sizeMultiplier:1,chaseCapPct:chaseCap,reasons,warnings};
  if (opportunityQuality.score >= 55 && entryQuality.score >= 58)
    return {action:"BUY_SMALLER",opportunityQuality,entryQuality,confidence,sizeMultiplier:.65,chaseCapPct:chaseCap,reasons,warnings};
  if (opportunityQuality.score >= 55 && trend !== "BROKEN")
    return {action:"WAIT_PULLBACK",opportunityQuality,entryQuality,confidence,sizeMultiplier:0,chaseCapPct:chaseCap,reasons,warnings};
  return {action:"SKIP",opportunityQuality,entryQuality,confidence,sizeMultiplier:0,chaseCapPct:chaseCap,reasons,warnings};
}

function evidenceNumber(evidence:unknown, key:string):number|undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  const value=(evidence as Record<string,unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Compare current conditions with the immutable entry thesis. This is intentionally evidence-led:
 * a source sell alone does not kill a runner, while source distribution plus liquidity/flow damage
 * can. Positions without a thesis remain UNKNOWN rather than receiving invented conviction.
 */
export function evaluatePositionThesis(m:MarketSnapshot, thesis?:ThesisReference|null):ThesisAssessment {
  if (!thesis) return {state:"UNKNOWN",reasons:["No immutable entry thesis exists for this legacy position"]};
  const baselineLiquidity=evidenceNumber(thesis.marketEvidence,"liquidityUsd");
  const baselineFlow=evidenceNumber(thesis.marketEvidence,"smartMoneyNetFlow5mUsd");
  const baselineVolume=evidenceNumber(thesis.marketEvidence,"volumeAcceleration1m");
  const reasons:string[]=[];
  const sourceExiting=(m.sourceTraderSoldPct ?? 0) >= 90;
  const creatorDistribution=(m.creatorNetSell5mPct ?? 0) >= 20;
  const liquidityDamaged=(m.liquidityChange5mPct ?? 0) <= -25 || (baselineLiquidity != null && m.liquidityUsd < baselineLiquidity*.55);
  if ((sourceExiting && liquidityDamaged) || (creatorDistribution && liquidityDamaged))
    return {state:"BROKEN",reasons:[sourceExiting?"Source wallet fully exited while liquidity deteriorated":"Creator distribution coincides with serious liquidity damage"]};

  const distributionSignals=[
    (m.sourceTraderSoldPct ?? 0) >= 50,
    creatorDistribution,
    (m.smartMoneyNetFlow5mUsd ?? 0) < 0,
    (m.liquidityChange5mPct ?? 0) < -12
  ].filter(Boolean).length;
  if (distributionSignals >= 2) return {state:"DISTRIBUTION",reasons:["Multiple entry-thesis participants or market supports are distributing"]};

  const strengtheningSignals=[
    m.sourceTraderStillHolding === true,
    baselineFlow != null ? (m.smartMoneyNetFlow5mUsd ?? 0) > Math.max(0,baselineFlow) : (m.smartMoneyNetFlow5mUsd ?? 0) > 0,
    baselineVolume != null ? m.volumeAcceleration1m > baselineVolume*1.1 : m.volumeAcceleration1m >= 1.5,
    (m.liquidityChange5mPct ?? 0) > 0
  ].filter(Boolean).length;
  if (strengtheningSignals >= 3) return {state:"THESIS_STRENGTHENING",reasons:["Source conviction, smart flow and market participation are improving from entry"]};

  const weakeningSignals=[
    m.sourceTraderStillHolding === false,
    (m.smartMoneyNetFlow5mUsd ?? 0) < 0,
    (m.liquidityChange5mPct ?? 0) < -8,
    baselineVolume != null && m.volumeAcceleration1m < baselineVolume*.6
  ].filter(Boolean).length;
  if (weakeningSignals >= 2) return {state:"THESIS_WEAKENING",reasons:["Entry supports are weakening, but the thesis is not yet broken"]};
  reasons.push("Entry supports remain broadly intact");
  return {state:"THESIS_HEALTHY",reasons};
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

  // Source trader exits do not automatically kill a strong runner.
  if ((m.sourceTraderSoldPct ?? 0) >= 90 && (trend === "COOLING" || trend === "BROKEN"))
    return {action:"EXIT", sellPct:100, reason:"Source trader exited and momentum also broke"};

  // Principal recovery is handled by the position worker using the USER'S configured multiple
  // (3x by default). Until that happens, MemeCloud does not secretly front-run the user's plan with
  // fixed +100/+150/+200 harvests. Evidence can still close/reduce a genuinely broken position.
  if (p.principalRecoveredPct < 100 && trend !== "BROKEN")
    return {action:"HOLD", reason:`Waiting for configured capital recovery while ${trend.toLowerCase()} evidence remains viable`, trailPct:adaptiveTrailPct(m), trend};

  // Risk rising but not catastrophic: de-risk rather than binary panic sell.
  if (risk.state === "HIGH_RISK" && profit > 0 && trend !== "HYPER")
    return {action:"REDUCE", sellPct:25, reason:"Risk increased, so MemeCloud locks some profit without killing the whole runner"};

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

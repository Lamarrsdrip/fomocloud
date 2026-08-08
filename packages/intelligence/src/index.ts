import { evaluateEntry, evaluateExit, MarketSnapshot, PositionState } from "@fomocloud/strategy";

export type IntelligenceEvidence = {
  sourceQuality:number;
  market:MarketSnapshot;
  provenance:{
    chain:string[];
    market:string[];
    social:string[];
    risk:string[];
  };
  staleAfterMs:number;
  observedAt:number;
};

export type SmartDecision = {
  entry:ReturnType<typeof evaluateEntry>;
  explanation:string[];
  evidenceAgeMs:number;
};

/**
 * The fast path is deterministic and auditable. No LLM call sits between a watched-wallet buy
 * and execution. AI/ML models may enrich scores asynchronously, but a timeout cannot freeze the bot.
 */
export function decideFast(e: IntelligenceEvidence, now=Date.now()):SmartDecision {
  const age = now - e.observedAt;
  const entry = evaluateEntry(e.market, e.sourceQuality);
  const explanation = [
    ...entry.reasons,
    ...entry.warnings.map(w=>`Watch: ${w}`),
    age > e.staleAfterMs ? "Some enrichment is stale; execution must refresh price/liquidity before submitting" : "Evidence is fresh"
  ];
  return {entry, explanation, evidenceAgeMs:age};
}

export function decideExit(e:IntelligenceEvidence, p:PositionState) {
  return evaluateExit(e.market,p);
}

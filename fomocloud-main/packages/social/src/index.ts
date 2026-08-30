export type SocialPulse = {
  symbol:string;
  mint:string;
  mentions5m:number;
  mentions15m:number;
  uniqueAuthors5m:number;
  sentiment:number;
  influencerMentions:number;
  spamRatio:number;
  velocity:number;
  trend:"RISING"|"STEADY"|"FADING"|"MANIPULATED";
};

/**
 * Provider-neutral social adapter. Plug X/Twitter and other public social sources into this.
 * Do not scrape private content or violate provider rules. Store source timestamps and provenance.
 */
export interface SocialProvider {
  getPulse(query:{symbol:string; mint:string; projectName?:string}):Promise<SocialPulse>;
}

export function classifyPulse(p:Omit<SocialPulse,"trend">):SocialPulse["trend"] {
  if (p.spamRatio > .65 || (p.mentions5m > 100 && p.uniqueAuthors5m < 10)) return "MANIPULATED";
  if (p.velocity > 1.35 && p.sentiment > .05 && p.uniqueAuthors5m >= 12) return "RISING";
  if (p.velocity < .65 || p.sentiment < -.2) return "FADING";
  return "STEADY";
}

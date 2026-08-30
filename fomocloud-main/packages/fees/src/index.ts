export type FeeQuote={grossUsd:number,platformFeeUsd:number,rateBps:number,netUsd:number};
export function feeQuote(grossUsd:number, rateBps:number):FeeQuote{
  if(rateBps<0||rateBps>1000) throw new Error("INVALID_FEE_RATE");
  const platformFeeUsd=Math.round(grossUsd*rateBps)/10000;
  return {grossUsd,platformFeeUsd,rateBps,netUsd:grossUsd-platformFeeUsd};
}

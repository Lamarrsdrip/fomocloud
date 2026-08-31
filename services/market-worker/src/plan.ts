/** Open positions are always due; research mints are due only after cache expiry/event invalidation. */
export function shouldRefreshMarketMint(openPosition:boolean,dueCachePresent:boolean){
  return openPosition||!dueCachePresent;
}

export type NotificationPrefLike = {
  pushEnabled?: boolean | null;
  emailEnabled?: boolean | null;
  // Legacy granular fields remain readable for schema/backward compatibility, but the user product
  // now has ONE notification switch. They must not silently suppress classes of alpha after a user
  // has explicitly enabled MemeCloud alerts.
  traderBought?: boolean | null;
  tradeCopied?: boolean | null;
  skippedTrade?: boolean | null;
  profitTaken?: boolean | null;
  securityAlerts?: boolean | null;
  positionClosed?: boolean | null;
} | null | undefined;

/** One master push switch: ON means every useful MemeCloud push class is eligible. */
export function pushAllowed(_type: string, pref: NotificationPrefLike): boolean {
  return pref?.pushEnabled !== false;
}

export function emailWorthSending(type: string): boolean {
  return ["TRADE_COPIED", "PROFIT_TAKEN", "POSITION_CLOSED", "SECURITY_ALERT"].includes(type);
}

export type NotificationPrefLike = {
  pushEnabled?: boolean | null;
  emailEnabled?: boolean | null;
  traderBought?: boolean | null;
  tradeCopied?: boolean | null;
  skippedTrade?: boolean | null;
  profitTaken?: boolean | null;
  securityAlerts?: boolean | null;
  positionClosed?: boolean | null;
} | null | undefined;

// A user-level pushEnabled:false always wins regardless of the per-type preference below it --
// the global switch is a hard override, not just another vote alongside the type-specific one.
export function pushAllowed(type: string, pref: NotificationPrefLike): boolean {
  if (pref?.pushEnabled === false) return false;
  switch (type) {
    case "TRADER_SIGNAL": return pref?.traderBought !== false;
    case "TRADE_COPIED": return pref?.tradeCopied !== false;
    case "TRADE_SKIPPED":
    case "WAIT_PULLBACK": return pref?.skippedTrade !== false;
    case "PROFIT_TAKEN": return pref?.profitTaken !== false;
    // Real gap found by the forensic audit: notificationPreference.securityAlerts existed in the
    // schema and Settings UI (users could toggle it) but was never actually read anywhere.
    case "SECURITY_ALERT": return pref?.securityAlerts !== false;
    case "POSITION_CLOSED": return pref?.positionClosed !== false;
    default: return true;
  }
}

// Which notification types are worth the cost of an email at all, independent of the user's
// emailEnabled preference (checked separately by the caller).
export function emailWorthSending(type: string): boolean {
  return ["TRADE_COPIED", "PROFIT_TAKEN", "POSITION_CLOSED", "SECURITY_ALERT"].includes(type);
}

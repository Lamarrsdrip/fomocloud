export type AppView =
  | "home"
  | "discover"
  | "trade"
  | "positions"
  | "more"
  | "profile"
  | "traders"
  | "community"
  | "social"
  | "activity"
  | "smart-wallets";

export const MOBILE_NAV_IDS: readonly AppView[] = ["home", "discover", "trade", "positions", "more"];

export const VIEW_ALIASES: Readonly<Record<string, AppView>> = {
  wallet: "positions",
  history: "activity",
  notifications: "profile",
  settings: "profile",
};

const APP_VIEWS = new Set<AppView>([
  "home", "discover", "trade", "positions", "more", "profile", "traders",
  "community", "social", "activity", "smart-wallets",
]);

export function normalizeAppView(requested?: string | null, pathname?: string): AppView {
  const pathSegment = pathname?.split("/").filter(Boolean).at(-1);
  const candidate = requested || (pathSegment === "app" ? null : pathSegment);
  if (!candidate) return "home";
  if (VIEW_ALIASES[candidate]) return VIEW_ALIASES[candidate];
  return APP_VIEWS.has(candidate as AppView) ? candidate as AppView : "home";
}

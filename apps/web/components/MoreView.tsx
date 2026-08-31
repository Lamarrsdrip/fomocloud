"use client";

import {
  Activity, Bell, ChevronRight, ShieldCheck, Sparkles, UserRound, Users, UserSearch,
} from "lucide-react";
import type { AppView } from "../lib/appNavigation";

type Destination = {
  view: AppView;
  anchor?: "notifications" | "security";
  icon: typeof UserRound;
  title: string;
  subtitle: string;
};

const groups: { label: string; items: Destination[] }[] = [
  { label: "ACCOUNT", items: [
    { view: "profile", icon: UserRound, title: "Account", subtitle: "Profile, connected accounts and preferences" },
    { view: "profile", anchor: "security", icon: ShieldCheck, title: "Security & sessions", subtitle: "Signed-in devices and account protection" },
    { view: "profile", anchor: "notifications", icon: Bell, title: "Notifications", subtitle: "Alerts and notification inbox" },
  ] },
  { label: "INTELLIGENCE", items: [
    { view: "smart-wallets", icon: Sparkles, title: "Smart Money", subtitle: "Curated, elite, proven and whale wallets" },
    { view: "activity", icon: Activity, title: "Activity", subtitle: "Decisions, trades and account events" },
    { view: "traders", icon: UserSearch, title: "Traders", subtitle: "Find and configure tracked traders" },
    { view: "community", icon: Users, title: "Copy", subtitle: "Manage Auto Copy and watchlists" },
    { view: "social", icon: UserRound, title: "Community", subtitle: "Discover and follow MemeCloud members" },
  ] },
];

export default function MoreView({ navigate }: { navigate: (view: AppView, anchor?: Destination["anchor"]) => void }) {
  return <div className="more-menu">
    <section className="more-hero"><span>EVERYTHING IN ONE PLACE</span><h2>Your MemeCloud</h2><p>Account controls, smart-money intelligence, activity and community—without crowding the main navigation.</p></section>
    {groups.map(group => <section className="more-group" key={group.label}>
      <h3>{group.label}</h3>
      <div className="more-list">{group.items.map(({ view, anchor, icon: Icon, title, subtitle }) =>
        <button key={`${view}:${anchor || title}`} onClick={() => navigate(view, anchor)}>
          <span className="more-icon"><Icon size={18} /></span>
          <span className="more-copy"><b>{title}</b><small>{subtitle}</small></span>
          <ChevronRight size={17} />
        </button>
      )}</div>
    </section>)}
  </div>;
}

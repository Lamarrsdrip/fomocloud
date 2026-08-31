import AppPage from "../page";

const sections = ["traders", "community", "social", "activity", "history", "positions", "wallet", "notifications", "profile", "settings", "smart-wallets", "more"];

export function generateStaticParams() {
  return sections.map(section => ({ section }));
}

export default function AppSectionPage() {
  return <AppPage />;
}

import AppPage from "../page";

const sections = ["traders", "community", "activity", "history", "positions", "wallet", "notifications", "profile", "settings"];

export function generateStaticParams() {
  return sections.map(section => ({ section }));
}

export default function AppSectionPage() {
  return <AppPage />;
}

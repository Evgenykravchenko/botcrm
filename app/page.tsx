import type { Metadata } from "next";
import { BotCRM } from "./bot-crm";

export const metadata: Metadata = {
  title: "BotCRM — центр управления ботами",
  description: "Омниканальная CRM-панель для самописных ботов",
  robots: { index: false, follow: false },
};

export default function Home() {
  return <BotCRM />;
}
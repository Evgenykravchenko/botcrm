import type { Metadata } from "next";
import "./docs.css";
import { DocsPortal } from "./portal";

export const metadata: Metadata = {
  title: "Документация BotCRM",
  description: "Запуск, работа операторов и интеграция самописных ботов с BotCRM",
};

export default function DocsPage() {
  return <DocsPortal />;
}

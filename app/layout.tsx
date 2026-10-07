import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research AI — cited answers from verified sources",
  description:
    "Ask a question. Get a report built from scholarly databases, government and institutional sources, the open web and your own documents — every claim cited and every source scored.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

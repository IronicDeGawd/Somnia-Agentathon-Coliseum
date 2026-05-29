import type { Metadata } from "next";
import "./globals.css";
import { CrtBg } from "@/components/shared/OtherHUD";

export const metadata: Metadata = {
  title: "COLISEUM — Autonomous Agent-vs-Agent Trading Arena",
  description: "Twitch-style AI trading combat on dreamDEX zero-fee CLOB. Back fighters, watch live autonomous on-chain reasoning, and claim payouts.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-palette="violet" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-mono bg-[var(--bg-deep)] text-[var(--text)] select-none">
        {/* Render the scanlines globally */}
        <CrtBg />
        {children}
      </body>
    </html>
  );
}

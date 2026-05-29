import type { Metadata } from "next";
import "./globals.css";
import { CrtBg } from "@/components/shared/OtherHUD";
import { Providers } from "@/components/shared/Providers";

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
    <html lang="en" data-palette="violet" className="h-full antialiased" suppressHydrationWarning>
      <body
        className="min-h-full flex flex-col font-mono bg-[var(--bg-deep)] text-[var(--text)] select-none"
        suppressHydrationWarning
      >
        {/* Render the scanlines globally */}
        <CrtBg />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

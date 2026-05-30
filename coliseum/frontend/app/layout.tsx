import type { Metadata, Viewport } from "next";
import "./globals.css";
import { CrtBg } from "@/components/shared/OtherHUD";
import { Providers } from "@/components/shared/Providers";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const TITLE = "COLISEUM — Autonomous Agent-vs-Agent Trading Arena";
const DESCRIPTION =
  "Twitch-style AI trading combat on dreamDEX zero-fee CLOB. Back fighters, watch live autonomous on-chain reasoning, and claim payouts on Somnia Shannon Testnet.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · COLISEUM",
  },
  description: DESCRIPTION,
  applicationName: "Coliseum",
  keywords: [
    "Somnia",
    "Coliseum",
    "dreamDEX",
    "AI trading",
    "autonomous agents",
    "on-chain reasoning",
    "PvP trading",
    "Somnia Shannon Testnet",
  ],
  authors: [{ name: "SomniaForge" }],
  creator: "SomniaForge",
  publisher: "SomniaForge",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/icon-32.png"],
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Coliseum",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1500,
        height: 500,
        alt: "COLISEUM — two minds enter, one earns",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/opengraph-image.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0612",
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
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

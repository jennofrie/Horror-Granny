import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Special Elite (Apache 2.0), self-hosted: builds kept failing on flaky
// fetches to fonts.gstatic.com, and bundling kills that dependency for
// Vercel too.
const specialElite = localFont({
  src: "./fonts/SpecialElite.woff2",
  variable: "--font-elite",
  weight: "400",
  display: "swap",
  // Turbopack dev fails decompressing this woff2 when computing the
  // size-adjusted fallback ("get_font_fallbacks ... compression error").
  // Skip it and declare fallbacks by hand — it's a decorative font.
  adjustFontFallback: false,
  fallback: ["Courier New", "monospace"],
});

const SITE = "https://backroom-escape.vercel.app";

export const metadata: Metadata = {
  // Absolute base so og:image/twitter:image resolve for social scrapers.
  metadataBase: new URL(SITE),
  // Search-facing title (what people actually type: "granny game",
  // "scary escape game"). In-game branding stays GRANNY'S HOUSE — SCARY ESCAPE.
  title: "Granny's House: Scary Escape — Free Browser Horror Game",
  description:
    "Play Granny's House: Scary Escape free in your browser. First-person FPS horror in a decrepit rural house — find a weapon, put down grandma, grandpa and the devil, and get out through the front door. No download.",
  applicationName: "Granny's House: Scary Escape",
  authors: [{ name: "Jennofrie", url: "https://github.com/Jennofrie/Horror-Granny" }],
  creator: "Jennofrie",
  keywords: [
    "granny game",
    "granny horror game",
    "scary escape game",
    "granny's house",
    "browser horror game",
    "free horror game",
    "fps horror game",
    "escape the house game",
    "no download horror game",
    "three.js game",
  ],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Granny's House: Scary Escape — Free Browser Horror Game",
    description:
      "Grandma is home. So is grandpa, and the thing they answer to. Find a weapon, kill what hunts you, and get out through the front door.",
    url: "/",
    siteName: "Granny's House: Scary Escape",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: "@Profexor",
    creator: "@Profexor",
    title: "Granny's House: Scary Escape — Free Browser Horror Game",
    description:
      "Find a weapon. Kill what hunts you. Get out. First-person horror in the browser — no download.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0905",
  colorScheme: "dark",
  // Game viewport: bleed under notches in fullscreen, no pinch/double-tap
  // zoom fighting the touch controls.
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

// Structured data: lets Google show this as a game in rich results.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "VideoGame",
  name: "Granny's House: Scary Escape",
  url: SITE,
  image: `${SITE}/opengraph-image.png`,
  description:
    "Free first-person horror game in the browser. Find a weapon in a decrepit rural house, put down grandma, grandpa and the devil, and escape through the front door.",
  genre: ["Horror", "Survival"],
  playMode: "SinglePlayer",
  gamePlatform: ["Web Browser"],
  applicationCategory: "Game",
  operatingSystem: "Any",
  inLanguage: "en",
  isAccessibleForFree: true,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
  author: {
    "@type": "Person",
    name: "Jennofrie",
    url: "https://github.com/Jennofrie/Horror-Granny",
    sameAs: ["https://x.com/Profexor", "https://github.com/Jennofrie/Horror-Granny"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${specialElite.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden bg-black text-zinc-200">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
          }}
        />
        {children}
        {/* Vercel-only — the CrazyGames bundle would just spam 404s */}
        {process.env.CG_EXPORT !== "1" && <Analytics />}
      </body>
    </html>
  );
}

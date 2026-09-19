import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// NOTE: `subsets: ["latin"]` only preloads Latin glyphs. Arabic and Urdu text
// currently falls through to a system font, which is acceptable for this admin
// harness but NOT for the widget — Phase 2 needs a font stack that actually
// covers Arabic script, or ar/ur customers get inconsistent rendering that
// looks broken next to the rest of the business's site.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "AI engine — admin",
  description: "Internal test harness for the caller AI agent engine.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

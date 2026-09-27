import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// `subsets: ["latin"]` covers both active languages (English, Italian). If a
// dormant locale is ever reactivated (ar/ur), this needs a font stack that
// actually carries Arabic script.
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

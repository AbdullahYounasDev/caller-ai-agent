import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// `subsets: ["latin"]` covers English. Urdu (the other active language, right-to-left)
// is set with a system font stack in globals.css — Latin web fonts have no Arabic
// script, and downloading a Nastaliq face on every page load is not worth it for an
// internal console.
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

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Meeting Bot Assistant",
  description: "Join meetings, analyze conversations, and provide intelligent assistance",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}

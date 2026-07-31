import Providers from "@/components/Providers";
import "./globals.css";

export const metadata = {
  title: "Griddy — Pick a Square. Take the Pot.",
  description: "Provably fair 5×5 grid game on Arc testnet. Stake USDC, pick a square, take the pot. Randomness by drand, verified on-chain.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, padding: 0, background: "#060B1C" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

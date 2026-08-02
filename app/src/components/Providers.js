"use client";
import { PrivyProvider } from "@privy-io/react-auth";
import { gameChain } from "@/lib/config";

export default function Providers({ children }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    return (
      <div style={{ color: "#FF5000", padding: 40, fontFamily: "monospace" }}>
        ERROR: NEXT_PUBLIC_PRIVY_APP_ID not set
      </div>
    );
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#3E8BFF",
        },
        embeddedWallets: {
          createOnLogin: "all-users",
          // showWalletUIs is deliberately NOT set here. Privy falls back to the
          // app's Dashboard setting, so per-transaction confirmations can be
          // turned off there without a redeploy. Hardcoding it false while the
          // Dashboard still requires confirmation is what made stakes hang on
          // "CONFIRMING TX..." — the wallet waited for an approval the player
          // was never shown.
        },
        defaultChain: gameChain,
        supportedChains: [gameChain],
        // X only. External wallets (MetaMask, OKX) were offered but never
        // completed a login here, and the game signs from the Privy embedded
        // wallet anyway — an injected wallet has no path through the flow.
        loginMethods: ["twitter"],
      }}
    >
      {children}
    </PrivyProvider>
  );
}

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
          // The app runs in user-controlled mode, so Privy must be allowed to
          // show its own confirmation/passcode prompt. With this false the
          // embedded wallet waits forever for an authorization the player is
          // never asked for, and the stake button hangs on "CONFIRMING TX...".
          showWalletUIs: true,
        },
        defaultChain: gameChain,
        supportedChains: [gameChain],
        loginMethods: ["twitter", "wallet"],
      }}
    >
      {children}
    </PrivyProvider>
  );
}

"use client";
import dynamic from "next/dynamic";

// The game IS the landing page. The marketing site lives at /home,
// and /play still renders this same component so old links keep working.
const TheGrid = dynamic(() => import("@/components/TheGrid"), {
  ssr: false,
});

export default function LandingPage() {
  return <TheGrid />;
}

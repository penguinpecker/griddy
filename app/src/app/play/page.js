"use client";
import dynamic from "next/dynamic";

const TheGrid = dynamic(() => import("../../components/TheGrid"), {
  ssr: false,
});

export default function PlayPage() {
  return <TheGrid />;
}

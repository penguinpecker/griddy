"use client";
import dynamic from "next/dynamic";
const HowToPlay = dynamic(() => import("../../components/HowToPlay"), { ssr: false });
export default function HowToPlayPage() { return <HowToPlay />; }

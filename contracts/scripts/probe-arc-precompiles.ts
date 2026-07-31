import { ethers } from "hardhat";

/**
 * Proves that Arc testnet's precompiles (BN254 add/mul/pairing + modexp)
 * verify a REAL drand evmnet beacon signature, without deploying anything:
 * deploys DrandBeacon on the local hardhat EVM, lifts its runtime bytecode
 * (immutables baked in), then eth_calls verifyBeaconRound(1, <real sig>) on
 * Arc testnet with a state override injecting that bytecode.
 *
 *   npx hardhat run scripts/probe-arc-precompiles.ts
 */

const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];
const SIG_ROUND_1: [bigint, bigint] = [
  0x11f812d738a36b2210dc88c2d635ad8039588205f42445d6de09e6530165c346n,
  0x2a23aca348c84badcf8df5321ac24577b7963d5b0d780bc4626baedb45cde373n,
];

const ARC_RPC = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";
const PROBE_ADDR = "0x00000000000000000000000000000000000dEEad";

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(ARC_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  const Beacon = await ethers.getContractFactory("DrandBeacon");
  const beacon = await Beacon.deploy(EVMNET_PUBKEY, 1727521075n, 3n);
  await beacon.waitForDeployment();
  const code = await ethers.provider.getCode(await beacon.getAddress());
  console.log(`Local beacon runtime bytecode: ${(code.length - 2) / 2} bytes`);

  const goodCall = beacon.interface.encodeFunctionData("verifyBeaconRound", [1n, SIG_ROUND_1]);
  const badCall = beacon.interface.encodeFunctionData("verifyBeaconRound", [2n, SIG_ROUND_1]);
  const override = { [PROBE_ADDR]: { code } };

  const chainId = await rpc("eth_chainId", []);
  console.log(`Probing chain ${parseInt(chainId.result, 16)} at ${ARC_RPC}`);

  const good = await rpc("eth_call", [{ to: PROBE_ADDR, data: goodCall }, "latest", override]);
  const bad = await rpc("eth_call", [{ to: PROBE_ADDR, data: badCall }, "latest", override]);

  const goodOk = good.result === "0x" && !good.error;
  const badRejected = !!bad.error;
  console.log(`verifyBeaconRound(1, real sig)  → ${goodOk ? "VERIFIED ✓" : `FAILED: ${JSON.stringify(good)}`}`);
  console.log(`verifyBeaconRound(2, wrong sig) → ${badRejected ? "correctly rejected ✓" : `NOT rejected: ${JSON.stringify(bad)}`}`);

  if (!goodOk || !badRejected) process.exit(1);
  console.log("Arc testnet precompiles verify drand evmnet beacons. ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

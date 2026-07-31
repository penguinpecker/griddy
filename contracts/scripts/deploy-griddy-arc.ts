import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Fresh Griddy deployment for Arc testnet (native-USDC stakes):
 *   1. DrandBeacon (immutable evmnet config — swappable via setBeacon)
 *   2. GriddyV4 behind a UUPS proxy (no reward token in V4)
 *
 *   npx hardhat run scripts/deploy-griddy-arc.ts --network arc-testnet
 */

// drand evmnet (League of Entropy), live-verified via https://api.drand.sh
const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];
const EVMNET_GENESIS = 1727521075n;
const EVMNET_PERIOD = 3n;

async function main() {
  const [deployer] = await ethers.getSigners();
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;

  console.log(`Network:       ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`Fee recipient: ${feeRecipient}`);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:       ${ethers.formatEther(bal)} USDC (native)`);
  if (bal < ethers.parseEther("0.5")) {
    throw new Error("Deployer needs at least 0.5 native USDC for gas");
  }

  const Beacon = await ethers.getContractFactory("DrandBeacon");
  const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  await beacon.waitForDeployment();
  console.log(`DrandBeacon:   ${await beacon.getAddress()}`);

  const GriddyF = await ethers.getContractFactory("GriddyV4");
  const griddy = await upgrades.deployProxy(
    GriddyF,
    [feeRecipient, await beacon.getAddress(), deployer.address],
    { kind: "uups" }
  );
  await griddy.waitForDeployment();
  const griddyAddr = await griddy.getAddress();
  console.log(`GriddyV4:      ${griddyAddr} (proxy)`);
  console.log(`  impl:        ${await upgrades.erc1967.getImplementationAddress(griddyAddr)}`);

  const out = {
    network: network.name,
    chainId: network.config.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    feeRecipient,
    drandBeacon: await beacon.getAddress(),
    griddy: griddyAddr,
    griddyImpl: await upgrades.erc1967.getImplementationAddress(griddyAddr),
    params: {
      minStakeWei: (await griddy.minStakeWei()).toString(),
      resolverTipWei: (await griddy.resolverTipWei()).toString(),
      protocolFeeBps: (await griddy.protocolFeeBps()).toString(),
      roundDuration: (await griddy.roundDuration()).toString(),
      beaconGap: (await griddy.beaconGap()).toString(),
    },
    drand: {
      network: "evmnet",
      chainHash: "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3",
      genesis: Number(EVMNET_GENESIS),
      period: Number(EVMNET_PERIOD),
    },
  };
  const file = path.join(__dirname, `../deployments/griddy-${network.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);

  // Post-deploy assertions — fail loudly rather than leave a half-wired game
  const checks: [string, boolean][] = [
    ["game owner is deployer", (await griddy.owner()) === deployer.address],
    ["beacon set", (await griddy.beacon()) === (await beacon.getAddress())],
    ["round 1 open", (await griddy.currentRoundId()) === 1n],
    ["not paused", (await griddy.paused()) === false],
  ];
  console.log(`\nPost-deploy checks:`);
  let allOk = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) allOk = false;
  }
  if (!allOk) throw new Error("post-deploy checks FAILED — inspect before use");

  console.log(`\nNEXT: run scripts/smoke-arc.ts to play a real round end-to-end`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

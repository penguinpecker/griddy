import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys DrandBeaconV2 behind a UUPS proxy (every new contract in this repo
 * ships behind a proxy) with the drand evmnet config, then points the live
 * Griddy proxy at it via setBeacon.
 *
 *   npx hardhat run scripts/deploy-beacon-v2.ts --network arc-testnet
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
  const file = path.join(__dirname, `../deployments/griddy-${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  if (network.config.chainId === 4663 && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("Mainnet beacon swap requires CONFIRM_MAINNET=yes");
  }

  console.log(`Network:  ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Griddy:   ${dep.griddy}`);

  const BeaconV2 = await ethers.getContractFactory("DrandBeaconV2");
  const beacon = await upgrades.deployProxy(
    BeaconV2,
    [deployer.address, EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD],
    { kind: "uups" }
  );
  await beacon.waitForDeployment();
  const beaconAddr = await beacon.getAddress();
  const beaconImpl = await upgrades.erc1967.getImplementationAddress(beaconAddr);
  console.log(`DrandBeaconV2: ${beaconAddr} (proxy)`);
  console.log(`  impl:        ${beaconImpl}`);

  const griddy = await ethers.getContractAt("GriddyV5", dep.griddy);
  const tx = await griddy.setBeacon(beaconAddr);
  await tx.wait();

  // Post-deploy assertions — fail loudly rather than leave a half-wired game
  const checks: [string, boolean][] = [
    ["beacon owner is deployer", (await beacon.owner()) === deployer.address],
    ["genesis matches evmnet", (await beacon.genesisTimestamp()) === EVMNET_GENESIS],
    ["period matches evmnet", (await beacon.period()) === EVMNET_PERIOD],
    ["griddy points at new beacon", (await griddy.beacon()) === beaconAddr],
  ];
  console.log(`\nPost-deploy checks:`);
  let allOk = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) allOk = false;
  }
  if (!allOk) throw new Error("post-deploy checks FAILED — inspect before use");

  dep.drandBeaconV2 = beaconAddr;
  dep.drandBeaconV2Impl = beaconImpl;
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

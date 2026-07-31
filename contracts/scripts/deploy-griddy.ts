import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the full Griddy stack to Robinhood Chain:
 *   1. DrandBeacon (drand evmnet constants)
 *   2. GriddyToken
 *   3. Griddy (game)
 *   4. GriddyToken.setMinter(game, true)
 *
 * Env: PRIVATE_KEY (funded deployer), optional FEE_RECIPIENT (defaults to deployer),
 *      optional USDG_ADDRESS override (defaults to canonical USDG on 4663).
 *
 *   npx hardhat run scripts/deploy-griddy.ts --network robinhood-testnet
 *   npx hardhat run scripts/deploy-griddy.ts --network robinhood
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

// Paxos Global Dollar on Robinhood Chain mainnet (6 decimals, verified)
const USDG_MAINNET = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

async function main() {
  const [deployer] = await ethers.getSigners();
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
  let usdgAddress = process.env.USDG_ADDRESS || USDG_MAINNET;

  console.log(`Network:       ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`Fee recipient: ${feeRecipient}`);

  // Testnet has no real USDG — deploy a mock and seed the deployer
  if (network.name === "robinhood-testnet" && !process.env.USDG_ADDRESS) {
    const MockUSDG = await ethers.getContractFactory("MockUSDG");
    const mock = await MockUSDG.deploy();
    await mock.waitForDeployment();
    await (await mock.mint(deployer.address, 1_000_000_000n)).wait(); // 1,000 USDG
    usdgAddress = await mock.getAddress();
    console.log(`MockUSDG:      ${usdgAddress} (minted 1,000 to deployer)`);
  }
  console.log(`USDG:          ${usdgAddress}`);

  const usdg = await ethers.getContractAt("MockUSDG", usdgAddress);
  const decimals = await usdg.decimals();
  if (decimals !== 6n) throw new Error(`Entry token has ${decimals} decimals, expected 6 — refusing to deploy`);

  const Beacon = await ethers.getContractFactory("DrandBeacon");
  const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  await beacon.waitForDeployment();
  console.log(`DrandBeacon:   ${await beacon.getAddress()}`);

  const GriddyToken = await ethers.getContractFactory("GriddyToken");
  const token = await GriddyToken.deploy();
  await token.waitForDeployment();
  console.log(`GriddyToken:    ${await token.getAddress()}`);

  const Griddy = await ethers.getContractFactory("Griddy");
  const griddy = await Griddy.deploy(
    usdgAddress,
    await token.getAddress(),
    feeRecipient,
    await beacon.getAddress()
  );
  await griddy.waitForDeployment();
  console.log(`Griddy:         ${await griddy.getAddress()}`);

  const tx = await token.setMinter(await griddy.getAddress(), true);
  await tx.wait();
  console.log(`setMinter(game) done: ${tx.hash}`);

  const out = {
    network: network.name,
    chainId: network.config.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    feeRecipient,
    usdg: usdgAddress,
    drandBeacon: await beacon.getAddress(),
    griddyToken: await token.getAddress(),
    griddy: await griddy.getAddress(),
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

  console.log(`\nVerify (Blockscout):`);
  console.log(`  npx hardhat verify --network ${network.name} ${await beacon.getAddress()} '[...pubkey]' ${EVMNET_GENESIS} ${EVMNET_PERIOD}`);
  console.log(`  npx hardhat verify --network ${network.name} ${await token.getAddress()}`);
  console.log(`  npx hardhat verify --network ${network.name} ${await griddy.getAddress()} ${usdgAddress} ${await token.getAddress()} ${feeRecipient} ${await beacon.getAddress()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

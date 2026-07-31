import { ethers } from "hardhat";

/**
 * Send native USDC (Arc's gas token) from the configured PRIVATE_KEY wallet.
 *
 *   TO=0x… AMOUNT=5 npx hardhat run scripts/send-native.ts --network arc-testnet
 */
async function main() {
  const to = process.env.TO;
  const amount = process.env.AMOUNT;
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to) || !amount) {
    throw new Error("Set TO=0x… and AMOUNT=<usdc>");
  }
  const [sender] = await ethers.getSigners();
  const before = await ethers.provider.getBalance(sender.address);
  console.log(`from: ${sender.address} ($${ethers.formatEther(before)})`);
  console.log(`to:   ${to}  amount: $${amount}`);
  const tx = await sender.sendTransaction({ to, value: ethers.parseEther(amount) });
  const rc = await tx.wait();
  console.log(`tx:   ${rc?.hash} (status ${rc?.status})`);
  console.log(`recipient balance now: $${ethers.formatEther(await ethers.provider.getBalance(to))}`);
  console.log(`sender balance now:    $${ethers.formatEther(await ethers.provider.getBalance(sender.address))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { expect } from "chai";
import hre from "hardhat";
import { parseEther } from "viem";

describe("SwapFallback", () => {
  async function deploy() {
    const [owner, alice, bob] = await hre.viem.getWalletClients();
    const pub = await hre.viem.getPublicClient();

    // Reuse the existing MockERC20 for USDso; mint to owner.
    const mockUsdso = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
    await mockUsdso.write.mint([owner.account.address, parseEther("1000")]);

    // 7 STT per 1 USDso, min 1 STT.
    const fb = await hre.viem.deployContract("SwapFallback", [
      mockUsdso.address,
      parseEther("7"),
      parseEther("1"),
    ]);

    // Seed 5 USDso into the fallback.
    await mockUsdso.write.transfer([fb.address, parseEther("5")]);

    return { owner, alice, bob, pub, mockUsdso, fb };
  }

  it("grants 1 USDso when user sends 7 STT", async () => {
    const { alice, pub, mockUsdso, fb } = await deploy();
    const aliceClient = await hre.viem.getWalletClient(alice.account.address);

    const beforeBal = await mockUsdso.read.balanceOf([alice.account.address]);
    expect(beforeBal).to.equal(0n);

    await aliceClient.writeContract({
      address: fb.address,
      abi: fb.abi,
      functionName: "fallbackSwap",
      value: parseEther("7"),
    });

    const afterBal = await mockUsdso.read.balanceOf([alice.account.address]);
    expect(afterBal).to.equal(parseEther("1"));

    // STT was retained by contract.
    const sttBal = await pub.getBalance({ address: fb.address });
    expect(sttBal).to.equal(parseEther("7"));
  });

  it("caps any single user at 1 USDso even when they overpay", async () => {
    const { alice, mockUsdso, fb } = await deploy();
    const aliceClient = await hre.viem.getWalletClient(alice.account.address);

    // Overpays 14 STT — owed would be 2 USDso but is capped at 1.
    await aliceClient.writeContract({
      address: fb.address,
      abi: fb.abi,
      functionName: "fallbackSwap",
      value: parseEther("14"),
    });

    const bal = await mockUsdso.read.balanceOf([alice.account.address]);
    expect(bal).to.equal(parseEther("1"));
  });

  it("rejects a second claim from the same address", async () => {
    const { alice, fb } = await deploy();
    const aliceClient = await hre.viem.getWalletClient(alice.account.address);

    await aliceClient.writeContract({
      address: fb.address,
      abi: fb.abi,
      functionName: "fallbackSwap",
      value: parseEther("7"),
    });

    await expect(
      aliceClient.writeContract({
        address: fb.address,
        abi: fb.abi,
        functionName: "fallbackSwap",
        value: parseEther("7"),
      })
    ).to.be.rejectedWith(/AlreadyClaimed/);
  });

  it("rejects calls below minSttIn", async () => {
    const { alice, fb } = await deploy();
    const aliceClient = await hre.viem.getWalletClient(alice.account.address);

    await expect(
      aliceClient.writeContract({
        address: fb.address,
        abi: fb.abi,
        functionName: "fallbackSwap",
        value: parseEther("0.5"),
      })
    ).to.be.rejectedWith(/AmountTooLow/);
  });

  it("owner can sweep STT and update rate", async () => {
    const { owner, alice, pub, fb } = await deploy();
    const ownerClient = await hre.viem.getWalletClient(owner.account.address);
    const aliceClient = await hre.viem.getWalletClient(alice.account.address);

    await aliceClient.writeContract({
      address: fb.address,
      abi: fb.abi,
      functionName: "fallbackSwap",
      value: parseEther("7"),
    });

    const sttBefore = await pub.getBalance({ address: fb.address });
    expect(sttBefore).to.equal(parseEther("7"));

    await ownerClient.writeContract({
      address: fb.address,
      abi: fb.abi,
      functionName: "sweepStt",
      args: [owner.account.address],
    });

    const sttAfter = await pub.getBalance({ address: fb.address });
    expect(sttAfter).to.equal(0n);

    await ownerClient.writeContract({
      address: fb.address,
      abi: fb.abi,
      functionName: "setRate",
      args: [parseEther("10"), parseEther("2")],
    });
    const rate = await fb.read.sttPerUsdso();
    expect(rate).to.equal(parseEther("10"));
  });

  it("non-owner cannot sweep or set rate", async () => {
    const { alice, fb } = await deploy();
    const aliceClient = await hre.viem.getWalletClient(alice.account.address);

    await expect(
      aliceClient.writeContract({
        address: fb.address,
        abi: fb.abi,
        functionName: "sweepStt",
        args: [alice.account.address],
      })
    ).to.be.rejectedWith(/NotOwner/);
  });
});

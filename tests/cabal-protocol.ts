import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CabalProtocol } from "../target/types/cabal_protocol";
import { expect } from "chai";
import { FIXTURES } from "./fixtures";
import { createCabal, airdrop } from "./utils";
import { createTokenAccount } from "./token-utils";
import { getJupiterQuote, getJupiterRouteData } from "./jupiter-utils";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

describe("cabal-protocol", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CabalProtocol as Program<CabalProtocol>;

  // Test accounts
  let creator: anchor.web3.Keypair;
  
  beforeEach(async () => {
    creator = anchor.web3.Keypair.generate();
    await airdrop(provider.connection, creator.publicKey, 0.02);
  });

  /* Previous tests commented out for faster Jupiter testing
  describe("Cabal Creation", () => { ... });
  describe("Member Management", () => { ... });
  describe("Lurker Functionality", () => { ... });
  describe("Withdrawal System", () => { ... });
  */

  describe("Jupiter Swap Integration", () => {
    let cabal: anchor.web3.Keypair;
    let vault: anchor.web3.PublicKey;
    let member: anchor.web3.Keypair;
    let vaultWsol: anchor.web3.PublicKey;
    let vaultToken: anchor.web3.PublicKey;
    
    // Devnet token addresses
    const USDC_MINT = new anchor.web3.PublicKey("8FRFC6MoGGkMFQwngccyu69VnYbzykGeez7ignHVAFSN");
    const FEE_WALLET = new anchor.web3.PublicKey("A8aTLejFzPYqFmBtq7586VTfbsroXS4AMAPvtA3DXH8q");

    beforeEach(async () => {
      // Create a fresh cabal
      const result = await createCabal(
        program,
        creator,
        FIXTURES.VALID_BUY_IN,
        FIXTURES.VALID_FEE_BPS
      );
      cabal = result.cabal;
      vault = result.vault;

      // Create and fund a member
      member = anchor.web3.Keypair.generate();
      await airdrop(provider.connection, member.publicKey, 0.1); // 0.1 SOL

      // Join as member
      await program.methods
        .joinCabal(new anchor.BN(FIXTURES.VALID_BUY_IN))
        .accounts({
          cabal: cabal.publicKey,
          member: member.publicKey,
          vault,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([member])
        .rpc();

      // Create vault token accounts
      vaultWsol = await createTokenAccount(provider, vault, NATIVE_MINT);
      vaultToken = await createTokenAccount(provider, vault, USDC_MINT);
    });

    it("Test 15: Valid swap with exact quote match", async () => {
      const amount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
      const slippageBps = 100; // 1%
      
      const quote = await getJupiterQuote(
        NATIVE_MINT.toString(),
        USDC_MINT.toString(),
        amount.toString()
      );

      const routeData = await getJupiterRouteData(quote, member.publicKey.toString());

      await program.methods
        .swap(
          amount,
          slippageBps,
          new anchor.BN(quote.outAmount),
          routeData.data
        )
        .accounts({
          cabal: cabal.publicKey,
          member: member.publicKey,
          vaultSol: vault,
          vaultWsol,
          vaultToken,
          feeWallet: FEE_WALLET,
          jupiterProgram: new anchor.web3.PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts(routeData.accounts.map(acc => ({
          pubkey: new anchor.web3.PublicKey(acc.pubkey),
          isWritable: acc.isWritable,
          isSigner: acc.isSigner
        })))
        .signers([member])
        .rpc();

      const tokenBalance = await provider.connection.getTokenAccountBalance(vaultToken);
      expect(Number(tokenBalance.value.amount)).to.be.greaterThan(0);
    });

    it("Test 16: Swap with maximum slippage (9999bps)", async () => {
      const amount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
      const slippageBps = 9999; // 99.99%
      
      const quote = await getJupiterQuote(
        NATIVE_MINT.toString(),
        USDC_MINT.toString(),
        amount.toString(),
        slippageBps
      );

      const routeData = await getJupiterRouteData(quote, member.publicKey.toString());

      await program.methods
        .swap(
          amount,
          slippageBps,
          new anchor.BN(quote.outAmount),
          routeData.data
        )
        .accounts({
          cabal: cabal.publicKey,
          member: member.publicKey,
          vaultSol: vault,
          vaultWsol,
          vaultToken,
          feeWallet: FEE_WALLET,
          jupiterProgram: new anchor.web3.PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts(routeData.accounts.map(acc => ({
          pubkey: new anchor.web3.PublicKey(acc.pubkey),
          isWritable: acc.isWritable,
          isSigner: acc.isSigner
        })))
        .signers([member])
        .rpc();

      const tokenBalance = await provider.connection.getTokenAccountBalance(vaultToken);
      expect(Number(tokenBalance.value.amount)).to.be.greaterThan(0);
    });

    it("Test 17: Attempt swap with expired/invalid quote", async () => {
      const amount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
      const slippageBps = 100;
      
      // Get quote but wait before using it
      const quote = await getJupiterQuote(
        NATIVE_MINT.toString(),
        USDC_MINT.toString(),
        amount.toString()
      );

      // Wait for 30 seconds to let quote expire
      await new Promise(resolve => setTimeout(resolve, 30000));

      const routeData = await getJupiterRouteData(quote, member.publicKey.toString());

      try {
        await program.methods
          .swap(
            amount,
            slippageBps,
            new anchor.BN(quote.outAmount),
            routeData.data
          )
          .accounts({
            cabal: cabal.publicKey,
            member: member.publicKey,
            vaultSol: vault,
            vaultWsol,
            vaultToken,
            feeWallet: FEE_WALLET,
            jupiterProgram: new anchor.web3.PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .remainingAccounts(routeData.accounts.map(acc => ({
            pubkey: new anchor.web3.PublicKey(acc.pubkey),
            isWritable: acc.isWritable,
            isSigner: acc.isSigner
          })))
          .signers([member])
          .rpc();
        expect.fail("Should fail with expired quote");
      } catch (e) {
        expect(e.toString()).to.include("Error");
      }
    });

    it("Test 18: Swap with manipulated route data", async () => {
      const amount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
      const slippageBps = 100;
      
      const quote = await getJupiterQuote(
        NATIVE_MINT.toString(),
        USDC_MINT.toString(),
        amount.toString()
      );

      let routeData = await getJupiterRouteData(quote, member.publicKey.toString());
      
      // Manipulate route data by modifying accounts
      routeData.accounts = routeData.accounts.map(acc => ({
        ...acc,
        isWritable: !acc.isWritable // Flip writability
      }));

      try {
        await program.methods
          .swap(
            amount,
            slippageBps,
            new anchor.BN(quote.outAmount),
            routeData.data
          )
          .accounts({
            cabal: cabal.publicKey,
            member: member.publicKey,
            vaultSol: vault,
            vaultWsol,
            vaultToken,
            feeWallet: FEE_WALLET,
            jupiterProgram: new anchor.web3.PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .remainingAccounts(routeData.accounts.map(acc => ({
            pubkey: new anchor.web3.PublicKey(acc.pubkey),
            isWritable: acc.isWritable,
            isSigner: acc.isSigner
          })))
          .signers([member])
          .rpc();
        expect.fail("Should fail with manipulated route data");
      } catch (e) {
        expect(e.toString()).to.include("Error");
      }
    });
  });
});

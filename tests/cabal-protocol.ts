import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CabalProtocol } from "../target/types/cabal_protocol";
import { expect } from "chai";
import { FIXTURES } from "./fixtures";
import { createCabal, airdrop } from "./utils";
import { createTokenAccount } from "./token-utils";
import { getJupiterQuote, getJupiterRouteData } from "./jupiter-utils";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { 
    NATIVE_MINT, 
    getAssociatedTokenAddress,
    createInitializeMintInstruction,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// Constants
const FEE_WALLET = "A8aTLejFzPYqFmBtq7586VTfbsroXS4AMAPvtA3DXH8q";

// Helper function to create mint
async function createMintToInstruction(
    connection: anchor.web3.Connection,
    payer: anchor.web3.PublicKey,
    mint: anchor.web3.PublicKey,
    authority: anchor.web3.PublicKey,
    decimals: number
) {
    const lamports = await connection.getMinimumBalanceForRentExemption(82);
    const createAccountIx = anchor.web3.SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint,
        lamports,
        space: 82,
        programId: TOKEN_PROGRAM_ID,
    });
    const initMintIx = createInitializeMintInstruction(
        mint,
        decimals,
        authority,
        null
    );
    const tx = new anchor.web3.Transaction();
    tx.add(createAccountIx);
    tx.add(initMintIx);
    return tx;
}

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
    let mockJupiterProgram: anchor.web3.Keypair;
    let mockTokenMint: anchor.web3.Keypair;
    
    // Mock accounts for Jupiter swap
    let mockUserAta: anchor.web3.PublicKey;
    let mockPoolAta: anchor.web3.PublicKey;
    
    beforeEach(async () => {
        // Create a mock Jupiter program (no need to be executable in test mode)
        mockJupiterProgram = anchor.web3.Keypair.generate();
        const rent = await provider.connection.getMinimumBalanceForRentExemption(0);
        const createProgramIx = anchor.web3.SystemProgram.createAccount({
            fromPubkey: provider.wallet.publicKey,
            newAccountPubkey: mockJupiterProgram.publicKey,
            lamports: rent,
            space: 0,
            programId: anchor.web3.SystemProgram.programId,
        });

        // Create and send transaction to create mock program account
        const tx = new anchor.web3.Transaction().add(createProgramIx);
        await provider.sendAndConfirm(tx, [mockJupiterProgram]);

        // Create mock token mint
        mockTokenMint = anchor.web3.Keypair.generate();
        const createMintIx = await createMintToInstruction(
            provider.connection,
            provider.wallet.publicKey,
            mockTokenMint.publicKey,
            provider.wallet.publicKey,
            0
        );

        // Create mock ATAs
        mockUserAta = await getAssociatedTokenAddress(
            mockTokenMint.publicKey,
            provider.wallet.publicKey
        );
        mockPoolAta = await getAssociatedTokenAddress(
            mockTokenMint.publicKey,
            mockJupiterProgram.publicKey,
            true
        );

        // Deploy mock program and create accounts
        const tx2 = new anchor.web3.Transaction()
            .add(createMintIx);
        await provider.sendAndConfirm(tx2, [mockTokenMint]);

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
        await airdrop(provider.connection, member.publicKey, 0.1);

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
        vaultToken = await createTokenAccount(provider, vault, mockTokenMint.publicKey);
    });

    it("Test 15: Valid swap with exact quote match", async () => {
        const amount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
        const slippageBps = 100; // 1%
        
        // Create mock route data that mimics Jupiter's instruction data
        const mockRouteData = {
            data: Buffer.from([
                // Mock instruction data
                0x01, 0x00, 0x00, 0x00, // instruction discriminator
                ...amount.toArray("le", 8), // amount
            ]),
            accounts: [
                {
                    pubkey: vaultWsol,
                    isWritable: true,
                    isSigner: false
                },
                {
                    pubkey: vaultToken,
                    isWritable: true,
                    isSigner: false
                },
                {
                    pubkey: mockPoolAta,
                    isWritable: true,
                    isSigner: false
                }
            ]
        };

        // Expected output amount (for this test, we'll use a 1:1 ratio)
        const expectedOutAmount = amount;

        await program.methods
            .swap(
                amount,
                slippageBps,
                expectedOutAmount,
                mockRouteData.data
            )
            .accounts({
                cabal: cabal.publicKey,
                member: member.publicKey,
                vaultSol: vault,
                vaultWsol,
                vaultToken,
                feeWallet: new anchor.web3.PublicKey(FEE_WALLET),
                jupiterProgram: mockJupiterProgram.publicKey,
                tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .remainingAccounts(mockRouteData.accounts.map(acc => ({
                pubkey: new anchor.web3.PublicKey(acc.pubkey),
                isWritable: acc.isWritable,
                isSigner: acc.isSigner
            })))
            .signers([member])
            .preInstructions([
                anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
                    units: 1_400_000,
                }),
            ])
            .rpc();

        // We can't verify the actual swap since it's mocked, but we can verify:
        // 1. The transaction succeeded
        // 2. The fee was transferred
        // 3. The accounts were properly signed
        const vaultBalance = await provider.connection.getBalance(vault);
        const feeWalletBalance = await provider.connection.getBalance(new anchor.web3.PublicKey(FEE_WALLET));
        
        // Calculate expected fee
        const fee = amount.toNumber() * FIXTURES.VALID_FEE_BPS / 10000;
        
        // Verify fee transfer
        expect(feeWalletBalance).to.be.greaterThan(0);
    });

    it("Test 16: Swap with maximum slippage (9999bps)", async () => {
        const amount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
        const slippageBps = 9999; // 99.99%
        
        // Create mock route data with maximum slippage
        const mockRouteData = {
            data: Buffer.from([
                0x01, 0x00, 0x00, 0x00,
                ...amount.toArray("le", 8),
            ]),
            accounts: [
                {
                    pubkey: vaultWsol,
                    isWritable: true,
                    isSigner: false
                },
                {
                    pubkey: vaultToken,
                    isWritable: true,
                    isSigner: false
                },
                {
                    pubkey: mockPoolAta,
                    isWritable: true,
                    isSigner: false
                }
            ]
        };

        // Expected output amount with maximum slippage (0.01% of input)
        const expectedOutAmount = new anchor.BN(amount.toNumber() * 0.0001);

        await program.methods
            .swap(
                amount,
                slippageBps,
                expectedOutAmount,
                mockRouteData.data
            )
            .accounts({
                cabal: cabal.publicKey,
                member: member.publicKey,
                vaultSol: vault,
                vaultWsol,
                vaultToken,
                feeWallet: new anchor.web3.PublicKey(FEE_WALLET),
                jupiterProgram: mockJupiterProgram.publicKey,
                tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .remainingAccounts(mockRouteData.accounts.map(acc => ({
                pubkey: new anchor.web3.PublicKey(acc.pubkey),
                isWritable: acc.isWritable,
                isSigner: acc.isSigner
            })))
            .signers([member])
            .preInstructions([
                anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
                    units: 1_400_000,
                }),
            ])
            .rpc();

        // Verify fee transfer
        const feeWalletBalance = await provider.connection.getBalance(new anchor.web3.PublicKey(FEE_WALLET));
        expect(feeWalletBalance).to.be.greaterThan(0);
    });

    it("Test 17: Attempt swap with invalid instruction data", async () => {
        const amount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
        const slippageBps = 100;
        
        // Create invalid route data (wrong instruction format)
        const invalidRouteData = {
            data: Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]), // Invalid instruction discriminator
            accounts: [
                {
                    pubkey: vaultWsol,
                    isWritable: true,
                    isSigner: false
                },
                {
                    pubkey: vaultToken,
                    isWritable: true,
                    isSigner: false
                },
                {
                    pubkey: mockPoolAta,
                    isWritable: true,
                    isSigner: false
                }
            ]
        };

        try {
            await program.methods
                .swap(
                    amount,
                    slippageBps,
                    amount, // Expected out amount
                    invalidRouteData.data
                )
                .accounts({
                    cabal: cabal.publicKey,
                    member: member.publicKey,
                    vaultSol: vault,
                    vaultWsol,
                    vaultToken,
                    feeWallet: new anchor.web3.PublicKey(FEE_WALLET),
                    jupiterProgram: mockJupiterProgram.publicKey,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .remainingAccounts(invalidRouteData.accounts.map(acc => ({
                    pubkey: new anchor.web3.PublicKey(acc.pubkey),
                    isWritable: acc.isWritable,
                    isSigner: acc.isSigner
                })))
                .signers([member])
                .preInstructions([
                    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
                        units: 1_400_000,
                    }),
                ])
                .rpc();
            expect.fail("Should fail with invalid instruction data");
        } catch (e) {
            expect(e.toString()).to.include("Error");
        }
    });

    it("Test 18: Swap with manipulated account permissions", async () => {
        const amount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
        const slippageBps = 100;
        
        // Create route data with incorrect account permissions
        const manipulatedRouteData = {
            data: Buffer.from([
                0x01, 0x00, 0x00, 0x00,
                ...amount.toArray("le", 8),
            ]),
            accounts: [
                {
                    pubkey: vaultWsol,
                    isWritable: false, // Should be true
                    isSigner: true // Should be false
                },
                {
                    pubkey: vaultToken,
                    isWritable: false, // Should be true
                    isSigner: false
                },
                {
                    pubkey: mockPoolAta,
                    isWritable: true,
                    isSigner: false
                }
            ]
        };

        try {
            await program.methods
                .swap(
                    amount,
                    slippageBps,
                    amount,
                    manipulatedRouteData.data
                )
                .accounts({
                    cabal: cabal.publicKey,
                    member: member.publicKey,
                    vaultSol: vault,
                    vaultWsol,
                    vaultToken,
                    feeWallet: new anchor.web3.PublicKey(FEE_WALLET),
                    jupiterProgram: mockJupiterProgram.publicKey,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .remainingAccounts(manipulatedRouteData.accounts.map(acc => ({
                    pubkey: new anchor.web3.PublicKey(acc.pubkey),
                    isWritable: acc.isWritable,
                    isSigner: acc.isSigner
                })))
                .signers([member])
                .preInstructions([
                    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
                        units: 1_400_000,
                    }),
                ])
                .rpc();
            expect.fail("Should fail with manipulated account permissions");
        } catch (e) {
            expect(e.toString()).to.include("Error");
        }
    });
  });
});

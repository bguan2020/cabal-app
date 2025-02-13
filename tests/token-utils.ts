import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction } from "@solana/spl-token";

// Use exact program IDs from the error logs
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export async function createTokenAccount(
    provider: anchor.AnchorProvider,
    owner: PublicKey,
    mint: PublicKey
  ): Promise<PublicKey> {
    const connection = provider.connection;
    
    // Get ATA address
    const ata = await getAssociatedTokenAddress(
      mint,
      owner,
      true, // Allow owner off-curve since we're working with PDAs
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  
    // Check if ATA exists
    const accountInfo = await connection.getAccountInfo(ata);
    if (accountInfo) return ata;
  
    // Create instruction using official helper
    const ix = createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey,
      ata,
      owner,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  
    // Send transaction
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx);
  
    return ata;
  }
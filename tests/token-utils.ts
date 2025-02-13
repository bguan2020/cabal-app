import * as anchor from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { PublicKey, Connection, clusterApiUrl, Transaction } from "@solana/web3.js";

// Program ID from Anchor.toml
const PROGRAM_ID = new PublicKey("3jUomWjaKdsxzKt6Tn5DkzeAy3Yw686XDdT8dyWVeVmq");

export async function createTokenAccount(
    provider: anchor.AnchorProvider,
    owner: PublicKey,
    mint: PublicKey
  ): Promise<PublicKey> {
    // Create explicit devnet connection
    const connection = new Connection(clusterApiUrl('devnet'), {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000
    });
    
    // Use Anchor's token program ID
    const TOKEN_PROGRAM_ID = anchor.utils.token.TOKEN_PROGRAM_ID;
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    
    console.log("Using Token Program ID:", TOKEN_PROGRAM_ID.toString());
    console.log("Using Associated Token Program ID:", ASSOCIATED_TOKEN_PROGRAM_ID.toString());
    console.log("Creating token account for owner:", owner.toString());
    console.log("Mint:", mint.toString());
    
    try {
      // Find PDA bump if owner is a PDA
      let ownerBump: number | undefined;
      try {
        [, ownerBump] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), owner.toBuffer()],
          PROGRAM_ID
        );
      } catch (e) {
        // Not a PDA, continue normally
      }

      // First try to get the token account
      const ata = await getAssociatedTokenAddress(
        mint,
        owner,
        true, // allowOwnerOffCurve
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      console.log("Derived ATA:", ata.toString());

      // Check if account exists
      const account = await connection.getAccountInfo(ata);
      
      if (!account) {
        console.log("Token account doesn't exist, creating...");
        console.log("Owner is PDA:", ownerBump !== undefined);
        
        const instruction = createAssociatedTokenAccountInstruction(
          provider.wallet.publicKey, // payer
          ata, // ata
          owner, // owner
          mint, // mint
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const transaction = new Transaction();
        transaction.add(instruction);

        // Get a recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.feePayer = provider.wallet.publicKey;

        // If owner is a PDA, we need to handle it specially
        if (ownerBump !== undefined) {
          try {
            // Sign and send the transaction directly
            const signed = await provider.wallet.signTransaction(transaction);
            const signature = await connection.sendRawTransaction(signed.serialize(), {
              skipPreflight: true,
              preflightCommitment: 'confirmed',
            });
            await connection.confirmTransaction({
              signature,
              blockhash,
              lastValidBlockHeight
            });
            console.log("Created token account for PDA:", signature);
          } catch (e) {
            console.error("Failed to create token account:", e);
            throw e;
          }
        } else {
          const signature = await provider.sendAndConfirm(transaction);
          console.log("Created token account:", signature);
        }
      } else {
        console.log("Token account already exists");
      }

      return ata;
    } catch (error) {
      console.error("Error details:", error);
      throw error;
    }
  }
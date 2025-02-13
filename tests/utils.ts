import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CabalProtocol } from "../target/types/cabal_protocol";
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";

export async function createCabal(
  program: Program<CabalProtocol>,
  creator: anchor.web3.Keypair,
  buyIn: number,
  feeBps: number
) {
  const cabal = anchor.web3.Keypair.generate();
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), cabal.publicKey.toBuffer()],
    program.programId
  );

  await program.methods
    .createCabal(new anchor.BN(buyIn), feeBps)
    .accounts({
      cabal: cabal.publicKey,
      creator: creator.publicKey,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([cabal, creator])
    .rpc();

  return { cabal, vault };
}

export async function airdrop(
  connection: anchor.web3.Connection,
  to: PublicKey,
  amount: number
) {
  // Get the provider
  const provider = anchor.AnchorProvider.env();
  
  // Create transfer instruction
  const transferIx = SystemProgram.transfer({
    fromPubkey: provider.wallet.publicKey,
    toPubkey: to,
    lamports: amount * LAMPORTS_PER_SOL,
  });

  // Create transaction and add recent blockhash
  const tx = new Transaction();
  const latestBlockhash = await connection.getLatestBlockhash();
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = provider.wallet.publicKey;
  tx.add(transferIx);

  // Sign and send transaction
  await provider.wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({
    signature,
    ...latestBlockhash
  });
} 
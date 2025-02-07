use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction,
};
use anchor_spl::token::{self, Token, TokenAccount};
use std::str::FromStr;

declare_id!("5YXX6Fm8nQFcXRHvwGGeo1uK86VtPpzU8Gd8Qr2VgLsT");

/// Replace with actual fee wallet address
pub const FEE_WALLET_STR: &str = "A8aTLejFzPYqFmBtq7586VTfbsroXS4AMAPvtA3DXH8q";

/// Jupiter v6 mainnet program ID
const JUPITER_PROGRAM_ID: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const FEE_BPS: u64 = 100; // 1% fee

#[program]
pub mod cabal_protocol {
    use super::*;

    /// Creates a new Cabal with initial deposit
    pub fn create_cabal(ctx: Context<CreateCabal>, buy_in: u64) -> Result<()> {
        let cabal = &mut ctx.accounts.cabal;
        cabal.creator = ctx.accounts.creator.key();
        cabal.buy_in = buy_in;
        cabal.members.push(ctx.accounts.creator.key());

        // Transfer initial deposit (must equal buy_in)
        let transfer_ix = system_instruction::transfer(
            &ctx.accounts.creator.key(),
            &ctx.accounts.vault.key(),
            buy_in,
        );

        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[
                b"vault",
                ctx.accounts.cabal.key().as_ref(),
                &[ctx.bumps.vault],
            ]],
        )?;

        Ok(())
    }

    /// Join existing Cabal with matching deposit
    pub fn join_cabal(ctx: Context<JoinCabal>, deposit: u64) -> Result<()> {
        let cabal = &mut ctx.accounts.cabal;

        require!(cabal.members.len() < 6, CabalError::CabalFull);
        require!(
            !cabal.members.contains(&ctx.accounts.member.key()),
            CabalError::AlreadyMember
        );
        require!(deposit >= cabal.buy_in, CabalError::InsufficientDeposit);

        // Transfer member's deposit
        let transfer_ix = system_instruction::transfer(
            &ctx.accounts.member.key(),
            &ctx.accounts.vault.key(),
            deposit,
        );

        invoke(
            &transfer_ix,
            &[
                ctx.accounts.member.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        cabal.members.push(ctx.accounts.member.key());
        Ok(())
    }

    /// Withdraw member's share of vault funds
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let cabal = &mut ctx.accounts.cabal;
        let member_key = ctx.accounts.member.key();

        require!(cabal.members.contains(&member_key), CabalError::NotMember);
        require!(cabal.members.len() > 0, CabalError::CabalEmpty);

        let vault_balance = **ctx.accounts.vault.to_account_info().lamports.borrow();
        let remaining_members = cabal.members.len() as u64;
        let share = vault_balance
            .checked_div(remaining_members)
            .ok_or(CabalError::MathError)?;

        require!(share > 0, CabalError::NothingToWithdraw);

        // Transfer share to member
        let transfer_ix =
            system_instruction::transfer(&ctx.accounts.vault.key(), &member_key, share);

        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.member.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[
                b"vault",
                ctx.accounts.cabal.key().as_ref(),
                &[ctx.bumps.vault],
            ]],
        )?;

        // Remove member from Cabal
        cabal.members.retain(|&k| k != member_key);
        Ok(())
    }

    /// Swap SOL from cabal vault to SPL token via Jupiter
    pub fn swap(
        ctx: Context<Swap>,
        amount: u64,
        slippage_bps: u16,
        quote: u64, // From off-chain Jupiter quote
    ) -> Result<()> {
        let cabal = &ctx.accounts.cabal;
        let member = &ctx.accounts.member;
        
        // 1. Verify caller is cabal member
        require!(
            cabal.members.contains(&member.key()),
            CabalError::NotMember
        );

        // 2. Calculate fees and swap amount
        let fee = amount
            .checked_mul(FEE_BPS)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(CabalError::MathError)?;
        
        let swap_amount = amount.checked_sub(fee).ok_or(CabalError::MathError)?;

        // 3. Calculate min output with slippage
        let min_out = quote
            .checked_mul(u64::from(10_000 - slippage_bps))
            .and_then(|v| v.checked_div(10_000))
            .ok_or(CabalError::MathError)?;

        // 4. Transfer fee to fee wallet
        let fee_ix = system_instruction::transfer(
            ctx.accounts.vault_sol.key,
            ctx.accounts.fee_wallet.key,
            fee,
        );
        
        invoke_signed(
            &fee_ix,
            &[
                ctx.accounts.vault_sol.to_account_info(),
                ctx.accounts.fee_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[
                b"vault",
                ctx.accounts.cabal.key().as_ref(),
                &[ctx.bumps.vault],
            ]],
        )?;

        // 5. Perform Jupiter swap
        let cpi_ctx = CpiContext::new(
            ctx.accounts.jupiter_program.to_account_info(),
            jupiter::Swap {
                authority: ctx.accounts.vault_sol.to_account_info(),
                source_token: ctx.accounts.vault_sol.to_account_info(),
                destination_token: ctx.accounts.vault_token.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                // ... other required Jupiter accounts
            },
        );
        
        jupiter::swap(
            cpi_ctx,
            swap_amount,
            min_out,
            ctx.accounts.output_mint.key(),
        )?;

        Ok(())
    }
}

// Account Structures

/// Creates a new Cabal
#[derive(Accounts)]
pub struct CreateCabal<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + 32 + 8 + 4 + (32 * 6) // Account layout
    )]
    pub cabal: Account<'info, Cabal>,

    #[account(
        init,
        payer = creator,
        seeds = [b"vault", cabal.key().as_ref()],
        bump,
        space = 0 // Pure SOL vault
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Join an existing Cabal
#[derive(Accounts)]
pub struct JoinCabal<'info> {
    #[account(mut)]
    pub cabal: Account<'info, Cabal>,

    #[account(
        mut,
        seeds = [b"vault", cabal.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub member: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Withdraw from Cabal
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub cabal: Account<'info, Cabal>,

    #[account(
        mut,
        seeds = [b"vault", cabal.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub member: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub cabal: Account<'info, Cabal>,
    
    /// CHECK: PDA vault for SOL
    #[account(
        mut,
        seeds = [b"vault", cabal.key().as_ref()],
        bump,
    )]
    pub vault_sol: SystemAccount<'info>,
    
    /// CHECK: Jupiter program
    #[account(address = Pubkey::from_str(JUPITER_PROGRAM_ID).unwrap())]
    pub jupiter_program: AccountInfo<'info>,
    
    /// Token account for vault to receive swapped tokens
    #[account(
        mut,
        associated_token::mint = output_mint,
        associated_token::authority = vault_sol,
    )]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    
    #[account(mut)]
    pub output_mint: Account<'info, token::Mint>,
    
    #[account(mut, address = Pubkey::from_str(FEE_WALLET_STR).unwrap())]
    pub fee_wallet: SystemAccount<'info>,
    
    #[account(mut)]
    pub member: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// Data Structures

#[account]
pub struct Cabal {
    pub creator: Pubkey,
    pub buy_in: u64,
    pub members: Vec<Pubkey>, // Max 6
}

#[error_code]
pub enum CabalError {
    #[msg("Insufficient deposit")]
    InsufficientDeposit,
    #[msg("Cabal full (max 6 members)")]
    CabalFull,
    #[msg("Not a cabal member")]
    NotMember,
    #[msg("Already a member")]
    AlreadyMember,
    #[msg("Math error")]
    MathError,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Cabal has no members")]
    CabalEmpty,
}

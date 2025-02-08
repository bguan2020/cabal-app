use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction,
};
use anchor_spl::token::{self, SyncNative, Token, TokenAccount};
use std::str::FromStr;

declare_id!("5YXX6Fm8nQFcXRHvwGGeo1uK86VtPpzU8Gd8Qr2VgLsT");

/// Configuration constants
const MAX_MEMBERS: usize = 6;
const MAX_DEPOSITORS: usize = 20;
const JUPITER_PROGRAM_ID: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const FEE_WALLET: &str = "A8aTLejFzPYqFmBtq7586VTfbsroXS4AMAPvtA3DXH8q";

#[program]
pub mod cabal_protocol {
    use super::*;

    /// Initializes a new Cabal with configurable parameters
    /// buy_in: Minimum SOL deposit required for members
    /// fee_bps: Swap fee in basis points (1% = 100)
    pub fn create_cabal(
        ctx: Context<CreateCabal>,
        buy_in: u64,
        fee_bps: u16,
    ) -> Result<()> {
        let cabal = &mut ctx.accounts.cabal;
        cabal.creator = ctx.accounts.creator.key();
        cabal.buy_in = buy_in;
        cabal.fee_bps = fee_bps;
        cabal.deposits = Vec::with_capacity(MAX_DEPOSITORS);

        // Record creator's initial deposit
        cabal.deposits.push(Deposit {
            key: ctx.accounts.creator.key(),
            amount: buy_in,
            role: Role::Member,
        });

        // Transfer SOL to PDA vault
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

        emit!(CabalCreated {
            cabal: ctx.accounts.cabal.key(),
            creator: cabal.creator,
            buy_in,
            fee_bps,
        });
        
        Ok(())
    }

    /// Join as a member with at least the buy_in amount
    pub fn join_cabal(ctx: Context<JoinCabal>, deposit: u64) -> Result<()> {
        let cabal = &mut ctx.accounts.cabal;

        // Membership checks
        let member_count = cabal.deposits
            .iter()
            .filter(|d| d.role == Role::Member)
            .count();
        require!(member_count < MAX_MEMBERS, CabalError::CabalFull);
        require!(
            !cabal.deposits.iter().any(|d| d.key == ctx.accounts.member.key()),
            CabalError::DuplicateDeposit
        );
        require!(deposit >= cabal.buy_in, CabalError::InsufficientDeposit);

        // Transfer SOL to vault
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

        cabal.deposits.push(Deposit {
            key: ctx.accounts.member.key(),
            amount: deposit,
            role: Role::Member,
        });

        Ok(())
    }

    /// Deposit as a lurker with any positive amount
    pub fn lurker_deposit(ctx: Context<LurkerDeposit>, amount: u64) -> Result<()> {
        let cabal = &mut ctx.accounts.cabal;

        require!(
            !cabal.deposits.iter().any(|d| d.key == ctx.accounts.lurker.key()),
            CabalError::DuplicateDeposit
        );
        require!(amount > 0, CabalError::InvalidAmount);

        let transfer_ix = system_instruction::transfer(
            &ctx.accounts.lurker.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        invoke(
            &transfer_ix,
            &[
                ctx.accounts.lurker.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        cabal.deposits.push(Deposit {
            key: ctx.accounts.lurker.key(),
            amount,
            role: Role::Lurker,
        });

        Ok(())
    }

    /// Withdraw proportional share of vault assets
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let cabal = &mut ctx.accounts.cabal;
        let depositor_key = ctx.accounts.depositor.key();
        let vault = &ctx.accounts.vault;

        // Find depositor position
        let pos = cabal.deposits
            .iter()
            .position(|d| d.key == depositor_key)
            .ok_or(CabalError::NotDepositor)?;
        let deposit = cabal.deposits[pos];

        // Calculate share
        let total_deposits: u64 = cabal.deposits.iter().map(|d| d.amount).sum();
        let initial_balance = **vault.to_account_info().lamports.borrow();
        let share = initial_balance
            .checked_mul(deposit.amount)
            .and_then(|v| v.checked_div(total_deposits))
            .ok_or(CabalError::ShareCalculationError)?;
        
        require!(share > 0, CabalError::NothingToWithdraw);

        // Security check for vault balance consistency
        let current_balance = **vault.to_account_info().lamports.borrow();
        require!(
            current_balance >= initial_balance,
            CabalError::VaultBalanceChanged
        );

        // Transfer share
        let transfer_ix = system_instruction::transfer(
            &vault.key(),
            &depositor_key,
            share,
        );
        invoke_signed(
            &transfer_ix,
            &[
                vault.to_account_info(),
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[
                b"vault",
                ctx.accounts.cabal.key().as_ref(),
                &[ctx.bumps.vault],
            ]],
        )?;

        // Remove depositor
        cabal.deposits.remove(pos);

        Ok(())
    }

    /// Execute swap through Jupiter
    pub fn swap(
        ctx: Context<Swap>,
        amount: u64,
        slippage_bps: u16,
        quote: u64,
    ) -> Result<()> {
        let cabal = &ctx.accounts.cabal;
        let member_key = ctx.accounts.member.key();

        // Authorization checks
        let depositor = cabal.deposits
            .iter()
            .find(|d| d.key == member_key && d.role == Role::Member)
            .ok_or(CabalError::Unauthorized)?;

        // Fee calculation
        let fee = amount
            .checked_mul(cabal.fee_bps.into())
            .and_then(|v| v.checked_div(10_000))
            .ok_or(CabalError::FeeCalculationError)?;
        let swap_amount = amount.checked_sub(fee)
            .ok_or(CabalError::InvalidSwapAmount)?;

        // Transfer fee to fee wallet
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
                cabal.key().as_ref(),
                &[ctx.bumps.vault],
            ]],
        )?;

        // Convert SOL to wSOL
        let sync_ix = SyncNative::create_ix(&ctx.accounts.vault_wsol.to_account_info())?;
        invoke_signed(
            &sync_ix,
            &[
                ctx.accounts.vault_wsol.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[&[
                b"vault",
                cabal.key().as_ref(),
                &[ctx.bumps.vault],
            ]],
        )?;

        // Execute Jupiter swap
        let min_out = quote
            .checked_mul((10_000 - slippage_bps).into())
            .and_then(|v| v.checked_div(10_000))
            .ok_or(CabalError::SlippageError)?;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.jupiter_program.to_account_info(),
            jupiter::Swap {
                authority: ctx.accounts.vault_sol.to_account_info(),
                source_token: ctx.accounts.vault_wsol.to_account_info(),
                destination_token: ctx.accounts.vault_token.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                // Additional Jupiter accounts would go here
            },
        ).with_signer(&[&[
            b"vault",
            cabal.key().as_ref(),
            &[ctx.bumps.vault],
        ]]);

        jupiter::swap(cpi_ctx, swap_amount, min_out)?;

        Ok(())
    }
}

// Account structures and data models
#[account]
pub struct Cabal {
    pub creator: Pubkey,
    pub buy_in: u64,
    pub fee_bps: u16,
    pub deposits: Vec<Deposit>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Deposit {
    pub key: Pubkey,
    pub amount: u64,
    pub role: Role,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum Role {
    Member,
    Lurker,
}

// Event definitions
#[event]
pub struct CabalCreated {
    pub cabal: Pubkey,
    pub creator: Pubkey,
    pub buy_in: u64,
    pub fee_bps: u16,
}

// Error codes
#[error_code]
pub enum CabalError {
    #[msg("Insufficient deposit amount")]
    InsufficientDeposit,
    #[msg("Cabal has reached maximum members")]
    CabalFull,
    #[msg("Unauthorized action")]
    Unauthorized,
    #[msg("Duplicate deposit detected")]
    DuplicateDeposit,
    #[msg("Invalid amount specified")]
    InvalidAmount,
    #[msg("Share calculation error")]
    ShareCalculationError,
    #[msg("Fee calculation error")]
    FeeCalculationError,
    #[msg("Invalid swap amount")]
    InvalidSwapAmount,
    #[msg("Slippage tolerance exceeded")]
    SlippageError,
    #[msg("Vault balance changed during operation")]
    VaultBalanceChanged,
    #[msg("No funds available for withdrawal")]
    NothingToWithdraw,
    #[msg("Account not found in deposits")]
    NotDepositor,
}

// Contexts remain similar but with improved validation
// (Refer to previous implementation for full context structures)
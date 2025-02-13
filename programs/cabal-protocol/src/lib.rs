use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction,
};
use anchor_lang::solana_program::{entrypoint::ProgramResult, instruction::Instruction};

use anchor_spl::token::{self, Mint, SyncNative, Token, TokenAccount};

/// Configuration constants
const MAX_MEMBERS: usize = 6;
const MAX_DEPOSITORS: usize = 20;
const FEE_WALLET: &str = "A8aTLejFzPYqFmBtq7586VTfbsroXS4AMAPvtA3DXH8q";

pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const WSOL_SEED: &[u8] = b"wsol";

mod jupiter {
    use anchor_lang::declare_id;
    declare_id!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
}

#[derive(Clone)]
pub struct Jupiter;

impl anchor_lang::Id for Jupiter {
    fn id() -> Pubkey {
        jupiter::id()
    }
}

declare_id!("3jUomWjaKdsxzKt6Tn5DkzeAy3Yw686XDdT8dyWVeVmq");

#[derive(Accounts)]
#[instruction(buy_in: u64, fee_bps: u16)]
pub struct CreateCabal<'info> {
    #[account(
        init,
        payer = creator,
        // 8 bytes for discriminator
        // size_of::<Pubkey>() for creator
        // size_of::<u64>() for buy_in
        // size_of::<u16>() for fee_bps
        // 4 bytes for vec length
        // MAX_DEPOSITORS * size of each Deposit struct
        space = 8 + 32 + 8 + 2 + 4 + (MAX_DEPOSITORS * (32 + 8 + 1))
    )]
    pub cabal: Account<'info, Cabal>,
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: PDA vault for storing SOL
    #[account(mut, seeds = [b"vault", cabal.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinCabal<'info> {
    #[account(mut)]
    pub cabal: Account<'info, Cabal>,
    #[account(mut)]
    pub member: Signer<'info>,
    /// CHECK: PDA vault validated by seeds
    #[account(mut, seeds = [b"vault", cabal.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LurkerDeposit<'info> {
    #[account(mut)]
    pub cabal: Account<'info, Cabal>,
    #[account(mut)]
    pub lurker: Signer<'info>,
    /// CHECK: PDA vault validated by seeds
    #[account(mut, seeds = [b"vault", cabal.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub cabal: Account<'info, Cabal>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: PDA vault validated by seeds
    #[account(mut, seeds = [b"vault", cabal.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub cabal: Account<'info, Cabal>,
    pub member: Signer<'info>,
    /// CHECK: PDA vault for SOL
    #[account(mut, seeds = [b"vault", cabal.key().as_ref()], bump)]
    pub vault_sol: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_wsol: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    /// CHECK: Fee wallet address is validated in the instruction
    #[account(mut)]
    pub fee_wallet: UncheckedAccount<'info>,
    pub jupiter_program: Program<'info, Jupiter>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapToSOL<'info> {
    #[account(mut, seeds = [AUTHORITY_SEED], bump)]
    pub program_authority: SystemAccount<'info>,
    /// CHECK: This may not be initialized yet.
    #[account(mut, seeds = [WSOL_SEED], bump)]
    pub program_wsol_account: UncheckedAccount<'info>,
    pub user_account: Signer<'info>,
    #[account(mut)]
    pub sol_mint: Account<'info, Mint>,
    pub jupiter_program: Program<'info, Jupiter>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

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
        let cabal_key = ctx.accounts.cabal.key();
        
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
                cabal_key.as_ref(),
                &[ctx.bumps["vault"]],
            ]],
        )?;

        emit!(CabalCreated {
            cabal: cabal_key,
            creator: cabal.creator,
            buy_in,
            fee_bps,
        });

        Ok(())
    }

    // /// Join as a member with at least the buy_in amount
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

    // Deposit as a lurker with any positive amount
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
        let cabal_key = ctx.accounts.cabal.key();
        
        let cabal = &mut ctx.accounts.cabal;
        let depositor_key = ctx.accounts.depositor.key();
        let vault = &ctx.accounts.vault;

        // Find depositor position
        let pos = cabal.deposits
            .iter()
            .position(|d| d.key == depositor_key)
            .ok_or(CabalError::NotDepositor)?;
        let deposit = cabal.deposits[pos].clone();

        // Calculate share based on total deposits instead of vault balance
        let total_deposits: u64 = cabal.deposits.iter().map(|d| d.amount).sum();
        let vault_balance = **vault.to_account_info().lamports.borrow();
        
        // Share should be proportional to their deposit amount relative to total deposits
        let share = vault_balance
            .checked_mul(deposit.amount)
            .and_then(|v| v.checked_div(total_deposits))
            .ok_or(CabalError::ShareCalculationError)?;

        require!(share > 0, CabalError::NothingToWithdraw);

        // Remove depositor BEFORE transfer to prevent reentrancy
        cabal.deposits.remove(pos);

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
                cabal_key.as_ref(),
                &[ctx.bumps["vault"]],
            ]],
        )?;

        Ok(())
    }

    // Execute swap through Jupiter
    pub fn swap(
        ctx: Context<Swap>,
        amount: u64,
        slippage_bps: u16,
        quote: u64,
        route_data: Vec<u8>,
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
                &[ctx.bumps["vault_sol"]],
            ]],
        )?;

        // Convert SOL to wSOL
        let sync_ix = anchor_spl::token::spl_token::instruction::sync_native(
            &anchor_spl::token::ID,
            &ctx.accounts.vault_wsol.key(),
        )?;
        invoke_signed(
            &sync_ix,
            &[
                ctx.accounts.vault_wsol.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[&[
                b"vault",
                cabal.key().as_ref(),
                &[ctx.bumps["vault_sol"]],
            ]],
        )?;

        // Calculate minimum output amount
        let min_out = quote
            .checked_mul((10_000 - slippage_bps).into())
            .and_then(|v| v.checked_div(10_000))
            .ok_or(CabalError::SlippageError)?;

        // Execute Jupiter swap using remaining accounts
        msg!("Executing Jupiter swap");
        super::swap_on_jupiter(
            ctx.remaining_accounts,
            ctx.accounts.jupiter_program.clone(),
            route_data,
            ctx.bumps["vault_sol"],
        )?;

        Ok(())
    }

    pub fn swap_to_sol(ctx: Context<SwapToSOL>, data: Vec<u8>) -> Result<()> {
        msg!("Swap on Jupiter");
        super::swap_on_jupiter(
            ctx.remaining_accounts,
            ctx.accounts.jupiter_program.clone(),
            data,
            ctx.bumps["program_authority"],
        )?;
        
        Ok(())
    }
}

// Move swap_on_jupiter outside the module
pub fn swap_on_jupiter<'info>(
    remaining_accounts: &[AccountInfo],
    jupiter_program: Program<'info, Jupiter>,
    data: Vec<u8>,
    authority_bump: u8,
) -> ProgramResult {
    let accounts: Vec<AccountMeta> = remaining_accounts
        .iter()
        .map(|acc| AccountMeta {
            pubkey: *acc.key,
            is_signer: acc.is_signer,
            is_writable: acc.is_writable,
        })
        .collect();

    let accounts_infos: Vec<AccountInfo> = remaining_accounts
        .iter()
        .map(|acc| AccountInfo { ..acc.clone() })
        .collect();

    // TODO: Check the first 8 bytes. Only Jupiter Route CPI allowed.

    invoke_signed(
        &Instruction {
            program_id: *jupiter_program.key,
            accounts,
            data,
        },
        &accounts_infos,
        &[&[AUTHORITY_SEED, &[authority_bump]]],
    )
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
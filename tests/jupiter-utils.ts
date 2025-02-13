import fetch from "node-fetch";
import * as anchor from "@coral-xyz/anchor";

const JUPITER_API_DEVNET = "https://quote-api.jup.ag/v6";

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | any;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot: number;
  timeTaken: number;
  swapUsdValue: string;
  simplerRouteUsed: boolean;
}

interface JupiterRouteResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  computeUnitLimit: number;
  prioritizationType: {
    computeBudget: {
      microLamports: number;
      estimatedMicroLamports: number;
    };
  };
}

interface RouteData {
  data: Buffer;
  accounts: { pubkey: string; isWritable: boolean; isSigner: boolean; }[];
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number = 100
): Promise<JupiterQuoteResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippageBps.toString(),
    onlyDirectRoutes: 'true',
    useSharedAccounts: 'true',
    swapMode: 'ExactIn',
    maxAccounts: '8'
  });

  console.log("Requesting quote with params:", params.toString());
  const response = await fetch(
    `${JUPITER_API_DEVNET}/quote?${params.toString()}`
  );
  
  if (!response.ok) {
    const error = await response.text();
    console.error("Quote API error response:", error);
    throw new Error(`Jupiter API error: ${response.statusText} - ${error}`);
  }

  const data = await response.json() as JupiterQuoteResponse;
  console.log("Quote response:", JSON.stringify(data, null, 2));
  return data;
}

export async function getJupiterRouteData(
  quote: JupiterQuoteResponse,
  userPublicKey: string
): Promise<RouteData> {
  const body = {
    userPublicKey,
    quoteResponse: quote,
    computeUnitPriceMicroLamports: 1,
    useSharedAccounts: true,
    wrapUnwrapSOL: true,
    maxAccounts: 8,
    useVersionedTransaction: true
  };

  console.log("Requesting swap with body:", JSON.stringify(body, null, 2));
  
  const response = await fetch(
    `${JUPITER_API_DEVNET}/swap`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Swap API error response:", error);
    throw new Error(`Jupiter API error: ${response.statusText} - ${error}`);
  }

  const routeResponse = await response.json() as JupiterRouteResponse;
  console.log("Swap response:", JSON.stringify(routeResponse, null, 2));

  // Deserialize as versioned transaction
  const versionedTx = anchor.web3.VersionedTransaction.deserialize(
    Buffer.from(routeResponse.swapTransaction, 'base64')
  );

  // Extract instruction data from the transaction
  const instruction = versionedTx.message.compiledInstructions[0];
  const data = Buffer.from(instruction.data);

  // Extract accounts from the transaction's message
  const accounts = versionedTx.message.staticAccountKeys.map((key, index) => ({
    pubkey: key.toString(),
    isWritable: versionedTx.message.isAccountWritable(index),
    isSigner: versionedTx.message.isAccountSigner(index)
  }));
  
  return {
    data,
    accounts
  };
} 
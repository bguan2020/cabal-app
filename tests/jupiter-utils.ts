import fetch from "node-fetch";

const JUPITER_API_DEVNET = "https://quote-api.jup.ag/v6";

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  amount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | any;
  priceImpactPct: number;
  routePlan: any[];
  contextSlot: number;
  timeTaken: number;
  route: any;
}

interface JupiterRouteResponse {
  swapTransaction: string;
  setupTransaction: string | null;
  cleanupTransaction: string | null;
  routeData: {
    accounts: { pubkey: string; isWritable: boolean; isSigner: boolean; }[];
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
    asLegacyTransaction: 'true'
  });

  const response = await fetch(
    `${JUPITER_API_DEVNET}/quote?${params.toString()}`
  );
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jupiter API error: ${response.statusText} - ${error}`);
  }

  const data = await response.json() as JupiterQuoteResponse;
  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    amount: data.amount,
    outAmount: data.outAmount,
    otherAmountThreshold: data.otherAmountThreshold,
    swapMode: data.swapMode,
    slippageBps: data.slippageBps,
    platformFee: data.platformFee,
    priceImpactPct: data.priceImpactPct,
    routePlan: data.routePlan,
    contextSlot: data.contextSlot,
    timeTaken: data.timeTaken,
    route: data.route
  };
}

export async function getJupiterRouteData(
  quote: JupiterQuoteResponse,
  userPublicKey: string
): Promise<RouteData> {
  const response = await fetch(
    `${JUPITER_API_DEVNET}/swap`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userPublicKey,
        quoteResponse: {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.amount,
          outAmount: quote.outAmount,
          otherAmountThreshold: quote.otherAmountThreshold,
          swapMode: quote.swapMode,
          slippageBps: quote.slippageBps,
          platformFee: quote.platformFee,
          priceImpactPct: quote.priceImpactPct,
          routePlan: quote.routePlan,
          contextSlot: quote.contextSlot,
          timeTaken: quote.timeTaken,
          route: quote.route
        },
        wrapAndUnwrapSol: true,
        asLegacyTransaction: true
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jupiter API error: ${response.statusText} - ${error}`);
  }

  const routeResponse = await response.json() as JupiterRouteResponse;
  return {
    data: Buffer.from(routeResponse.swapTransaction, 'base64'),
    accounts: routeResponse.routeData.accounts
  };
} 
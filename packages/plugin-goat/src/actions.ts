/**
 * GOAT Plugin - Autonomous Trading Actions
 * 
 * This module implements autonomous trading functionality for the GOAT plugin.
 * It handles trade execution, position management, and risk evaluation.
 */

import {
    type WalletClient,
    type Plugin,
    addParametersToDescription,
    type Tool,
    getTools,
} from "@goat-sdk/core";
import {
    type Action,
    generateText,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    composeContext,
    generateObjectV2,
    elizaLogger,
} from "@ai16z/eliza";
import { PublicKey, Keypair, Connection, VersionedTransaction } from "@solana/web3.js";
import { AutoClient } from "@ai16z/client-auto";
import { loadTokenAddresses } from "./tokenUtils";

/**
 * Safety limits and trading parameters
 */
const SAFETY_LIMITS = {
    MINIMUM_TRADE: 0.01,        // Minimum trade size in SOL
    MAX_POSITION_SIZE: 0.1,     // Maximum 10% of token liquidity
    MAX_SLIPPAGE: 0.05,        // Maximum 5% slippage allowed
    MIN_LIQUIDITY: 5000,       // Minimum $5000 liquidity required
    MIN_VOLUME: 10000,         // Minimum $10000 24h volume required
    MIN_TRUST_SCORE: 0.4,      // Minimum trust score to trade
    MAX_PRICE_IMPACT: 0.03,    // Maximum 3% price impact allowed
    STOP_LOSS: 0.15,          // 15% stop loss trigger
    CHECK_INTERVAL: 5 * 60 * 1000  // Check every 5 minutes
};

/**
 * Position tracking interface
 * Represents an open trading position
 */
interface Position {
    token: string;              // Token symbol
    entryPrice: number;         // Entry price in USD
    amount: number;             // Position size
    timestamp: number;          // Entry timestamp
    sold?: boolean;             // Position closed flag
    exitPrice?: number;         // Exit price if sold
    exitTimestamp?: number;     // Exit timestamp if sold
    initialMetrics: {
        trustScore: number;     // Initial trust score
        volume24h: number;      // 24h volume at entry
        liquidity: { usd: number }; // Liquidity at entry
        riskLevel: "LOW" | "MEDIUM" | "HIGH";
    };
}

type GetOnChainActionsParams<TWalletClient extends WalletClient> = {
    wallet: TWalletClient;
    plugins: Plugin<TWalletClient>[];
    dexscreener: {
        watchlistUrl: string;
        chain: string;
        updateInterval: number;
    };
};

function createAction(tool: Tool): Action {
    return {
        name: tool.name,
        similes: [],
        description: tool.description,
        validate: async () => true,
        handler: async (runtime: IAgentRuntime, message: Memory, state: State | undefined, options?: Record<string, unknown>, callback?: HandlerCallback): Promise<boolean> => {
            try {
                let currentState = state ?? (await runtime.composeState(message));
                currentState = await runtime.updateRecentMessageState(currentState);
                const parameterContext = composeParameterContext(tool, currentState);
                const parameters = await generateParameters(runtime, parameterContext, tool);
                const parsedParameters = tool.parameters.safeParse(parameters);
                
                if (!parsedParameters.success) {
                    callback?.({ text: `Invalid parameters for action ${tool.name}: ${parsedParameters.error.message}`, content: { error: parsedParameters.error.message }});
                    return false;
                }

                const result = await tool.method(parsedParameters.data);
                const responseContext = composeResponseContext(tool, result, currentState);
                const response = await generateResponse(runtime, responseContext);
                callback?.({ text: response, content: result });
                return true;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                callback?.({ text: `Error executing action ${tool.name}: ${errorMessage}`, content: { error: errorMessage }});
                return false;
            }
        },
        examples: []
    };
}

function composeParameterContext(tool: Tool, state: State): string {
    return composeContext({
        state,
        template: `{{recentMessages}}\n\nGiven the recent messages, extract the following information for the action "${tool.name}":\n${addParametersToDescription("", tool.parameters)}`
    });
}

async function generateParameters(runtime: IAgentRuntime, context: string, tool: Tool): Promise<unknown> {
    const { object } = await generateObjectV2({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
        schema: tool.parameters,
    });
    return object;
}

function composeResponseContext(tool: Tool, result: unknown, state: State): string {
    return composeContext({
        state,
        template: `# Action Examples\n{{actionExamples}}\n\n# Knowledge\n{{knowledge}}\n\nThe action "${tool.name}" was executed successfully.\nResult: ${JSON.stringify(result)}\n\n{{recentMessages}}`
    });
}

async function generateResponse(runtime: IAgentRuntime, context: string): Promise<string> {
    return generateText({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
    });
}

// Update wallet validation
const validateWalletAddress = (address: string | undefined): boolean => {
    if (!address) return false;
    try {
        new PublicKey(address); // This will validate the base58 format
        return true;
    } catch {
        return false;
    }
};

// Add position tracking
const positions = new Map<string, Position>();

// Add sell action
const sellTokenAction: Action = {
    name: "SELL_TOKEN",
    description: "Sell a token position based on market conditions",
    similes: ["SELL", "EXIT_POSITION", "CLOSE_TRADE"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        try {
            const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
            return validateWalletAddress(walletAddress);
        } catch (error) {
            elizaLogger.error("Validation error:", error);
            return false;
        }
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state: State | undefined, options?: Record<string, unknown>, callback?: HandlerCallback): Promise<boolean> => {
        try {
            const tokenAddress = options?.tokenAddress as string;
            if (!tokenAddress) {
                throw new Error("Token address required for sell action");
            }

            const position = positions.get(tokenAddress);
            if (!position) {
                throw new Error("No position found for this token");
            }

            // Execute sell
            const sellResult = { success: true }; // Implement actual sell logic
            
            if (sellResult.success) {
                position.sold = true;
                callback?.({
                    text: `🔴 Position closed: ${position.token}\nAmount: $${position.amount.toFixed(2)}`,
                    content: {
                        action: "SELL_TOKEN",
                        position
                    }
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Sell error:", error);
            return false;
        }
    }
};


// Add helper function for selling
async function sellPosition(position: Position, currentPrice: number, runtime: IAgentRuntime): Promise<boolean> {
    try {
        // Execute sell using executeTrade
        const tradeResult = await executeTrade(runtime, {
            tokenAddress: "So11111111111111111111111111111111111111112", // SOL address
            amount: position.amount,
            slippage: 0.01
        });

        if (tradeResult.success) {
            position.sold = true;
            position.exitPrice = currentPrice;
            position.exitTimestamp = Date.now();
            
            const pnl = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
            elizaLogger.log(`Position closed and swapped to SOL: ${position.token}, PnL: ${pnl.toFixed(2)}%`);
        }

        return tradeResult.success;
    } catch (error) {
        elizaLogger.error(`Failed to sell position ${position.token}:`, error);
        return false;
    }
}

// Add trust evaluation function
async function evaluateTrust(runtime: IAgentRuntime, pair: any): Promise<number> {
    try {
        // Calculate trust score from metrics
        const metrics = {
            liquidity: pair.liquidity?.usd || 0,
            volume24h: pair.volume?.h24 || 0,
            marketCap: pair.marketCap || 0
        };

        // Calculate component scores
        const liquidityScore = Math.min(metrics.liquidity / SAFETY_LIMITS.MIN_LIQUIDITY, 1) * 0.4;
        const volumeScore = Math.min(metrics.volume24h / SAFETY_LIMITS.MIN_VOLUME, 1) * 0.4;
        const marketCapScore = Math.min(metrics.marketCap / 1000000, 1) * 0.2;

        // Calculate final score
        const trustScore = Math.min(liquidityScore + volumeScore + marketCapScore, 1);

        elizaLogger.log("Trust evaluation:", {
            token: pair.baseToken.symbol,
            metrics,
            scores: {
                liquidity: liquidityScore,
                volume: volumeScore,
                marketCap: marketCapScore,
                total: trustScore
            }
        });

        return trustScore;
    } catch (error) {
        elizaLogger.error(`Trust evaluation error for ${pair.baseToken.symbol}:`, error);
        return 0;
    }
}
/**
 * Autonomous trading action
 * Monitors market conditions and executes trades automatically
 */
const autonomousTradeAction: Action = {
    name: "AUTONOMOUS_TRADE",
    description: "Execute autonomous trades based on market conditions",
    similes: ["TRADE", "AUTO_TRADE", "TRADE_SOLANA", "TRADE_SOL", "AUTONOMOUS"],
    autoStart: true,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        try {
            if (message.content?.source === "auto") {
                return true;
            }
            const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
            return validateWalletAddress(walletAddress);
        } catch (error) {
            elizaLogger.error("Validation error:", error);
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        options?: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
            if (!validateWalletAddress(walletAddress)) {
                throw new Error("Invalid wallet configuration");
            }

            elizaLogger.log("Starting autonomous trade monitoring...");
            
            // Start periodic trading checks
            const startTrading = async () => {
                try {
                    elizaLogger.log("Starting trading cycle...");
                    
                    // Get token addresses
                    const tokenAddresses = loadTokenAddresses();
                    const tokensUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddresses.join(',')}`;
                    elizaLogger.log("Fetching DexScreener data from:", tokensUrl);
                    
                    const data = await fetchDexScreenerData(tokensUrl);
                    if (!data.pairs || !data.pairs.length) {
                        elizaLogger.warn("No pairs found in DexScreener response");
                        return;
                    }

                    // Filter to get only the best pair for each token
                    const uniquePairs = filterUniquePairs(data.pairs);
                    elizaLogger.log(`Processing ${uniquePairs.length} unique pairs...`);
                    
                    // Process pairs
                    for (const pair of uniquePairs) {
                        try {
                            if (!validateWalletAddress(pair.baseToken?.address)) {
                                elizaLogger.warn(`Invalid token address: ${pair.baseToken?.address}`);
                                continue;
                            }

                            // Calculate trust score
                            const trustScore = await evaluateTrust(runtime, pair);

                            // Skip if trust score too low
                            if (trustScore < SAFETY_LIMITS.MIN_TRUST_SCORE) {
                                elizaLogger.warn(`Low trust score for ${pair.baseToken.symbol}: ${trustScore}`);
                                continue;
                            }

                            // Skip if liquidity too low
                            if ((pair.liquidity?.usd || 0) < SAFETY_LIMITS.MIN_LIQUIDITY) {
                                continue;
                            }

                            // Skip if volume too low
                            if ((pair.volume?.h24 || 0) < SAFETY_LIMITS.MIN_VOLUME) {
                                continue;
                            }

                            // Get wallet keypair first
                            const walletKeypair = getWalletKeypair(runtime);

                            // Get wallet balance
                            const balance = await getWalletBalance(runtime);
                            elizaLogger.log("Checking wallet balance:", {
                                solBalance: balance,
                                walletAddress: walletKeypair.publicKey.toBase58(),
                                rpcUrl: runtime.getSetting("RPC_URL") || "https://api.mainnet-beta.solana.com"
                            });

                            if (balance <= 0) {
                                elizaLogger.warn("Insufficient wallet balance:", {
                                    balance,
                                    minRequired: SAFETY_LIMITS.MIN_LIQUIDITY * SAFETY_LIMITS.MAX_POSITION_SIZE,
                                    walletAddress: walletKeypair.publicKey.toBase58()
                                });
                                continue;
                            }

                            const positionSize = Math.min(
                                pair.liquidity.usd * SAFETY_LIMITS.MAX_POSITION_SIZE, // Only 10% of liquidity
                                balance * 0.1  // Only 10% of wallet balance
                            );

                            if (positionSize > 0) {
                                const tradeResult = await executeTrade(runtime, {
                                    tokenAddress: pair.baseToken.address,
                                    amount: positionSize,
                                    slippage: SAFETY_LIMITS.MAX_SLIPPAGE
                                });

                                if (tradeResult.success) {
                                    // Track new position
                                    positions.set(pair.baseToken.address, {
                                        token: pair.baseToken.symbol,
                                        entryPrice: Number(pair.priceUsd),
                                        amount: positionSize,
                                        timestamp: Date.now(),
                                        initialMetrics: {
                                            trustScore,
                                            volume24h: pair.volume?.h24 || 0,
                                            liquidity: { usd: pair.liquidity?.usd || 0 },
                                            riskLevel: trustScore > 0.8 ? "LOW" : trustScore > 0.5 ? "MEDIUM" : "HIGH"
                                        }
                                    });

                                    if (callback) {
                                        callback({
                                            text: `🤖 Trade executed: ${pair.baseToken.symbol}\nAmount: $${positionSize.toFixed(2)}\nPrice: $${Number(pair.priceUsd).toFixed(6)}`,
                                            content: {
                                                ...tradeResult,
                                                symbol: pair.baseToken.symbol,
                                                amount: positionSize,
                                                price: pair.priceUsd,
                                                position: positions.get(pair.baseToken.address)
                                            }
                                        });
                                    }
                                }
                            }

                            // Monitor existing positions
                            const position = positions.get(pair.baseToken.address);
                            if (position && !position.sold) {
                                const currentPrice = Number(pair.priceUsd);
                                const priceDrop = (position.entryPrice - currentPrice) / position.entryPrice;
                                
                                if (priceDrop > SAFETY_LIMITS.STOP_LOSS) {
                                    elizaLogger.warn(`Stop loss triggered for ${position.token}`);
                                    const sellResult = await sellPosition(position, currentPrice, runtime);
                                    
                                    if (sellResult) {
                                        elizaLogger.log(`Successfully sold ${position.token} at stop loss`);
                                        if (callback) {
                                            callback({
                                                text: `🔴 Stop loss triggered: Sold ${position.token}\nEntry: $${position.entryPrice.toFixed(6)}\nExit: $${currentPrice.toFixed(6)}\nLoss: ${(priceDrop * 100).toFixed(2)}%`,
                                                content: {
                                                    action: "STOP_LOSS",
                                                    token: position.token,
                                                    entryPrice: position.entryPrice,
                                                    exitPrice: currentPrice,
                                                    loss: priceDrop
                                                }
                                            });
                                        }
                                    } else {
                                        elizaLogger.error(`Failed to execute stop loss for ${position.token}`);
                                    }
                                }
                            }

                        } catch (pairError) {
                            elizaLogger.error(`Error processing pair: ${pairError.message}`);
                            continue;
                        }
                    }
                } catch (error) {
                    elizaLogger.error("Trading cycle error:", error instanceof Error ? error.message : error);
                }
            };

            // Start periodic checks with stored ID
            const intervalId = setInterval(startTrading, SAFETY_LIMITS.CHECK_INTERVAL);
            
            // Store just the numeric ID
            await runtime.cacheManager.set("trading_interval_id", intervalId[Symbol.toPrimitive]());
            
            // Execute initial check
            await startTrading();

            callback?.({
                text: "🤖 Autonomous trading started. Monitoring market conditions...",
                content: { 
                    action: "AUTONOMOUS_TRADE",
                    status: "started",
                    interval: SAFETY_LIMITS.CHECK_INTERVAL
                }
            });

            return true;

        } catch (error) {
            elizaLogger.error("Autonomous trade error:", error);
            callback?.({
                text: 'Trading error: ${error.message}',
                content: { error: error.message }
            });
            return false;
        }
    },
    cleanup: async (runtime: IAgentRuntime) => {
        const intervalId = await runtime.cacheManager.get<number>("trading_interval_id");
        if (intervalId) {
            clearInterval(intervalId);
        }
    }
};

/**
 * Executes a trade with the given parameters
 * @param runtime Agent runtime environment
 * @param params Trade parameters (token, amount, slippage)
 * @returns Trade result with success/failure and details
 */
async function executeTrade(
    runtime: IAgentRuntime,
    params: {
        tokenAddress: string;   // Token to trade
        amount: number;         // Amount in SOL
        slippage: number;       // Slippage tolerance
    }
): Promise<any> {
    try {
        elizaLogger.log("Executing trade with params:", params);

        // Validate minimum amount
        if (params.amount < SAFETY_LIMITS.MINIMUM_TRADE) {
            elizaLogger.warn("Trade amount too small:", {
                amount: params.amount,
                minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE
            });
            return {
                success: false,
                error: "Trade amount too small",
                details: {
                    amount: params.amount,
                    minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE
                }
            };
        }

        const walletKeypair = getWalletKeypair(runtime);
        const connection = new Connection(
            runtime.getSetting("RPC_URL") || "https://api.mainnet-beta.solana.com"
        );

        // Setup swap parameters
        const inputTokenCA = "So11111111111111111111111111111111111111112"; // SOL
        const outputTokenCA = params.tokenAddress;
        const adjustedAmount = Math.floor(params.amount * 1e9); // Convert to lamports and ensure integer

        elizaLogger.log("Fetching quote with params:", {
            inputMint: inputTokenCA,
            outputMint: outputTokenCA,
            amount: adjustedAmount
        });

        // Get quote
        const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${adjustedAmount}&slippageBps=${Math.floor(params.slippage * 10000)}`
        );

        if (!quoteResponse.ok) {
            const error = await quoteResponse.text();
            elizaLogger.warn("Quote request failed:", {
                status: quoteResponse.status,
                error
            });
            return {
                success: false,
                error: "Failed to get quote",
                details: { status: quoteResponse.status, error }
            };
        }

        const quoteData = await quoteResponse.json();
        if (!quoteData || quoteData.error) {
            elizaLogger.warn("Invalid quote data:", quoteData);
            return {
                success: false,
                error: "Invalid quote data",
                details: quoteData
            };
        }

        elizaLogger.log("Quote received:", quoteData);

        // Get swap transaction
        const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: walletKeypair.publicKey.toString(),
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: 2000000,
                dynamicComputeUnitLimit: true
            })
        });

        const swapData = await swapResponse.json();
        if (!swapData?.swapTransaction) {
            throw new Error("No swap transaction returned");
        }

        elizaLogger.log("Swap transaction received");

        // Deserialize and execute transaction
        const transactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(transactionBuf);
        tx.sign([walletKeypair]);

        const signature = await connection.sendTransaction(tx);
        const confirmation = await connection.confirmTransaction(signature);

        return { success: true, signature, confirmation };
    } catch (error) {
        elizaLogger.error("Trade execution failed:", {
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined,
            params
        });
        return {
            success: false,
            error: String(error),
            recoverable: true // Indicate if error is temporary
        };
    }
}

/**
 * Helper function to fetch and validate DexScreener data
 * @param url DexScreener API endpoint URL
 * @returns Parsed DexScreener response data
 * @throws Error if fetch fails or response is invalid
 */
async function fetchDexScreenerData(url: string) {
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0' // Some APIs require a user agent
            }
        });
        
        // Check if response is OK
        if (!response.ok) {
            throw new Error(`DexScreener API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (!data || !data.pairs) {
            throw new Error("Invalid response format from DexScreener");
        }

        elizaLogger.log("DexScreener data fetched successfully:", {
            pairsCount: data.pairs.length,
            schemaVersion: data.schemaVersion
        });

        return data;
    } catch (error) {
        elizaLogger.error("DexScreener API error:", error);
        elizaLogger.error("Failed URL:", url);
        throw new Error(`Failed to fetch DexScreener data: ${error.message}`);
    }
}

/**
 * Gets wallet keypair from runtime settings
 * @param runtime Agent runtime environment
 * @returns Solana keypair for transactions
 * @throws Error if private key is missing or invalid
 */
function getWalletKeypair(runtime: IAgentRuntime): Keypair {
    const privateKeyString = runtime.getSetting("WALLET_PRIVATE_KEY");
    if (!privateKeyString) {
        throw new Error("No wallet private key configured");
    }

    try {
        const privateKeyBytes = decodeBase58(privateKeyString);
        return Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
        elizaLogger.error("Failed to create wallet keypair:", error);
        throw error;
    }
}

/**
 * Gets current SOL balance for wallet
 * @param runtime Agent runtime environment
 * @returns Balance in SOL
 */
async function getWalletBalance(runtime: IAgentRuntime): Promise<number> {
    try {
        const walletKeypair = getWalletKeypair(runtime);
        const walletPubKey = walletKeypair.publicKey;

        // Fetch balance from RPC
        const connection = new Connection(
            runtime.getSetting("RPC_URL") || "https://api.mainnet-beta.solana.com"
        );
        
        const balance = await connection.getBalance(walletPubKey);
        const solBalance = balance / 1e9; // Convert lamports to SOL

        elizaLogger.log("Fetched wallet balance:", {
            address: walletPubKey.toBase58(),
            lamports: balance,
            sol: solBalance
        });

        return solBalance;
    } catch (error) {
        elizaLogger.error("Failed to get wallet balance:", error);
        return 0;
    }
}

/**
 * Filters and deduplicates token pairs by liquidity
 * @param pairs Array of token pairs from DexScreener
 * @returns Array of unique pairs with highest liquidity
 */
function filterUniquePairs(pairs: any[]): any[] {
    // Create a map to store best pair for each token
    const bestPairs = new Map();
    
    for (const pair of pairs) {
        const tokenAddress = pair.baseToken?.address;
        if (!tokenAddress) continue;

        // Get existing best pair for this token
        const existingPair = bestPairs.get(tokenAddress);
        
        // If no existing pair or this pair has better liquidity, update
        if (!existingPair || (pair.liquidity?.usd || 0) > (existingPair.liquidity?.usd || 0)) {
            bestPairs.set(tokenAddress, pair);
        }
    }

    return Array.from(bestPairs.values());
}

/**
 * Gets on-chain actions for the GOAT plugin
 * @param params Plugin parameters including wallet and DEX settings
 * @returns Array of available trading actions
 */
export async function getOnChainActions<TWalletClient extends WalletClient>({
    wallet,
    plugins,
    dexscreener
}: GetOnChainActionsParams<TWalletClient>): Promise<Action[]> {
    const tools = await getTools<TWalletClient>({
        wallet,
        plugins,
        wordForTool: "action",
    });

    // Create base actions
    const baseActions = tools.map(tool => createAction(tool));
    
    // Add autonomous trade action
    const allActions = [...baseActions, autonomousTradeAction, sellTokenAction];

    // Log registered actions
    allActions.forEach(action => {
        elizaLogger.log(`Registering action: ${action.name}`);
    });

    // Auto-start autonomous trading
    if (AutoClient.isAutoClient) {
        elizaLogger.log("Auto-starting autonomous trading...");
        try {
            await autonomousTradeAction.handler(
                AutoClient.runtime,
                { content: { source: "auto" } } as Memory,
                undefined,
                undefined,
                (response) => elizaLogger.log("Auto-trade response:", response)
            );
        } catch (error) {
            elizaLogger.error("Failed to auto-start trading:", error);
        }
    }

    return allActions;
}

// Add helper to decode base58 private key
function decodeBase58(str: string): Uint8Array {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_MAP = new Map(ALPHABET.split('').map((c, i) => [c, BigInt(i)]));
    
    let result = BigInt(0);
    for (const char of str) {
        const value = ALPHABET_MAP.get(char);
        if (value === undefined) throw new Error('Invalid base58 character');
        result = result * BigInt(58) + value;
    }
    
    const bytes = [];
    while (result > 0n) {
        bytes.unshift(Number(result & 0xffn));
        result = result >> 8n;
    }
    
    // Add leading zeros
    for (let i = 0; i < str.length && str[i] === '1'; i++) {
        bytes.unshift(0);
    }
    
    return new Uint8Array(bytes);
}

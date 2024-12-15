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
import { PublicKey, Keypair } from "@solana/web3.js";
import { AutoClient } from "@ai16z/client-auto";
import { loadTokenAddresses } from "./tokenUtils";
import { trustEvaluator, type TrustEvaluatorParams } from "@ai16z/plugin-solana";
import bs58 from "bs58";

const SAFETY_LIMITS = {
    // Position sizing
    MAX_POSITION_SIZE: 0.1,    // 10% of liquidity
    MAX_SLIPPAGE: 0.05,        // 5% slippage
    
    // Minimum requirements
    MIN_LIQUIDITY: 5000,       // $5000 minimum liquidity
    MIN_VOLUME: 10000,         // $10000 minimum 24h volume
    MIN_TRUST_SCORE: 0.4,      // Minimum trust score to trade
    
    // Risk management
    MAX_PRICE_IMPACT: 0.03,    // 3% price impact
    STOP_LOSS: 0.15,          // 15% stop loss
    
    // Position monitoring
    DETERIORATION_THRESHOLD: 0.2,  // 20% deterioration triggers sell
    MIN_VOLUME_RATIO: 0.5,         // Volume must stay above 50% of entry
    MAX_RISK_INCREASE: 0.3,        // 30% max risk increase before selling
    
    // Trading intervals
    CHECK_INTERVAL: 5 * 60 * 1000  // 5 minutes
};

interface Position {
    token: string;
    entryPrice: number;
    amount: number;
    initialAmount?: number;  // For tracking position growth
    timestamp: number;
    sold?: boolean;
    exitPrice?: number;  // Add this
    exitTimestamp?: number;  // Add this
    averagePrice?: number;  // Add this
    initialMetrics: {
        trustScore: number;
        volume24h: number;
        liquidity: { usd: number };
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
    tweetTrade: (params: any) => Promise<void>;
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
        // Execute sell using sell action
        const sellResult = await sellTokenAction.handler(
            runtime,
            { content: { source: "auto" } } as Memory,
            undefined,
            { tokenAddress: position.token },
            (response) => elizaLogger.log("Sell response:", response)
        );

        if (sellResult) {
            position.sold = true;
            position.exitPrice = currentPrice;
            position.exitTimestamp = Date.now();
            
            const pnl = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
            elizaLogger.log(`Position closed: ${position.token}, PnL: ${pnl.toFixed(2)}%`);
        }

        return sellResult;
    } catch (error) {
        elizaLogger.error(`Failed to sell position ${position.token}:`, error);
        return false;
    }
}

// Update autonomous trade action to use trust evaluator
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

                            // Get wallet balance safely
                            const balance = Number(runtime.getSetting("WALLET_BALANCE") || "0");
                            if (balance <= 0) {
                                elizaLogger.warn("Insufficient wallet balance");
                                continue;
                            }

                            const positionSize = Math.min(
                                pair.liquidity.usd * SAFETY_LIMITS.MAX_POSITION_SIZE,
                                balance * 0.9
                            );

                            if (positionSize > 0) {
                                const tradeResult = await executeTrade({
                                    tokenAddress: pair.baseToken.address,
                                    amount: positionSize,
                                    slippage: 0.01
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
                text: `⚠️ Trading error: ${error.message}`,
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

// Helper function to execute trades
async function executeTrade(params: {
    tokenAddress: string;
    amount: number;
    slippage: number;
}) {
    // Implement actual trade execution logic here
    return { success: true };
}

// Add this helper function
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

// Add helper to get wallet keypair
function getWalletKeypair(runtime: IAgentRuntime): Keypair {
    const privateKeyString = runtime.getSetting("WALLET_PRIVATE_KEY");
    if (!privateKeyString) {
        throw new Error("No wallet private key configured");
    }

    elizaLogger.log("Attempting to decode private key:", {
        length: privateKeyString.length,
        sample: `${privateKeyString.slice(0, 4)}...${privateKeyString.slice(-4)}`
    });

    try {
        // Decode base58 private key
        const privateKeyBytes = bs58.decode(privateKeyString);
        elizaLogger.log("Decoded private key bytes:", {
            length: privateKeyBytes.length,
            isUint8Array: privateKeyBytes instanceof Uint8Array
        });

        const keypair = Keypair.fromSecretKey(privateKeyBytes);
        elizaLogger.log("Created keypair:", {
            publicKey: keypair.publicKey.toBase58(),
            publicKeyLength: keypair.publicKey.toBytes().length
        });

        return keypair;
    } catch (error) {
        elizaLogger.error("Failed to create wallet keypair:", {
            error: error instanceof Error ? error.message : error,
            privateKeyLength: privateKeyString.length,
            isBase58: /^[1-9A-HJ-NP-Za-km-z]+$/.test(privateKeyString)
        });
        throw error;
    }
}

// Update evaluateTrust to include roomId
async function evaluateTrust(runtime: IAgentRuntime, pair: any): Promise<number> {
    try {
        // Get wallet keypair first
        const walletKeypair = getWalletKeypair(runtime);
        const walletPubKey = walletKeypair.publicKey.toBase58();

        // Validate the public key is base58 encoded
        if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(walletPubKey)) {
            elizaLogger.error("Invalid wallet public key format:", walletPubKey);
            return 0;
        }

        // Create a consistent roomId for autonomous trading
        const roomId = `autonomous_trading_${runtime.agentId || 'default'}`;
        const agentId = runtime.agentId || 'autonomous_agent';

        elizaLogger.log("Creating runtime with:", { 
            roomId, 
            agentId,
            walletPubKey: `${walletPubKey.slice(0, 4)}...${walletPubKey.slice(-4)}`  // Log safely
        });

        // Create a new runtime with complete configuration
        const runtimeWithWallet = {
            ...runtime,
            agentId,
            roomId,
            getSetting: (key: string) => {
                if (key === 'SOLANA_PUBLIC_KEY') {
                    return walletPubKey;
                }
                return runtime.settings?.[key];
            },
            settings: {
                ...runtime.settings,
                SOLANA_PUBLIC_KEY: walletPubKey,
                ROOM_ID: roomId,
                AGENT_ID: agentId
            },
            // Provide a complete state
            composeState: async () => {
                elizaLogger.log("Composing state with:", { roomId, agentId });
                return {
                    roomId,
                    agentId,
                    wallet: {
                        address: walletPubKey,
                        network: "solana",
                        balance: runtime.settings?.WALLET_BALANCE || "0",
                        publicKey: walletPubKey
                    },
                    token: {
                        address: pair.baseToken.address,
                        symbol: pair.baseToken.symbol,
                        name: pair.baseToken.name || pair.baseToken.symbol,
                        decimals: pair.baseToken.decimals || 9,
                        metrics: {
                            volume24h: pair.volume?.h24 || 0,
                            liquidity: pair.liquidity?.usd || 0,
                            priceChange24h: pair.priceChange24h || 0,
                            holders: pair.holders || 0,
                            marketCap: pair.marketCap || 0,
                            fdv: pair.fdv || 0,
                            price: Number(pair.priceUsd) || 0
                        }
                    },
                    recentMessages: [], // Add empty array if needed
                    participants: [{
                        id: agentId,
                        name: "Autonomous Trading Agent",
                        role: "agent"
                    }]
                };
            },
            // Keep these to prevent unnecessary text generation
            generateText: async () => "",
            generateObject: async () => ({ object: {} })
        };

        // Create memory with complete configuration
        const memory: Memory = {
            content: {
                text: "evaluate token trust",
                action: "EVALUATE_TRUST",
                content: {
                    token: pair.baseToken.address,
                    chain: "solana",
                    metrics: {
                        volume24h: pair.volume?.h24 || 0,
                        liquidity: pair.liquidity?.usd || 0,
                        priceChange24h: pair.priceChange24h || 0,
                        holders: pair.holders || 0,
                        marketCap: pair.marketCap || 0,
                        fdv: pair.fdv || 0,
                        price: Number(pair.priceUsd) || 0
                    }
                }
            },
            userId: agentId,
            roomId,
            agentId,
            createdAt: Date.now()
        };

        elizaLogger.log("Evaluating trust with:", { 
            symbol: pair.baseToken.symbol,
            roomId,
            agentId 
        });

        // Use trust evaluator with complete runtime and memory
        const result = await trustEvaluator.handler(
            runtimeWithWallet,
            memory,
            await runtimeWithWallet.composeState(), // Pass initial state
            memory.content.content
        );

        if (typeof result === 'number' && !isNaN(result)) {
            elizaLogger.log(`Trust score for ${pair.baseToken.symbol}: ${result}`);
            return result;
        }

        elizaLogger.warn(`Invalid trust score for ${pair.baseToken.symbol}:`, result);
        return 0;
    } catch (error) {
        elizaLogger.error(`Trust evaluation error for ${pair.baseToken.symbol}:`, error);
        return 0;
    }
}

// Add helper to filter and deduplicate pairs
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

export async function getOnChainActions<TWalletClient extends WalletClient>({
    wallet,
    plugins,
    dexscreener,
    tweetTrade
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

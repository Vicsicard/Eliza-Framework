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
import { PublicKey } from "@solana/web3.js";
import { AutoClient } from "@ai16z/client-auto";
import type { Timeout } from "node:timers";

const SAFETY_LIMITS = {
    MAX_POSITION_SIZE: 0.1,    // 10% of liquidity
    MAX_SLIPPAGE: 0.05,        // 5% slippage
    MIN_LIQUIDITY: 1000,       // $1000 minimum liquidity
    MAX_PRICE_IMPACT: 0.03,    // 3% price impact
    STOP_LOSS: 0.15,          // 15% stop loss
    MIN_TRUST_SCORE: 0.4,     // Minimum trust score to trade
    // Position monitoring
    DETERIORATION_THRESHOLD: 0.2,  // 20% deterioration triggers sell
    MIN_VOLUME_RATIO: 0.5,         // Volume must stay above 50% of entry
    MAX_RISK_INCREASE: 0.3         // 30% max risk increase before selling
};

interface Position {
    token: string;
    entryPrice: number;
    amount: number;
    timestamp: number;
    sold?: boolean;
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

// Add trading interval settings
const TRADE_SETTINGS = {
    CHECK_INTERVAL: 5 * 60 * 1000, // 5 minutes
    MIN_VOLUME: 10000, // Minimum 24h volume in USD
    MIN_LIQUIDITY: 5000, // Minimum liquidity in USD
    MAX_POSITION_SIZE: 0.1, // 10% of available balance
    STOP_LOSS: 0.15, // 15% stop loss
};

// Update autonomous trade action
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
                    const watchlistUrl = runtime.getSetting("DEXSCREENER_WATCHLIST_URL");
                    if (!watchlistUrl) {
                        throw new Error("DexScreener watchlist URL not configured");
                    }

                    elizaLogger.log("Fetching DexScreener data from:", watchlistUrl);
                    const data = await fetchDexScreenerData(watchlistUrl);
                    
                    // Process pairs
                    for (const pair of data.pairs) {
                        try {
                            if (!validateWalletAddress(pair.baseToken?.address)) {
                                elizaLogger.warn(`Invalid token address: ${pair.baseToken?.address}`);
                                continue;
                            }

                            // Skip if liquidity too low
                            if ((pair.liquidity?.usd || 0) < TRADE_SETTINGS.MIN_LIQUIDITY) {
                                continue;
                            }

                            // Skip if volume too low
                            if ((pair.volume?.h24 || 0) < TRADE_SETTINGS.MIN_VOLUME) {
                                continue;
                            }

                            // Get wallet balance safely
                            const balance = Number(runtime.getSetting("WALLET_BALANCE") || "0");
                            if (balance <= 0) {
                                elizaLogger.warn("Insufficient wallet balance");
                                continue;
                            }

                            const positionSize = Math.min(
                                pair.liquidity.usd * TRADE_SETTINGS.MAX_POSITION_SIZE,
                                balance * 0.9
                            );

                            if (positionSize > 0) {
                                const tradeResult = await executeTrade({
                                    tokenAddress: pair.baseToken.address,
                                    amount: positionSize,
                                    slippage: 0.01
                                });

                                if (callback && tradeResult.success) {
                                    callback({
                                        text: `🤖 Trade executed: ${pair.baseToken.symbol}\nAmount: $${positionSize.toFixed(2)}\nPrice: $${Number(pair.priceUsd).toFixed(6)}`,
                                        content: {
                                            ...tradeResult,
                                            symbol: pair.baseToken.symbol,
                                            amount: positionSize,
                                            price: pair.priceUsd
                                        }
                                    });
                                }
                            }
                        } catch (pairError) {
                            elizaLogger.error(`Error processing pair: ${pairError.message}`);
                            continue;
                        }
                    }
                } catch (tradingError) {
                    elizaLogger.error("Trading cycle error:", tradingError);
                }
            };

            // Start periodic checks with stored ID
            const intervalId = setInterval(startTrading, TRADE_SETTINGS.CHECK_INTERVAL);
            
            // Store just the numeric ID
            await runtime.cacheManager.set("trading_interval_id", intervalId[Symbol.toPrimitive]());
            
            // Execute initial check
            await startTrading();

            callback?.({
                text: "🤖 Autonomous trading started. Monitoring market conditions...",
                content: { 
                    action: "AUTONOMOUS_TRADE",
                    status: "started",
                    interval: TRADE_SETTINGS.CHECK_INTERVAL
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
        const response = await fetch(url);
        
        // Check if response is OK
        if (!response.ok) {
            throw new Error(`DexScreener API error: ${response.status} ${response.statusText}`);
        }

        // Check content type
        const contentType = response.headers.get("content-type");
        if (!contentType?.includes("application/json")) {
            throw new Error(`Invalid content type: ${contentType}`);
        }

        const data = await response.json();
        if (!data || !data.pairs) {
            throw new Error("Invalid response format from DexScreener");
        }

        return data;
    } catch (error) {
        elizaLogger.error("DexScreener API error:", error);
        elizaLogger.error("Failed URL:", url);
        throw new Error(`Failed to fetch DexScreener data: ${error.message}`);
    }
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
    const allActions = [...baseActions, autonomousTradeAction];

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

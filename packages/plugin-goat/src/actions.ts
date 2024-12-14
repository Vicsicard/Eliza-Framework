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

    const autonomousTradeAction: Action = {
        name: "AUTONOMOUS_TRADE",
        description: "Execute autonomous trades based on DexScreener watchlist with position management",
        similes: [],
        validate: async () => true,
        handler: async (runtime: IAgentRuntime, message: Memory, state: State | undefined, options?: Record<string, unknown>, callback?: HandlerCallback): Promise<boolean> => {
            try {
                const response = await fetch(dexscreener.watchlistUrl);
                const data = await response.json();
                
                let currentState = state ?? (await runtime.composeState(message));
                currentState = await runtime.updateRecentMessageState(currentState);

                // Get current positions from memory
                const positions: Position[] = JSON.parse(
                    (await runtime.messageManager.getLastMemory("POSITIONS"))?.content?.text || "[]"
                );

                // Monitor and manage existing positions
                for (const position of positions) {
                    if (position.sold) continue;
                    const tokenData = data.pairs.find(p => p.baseToken.address === position.token);
                    if (!tokenData) continue;

                    // Check for stop loss
                    const currentPrice = tokenData.priceUsd;
                    const stopLossPrice = position.entryPrice * (1 - SAFETY_LIMITS.STOP_LOSS);
                    const priceDecline = (position.entryPrice - currentPrice) / position.entryPrice;

                    // Calculate metric deterioration
                    const volumeDrop = (position.initialMetrics.volume24h - tokenData.volume24h) / position.initialMetrics.volume24h;
                    const liquidityDrop = (position.initialMetrics.liquidity.usd - tokenData.liquidity.usd) / position.initialMetrics.liquidity.usd;
                    const trustScoreDrop = position.initialMetrics.trustScore - (tokenData.confidence || 0);

                    // Define sell conditions
                    const shouldSell = 
                        currentPrice <= stopLossPrice || // Stop loss hit
                        priceDecline >= SAFETY_LIMITS.DETERIORATION_THRESHOLD || // Price deterioration
                        volumeDrop >= SAFETY_LIMITS.DETERIORATION_THRESHOLD || // Volume deterioration
                        liquidityDrop >= SAFETY_LIMITS.DETERIORATION_THRESHOLD || // Liquidity deterioration
                        trustScoreDrop >= SAFETY_LIMITS.MAX_RISK_INCREASE; // Risk increase

                    if (shouldSell) {
                        try {
                            // Execute sell order
                            const result = await wallet.executeTrade({
                                tokenIn: position.token,
                                tokenOut: "SOL",
                                amountIn: position.amount,
                                slippage: SAFETY_LIMITS.MAX_SLIPPAGE
                            });

                            // Mark position as sold
                            position.sold = true;

                            // Tweet about the sell
                            await tweetTrade({
                                token: position.token,
                                amount: position.amount,
                                trustScore: tokenData.confidence || 0,
                                riskLevel: "HIGH",
                                marketData: {
                                    priceChange24h: tokenData.priceChange24h,
                                    volume24h: tokenData.volume24h,
                                    liquidity: tokenData.liquidity
                                },
                                action: "SELL",
                                reason: currentPrice <= stopLossPrice ? "Stop Loss" : 
                                        priceDecline >= SAFETY_LIMITS.DETERIORATION_THRESHOLD ? "Price Drop" :
                                        volumeDrop >= SAFETY_LIMITS.DETERIORATION_THRESHOLD ? "Volume Drop" :
                                        liquidityDrop >= SAFETY_LIMITS.DETERIORATION_THRESHOLD ? "Liquidity Drop" :
                                        "Risk Increase"
                            });

                            elizaLogger.log(`Sold position in ${position.token} due to ${currentPrice <= stopLossPrice ? "stop loss" : "risk management"}`);
                        } catch (error) {
                            elizaLogger.error(`Failed to sell position in ${position.token}:`, error);
                        }
                    }
                }

                // Store updated positions
                await runtime.addToMemory({
                    role: "system",
                    content: JSON.stringify({
                        type: "POSITIONS",
                        positions: positions
                    })
                });

                // Execute new trades
                for (const pair of data.pairs) {
                    // Skip if already in position
                    if (positions.some(p => p.token === pair.baseToken.address && !p.sold)) continue;

                    // Skip if liquidity too low
                    if (pair.liquidity.usd < SAFETY_LIMITS.MIN_LIQUIDITY) {
                        elizaLogger.log(`Skipping ${pair.baseToken.symbol} - insufficient liquidity: ${pair.liquidity.usd}`);
                        continue;
                    }

                    // Skip if trust score too low
                    if ((pair.confidence || 0) < SAFETY_LIMITS.MIN_TRUST_SCORE) {
                        elizaLogger.log(`Skipping ${pair.baseToken.symbol} - low trust score: ${pair.confidence}`);
                        continue;
                    }

                    const positionSize = Math.min(
                        pair.liquidity.usd * SAFETY_LIMITS.MAX_POSITION_SIZE,
                        await wallet.getMaxBuyAmount(pair.baseToken.address)
                    );

                    if (positionSize > 0) {
                        try {
                            const result = await wallet.executeTrade({
                                tokenIn: "SOL",
                                tokenOut: pair.baseToken.address,
                                amountIn: positionSize,
                                slippage: SAFETY_LIMITS.MAX_SLIPPAGE
                            });

                            // Store new position
                            positions.push({
                                token: pair.baseToken.address,
                                entryPrice: pair.priceUsd,
                                amount: positionSize,
                                timestamp: Date.now(),
                                initialMetrics: {
                                    trustScore: pair.confidence || 0,
                                    volume24h: pair.volume24h,
                                    liquidity: pair.liquidity,
                                    riskLevel: (pair.confidence || 0) > 0.7 ? "LOW" : 
                                              (pair.confidence || 0) > 0.4 ? "MEDIUM" : "HIGH"
                                }
                            });

                            await tweetTrade({
                                token: pair.baseToken.address,
                                amount: positionSize,
                                trustScore: pair.confidence || 0,
                                riskLevel: (pair.confidence || 0) > 0.7 ? "LOW" : 
                                          (pair.confidence || 0) > 0.4 ? "MEDIUM" : "HIGH",
                                marketData: {
                                    priceChange24h: pair.priceChange24h,
                                    volume24h: pair.volume24h,
                                    liquidity: pair.liquidity
                                },
                                action: "BUY"
                            });

                            callback?.({ text: `Executed trade for ${pair.baseToken.symbol}`, content: result });
                        } catch (error) {
                            elizaLogger.error(`Trade failed for ${pair.baseToken.symbol}:`, error);
                            continue;
                        }
                    }
                }

                return true;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                callback?.({ text: `Error in autonomous trading: ${errorMessage}`, content: { error: errorMessage } });
                return false;
            }
        },
        examples: []
    };

    return [
        ...tools.map((action) => ({
            ...action,
            name: action.name.toUpperCase(),
        })).map((tool) => createAction(tool)),
        autonomousTradeAction
    ];
}
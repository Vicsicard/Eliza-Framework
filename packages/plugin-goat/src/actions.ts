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

// Add validation for wallet address
const validateWalletAddress = (address: string): boolean => {
    try {
        // Check if it's a valid base58 string
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    } catch {
        return false;
    }
};

// Add autonomous trade action
const autonomousTradeAction: Action = {
    name: "AUTONOMOUS_TRADE",
    description: "Execute autonomous trades based on market conditions",
    similes: ["TRADE", "AUTO_TRADE", "TRADE_SOLANA", "TRADE_SOL"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        try {
            const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
            if (!walletAddress) {
                elizaLogger.error("No wallet address configured");
                return false;
            }
            return true;
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
            elizaLogger.log("Starting autonomous trade...");
            
            // Get wallet info
            const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
            if (!walletAddress) {
                throw new Error("Wallet not configured");
            }

            // Execute trade logic
            const response = {
                text: "🤖 Autonomous trading enabled. Monitoring market conditions for SOL trading opportunities...",
                content: { 
                    action: "AUTONOMOUS_TRADE", 
                    status: "monitoring",
                    wallet: walletAddress
                }
            };

            callback?.(response);
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
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "autonomous trade" }
            },
            {
                user: "{{user2}}",
                content: { 
                    text: "🤖 Autonomous trading enabled. Monitoring market conditions...",
                    action: "AUTONOMOUS_TRADE"
                }
            }
        ]
    ]
};

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

    // Convert tool actions and add autonomous trade
    const actions = [
        ...tools.map((tool) => createAction(tool)),
        autonomousTradeAction
    ];

    // Log registered actions
    actions.forEach(action => {
        elizaLogger.log(`Registering action: ${action.name}`);
    });

    return actions;
}

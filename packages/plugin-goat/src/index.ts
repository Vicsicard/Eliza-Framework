import type { Plugin, IAgentRuntime, Memory } from "@ai16z/eliza";
import { getOnChainActions } from "./actions";
import { coingecko } from "@goat-sdk/plugin-coingecko";
import { elizaLogger } from "@ai16z/eliza";
import { z } from "zod";
import { TwitterClientInterface } from "@ai16z/client-twitter";
import {
    solanaPlugin,
    TokenProvider,
    WalletProvider,
    trustScoreProvider,
    trustEvaluator
} from "@ai16z/plugin-solana";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Chain, WalletClient, Signature, Balance } from "@goat-sdk/core";
import { getTokenBalance } from "@ai16z/plugin-solana/src/providers/tokenUtils";

// Validation schema for Twitter-related settings
const TwitterConfigSchema = z.object({
    enabled: z.boolean(),
    username: z.string().min(1),
    dryRun: z.boolean().optional().default(false)
});

// Update Balance interface to include formatted
interface ExtendedBalance extends Balance {
    value: bigint;
    decimals: number;
    formatted: string;
    symbol: string;
    name: string;
}

// Extended WalletProvider interface to ensure proper typing
interface ExtendedWalletProvider extends WalletClient {
    connection: Connection;
    getChain(): Chain;
    getAddress(): string;
    signMessage(message: string): Promise<Signature>;
    getFormattedPortfolio: (runtime: IAgentRuntime) => Promise<string>;
    balanceOf: (tokenAddress: string) => Promise<ExtendedBalance>;
    getMaxBuyAmount: (tokenAddress: string) => Promise<number>;
    executeTrade: (params: {
        tokenIn: string;
        tokenOut: string;
        amountIn: number;
        slippage: number;
    }) => Promise<any>;
}

interface MarketData {
    priceChange24h: number;
    volume24h: number;
    liquidity: {
        usd: number;
    };
}

interface TradeAlert {
    token: string;
    amount: number;
    trustScore: number;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
    marketData: MarketData;
    timestamp: number;
}

class TwitterService {
    private client: any;
    private config: z.infer<typeof TwitterConfigSchema>;

    constructor(client: any, config: z.infer<typeof TwitterConfigSchema>) {
        this.client = client;
        this.config = config;
    }

    async postTradeAlert(alert: TradeAlert): Promise<boolean> {
        try {
            const tweetContent = this.formatTradeAlert(alert);

            if (this.config.dryRun) {
                elizaLogger.log("Dry run mode - would have posted tweet:", tweetContent);
                return true;
            }

            await this.client.post.client.twitterClient.sendTweet(tweetContent);
            elizaLogger.log("Successfully posted trade alert to Twitter");
            return true;
        } catch (error) {
            elizaLogger.error("Failed to post trade alert to Twitter:", error);
            return false;
        }
    }

    private formatTradeAlert(alert: TradeAlert): string {
        const priceChangePrefix = alert.marketData.priceChange24h >= 0 ? "+" : "";
        const volumeUsd = (alert.marketData.volume24h / 1000000).toFixed(1);
        const liquidityUsd = (alert.marketData.liquidity.usd / 1000000).toFixed(1);
        const trustScoreEmoji = alert.trustScore >= 0.8 ? "🟢" :
                               alert.trustScore >= 0.5 ? "🟡" : "🔴";

        return [
            `${alert.token} | $${alert.amount.toFixed(2)}`,
            `Trust: ${trustScoreEmoji} ${(alert.trustScore * 100).toFixed(0)}%`,
            `Risk: ${alert.riskLevel}`,
            `📊 ${priceChangePrefix}${alert.marketData.priceChange24h.toFixed(1)}%`,
            `Vol: $${volumeUsd}M Liq: $${liquidityUsd}M`,
            `#Solana ${alert.token}`
        ].join("\n");
    }
}

interface SolanaPluginExtended extends Plugin {
    providers: any[];
    evaluators: any[];
    actions: any[];
}

const REQUIRED_SETTINGS = {
    WALLET_PUBLIC_KEY: "Solana wallet public key",
    DEXSCREENER_WATCHLIST_ID: "DexScreener watchlist ID",
    COINGECKO_API_KEY: "CoinGecko API key"
} as const;

// Add near the top imports
interface ExtendedPlugin extends Plugin {
    name: string;
    description: string;
    evaluators: any[];
    providers: any[];
    actions: any[];
    services: any[];
    autoStart?: boolean;
}

// Add this helper function
const validateSolanaAddress = (address: string | undefined): boolean => {
    if (!address) return false;
    try {
        // First check basic format
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
            return false;
        }
        // Then verify it's a valid Solana public key
        const pubKey = new PublicKey(address);
        return Boolean(pubKey.toBase58());
    } catch {
        return false;
    }
};

async function createGoatPlugin(
    getSetting: (key: string) => string | undefined,
    runtime?: IAgentRuntime
): Promise<Plugin> {
    elizaLogger.log("Starting GOAT plugin initialization");

    // Validate required settings
    const missingSettings: string[] = [];
    for (const [key, description] of Object.entries(REQUIRED_SETTINGS)) {
        if (!getSetting(key)) {
            missingSettings.push(`${key} (${description})`);
        }
    }

    if (missingSettings.length > 0) {
        const errorMsg = `Missing required settings: ${missingSettings.join(", ")}`;
        elizaLogger.error(errorMsg);
        throw new Error(errorMsg);
    }

    let connection: Connection;
    let walletProvider: ExtendedWalletProvider;

    try {
        elizaLogger.log("Initializing Solana connection...");
        const walletAddress = getSetting("WALLET_PUBLIC_KEY");
        
        if (!walletAddress) {
            throw new Error("No wallet address configured");
        }

        // Create connection first
        connection = new Connection(runtime?.getSetting("RPC_URL") || "https://api.mainnet-beta.solana.com");
        
        // Then validate and create public key
        if (!validateSolanaAddress(walletAddress)) {
            throw new Error(`Invalid wallet address format: ${walletAddress}`);
        }

        const walletPublicKey = new PublicKey(walletAddress);
        elizaLogger.log("Wallet validation successful:", walletPublicKey.toBase58());

        walletProvider = {
            connection,
            getChain: () => ({ type: "solana" }),
            getAddress: () => walletPublicKey.toBase58(),
            signMessage: async (message: string): Promise<Signature> => {
                throw new Error("Message signing not implemented for Solana wallet");
            },
            balanceOf: async (tokenAddress: string): Promise<ExtendedBalance> => {
                try {
                    const tokenPublicKey = new PublicKey(tokenAddress);
                    const amount = await getTokenBalance(
                        connection,
                        walletPublicKey,
                        tokenPublicKey
                    );
                    return {
                        value: BigInt(amount.toString()),
                        decimals: 9,
                        formatted: (amount / 1e9).toString(),
                        symbol: "SOL",
                        name: "Solana"
                    };
                } catch (error) {
                    return {
                        value: BigInt(0),
                        decimals: 9,
                        formatted: "0",
                        symbol: "SOL",
                        name: "Solana"
                    };
                }
            },
            getMaxBuyAmount: async (tokenAddress: string) => {
                try {
                    const balance = await connection.getBalance(walletPublicKey);
                    return (balance * 0.9) / 1e9;
                } catch (error) {
                    return 0;
                }
            },
            executeTrade: async (params) => {
                try {
                    return { success: true };
                } catch (error) {
                    throw error;
                }
            },
            getFormattedPortfolio: async () => ""
        };
        
        elizaLogger.log("Solana connection and wallet provider initialized successfully");
    
    } catch (error) {
        elizaLogger.error("Failed to initialize Solana components:", error);
        throw new Error(`Solana initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Initialize Twitter service if enabled
    let twitterService: TwitterService | undefined;
    try {
        elizaLogger.log("Configuring Twitter service for trade notifications...");
        const twitterConfig = TwitterConfigSchema.parse({
            enabled: getSetting("TWITTER_ENABLED") === "true",
            username: getSetting("TWITTER_USERNAME"),
            dryRun: getSetting("TWITTER_DRY_RUN") === "true"
        });

        if (twitterConfig.enabled && runtime) {
            elizaLogger.log("Starting Twitter client initialization...");
            const twitterClient = await TwitterClientInterface.start(runtime);
            twitterService = new TwitterService(twitterClient, twitterConfig);
            elizaLogger.log("Twitter service initialized successfully", {
                username: twitterConfig.username,
                dryRun: twitterConfig.dryRun
            });
        }
    } catch (error) {
        elizaLogger.error("Failed to initialize Twitter service:", error);
    }

    // Set up trade notification function
    const tweetTrade = async (alert: TradeAlert) => {
        if (twitterService) {
            await twitterService.postTradeAlert({
                ...alert,
                timestamp: Date.now()
            });
        }
    };

    elizaLogger.log("Initializing Solana plugin components...");
    const solana = solanaPlugin as SolanaPluginExtended;

    try {
        const customActions = await getOnChainActions({
            wallet: walletProvider,
            plugins: [
                coingecko({ apiKey: getSetting("COINGECKO_API_KEY") })
            ],
            dexscreener: {
                watchlistUrl: `https://api.dexscreener.com/latest/dex/watchlists/${getSetting("DEXSCREENER_WATCHLIST_ID")}`,
                chain: "solana",
                updateInterval: parseInt(getSetting("UPDATE_INTERVAL") || "300")
            },
            tweetTrade
        });

        // Then update the plugin creation
        const plugin: ExtendedPlugin = {
            name: "[GOAT] Onchain Actions with Solana Integration",
            description: "Autonomous trading integration",
            evaluators: [trustEvaluator, ...(solana.evaluators || [])],
            providers: [walletProvider, trustScoreProvider, ...(solana.providers || [])],
            actions: [...customActions, ...(solana.actions || [])],
            services: [],
            autoStart: true
        };

        // Auto-start autonomous trading
        if (runtime) {
            elizaLogger.log("Auto-starting autonomous trading...");
            const autonomousAction = plugin.actions.find(a => a.name === "AUTONOMOUS_TRADE");
            if (autonomousAction) {
                await autonomousAction.handler(
                    runtime,
                    { content: { source: "auto" } } as Memory,
                    undefined,
                    undefined,
                    (response) => elizaLogger.log("Auto-trade response:", response)
                );
            }
        }

        elizaLogger.log("GOAT plugin initialization completed successfully");
        return plugin;
    } catch (error) {
        elizaLogger.error("Failed to initialize plugin components:", error);
        throw new Error(`Plugin initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export default createGoatPlugin;

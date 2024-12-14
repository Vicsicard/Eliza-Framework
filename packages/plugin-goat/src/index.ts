import type { Plugin, IAgentRuntime } from "@ai16z/eliza";
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
import type { WalletClient } from "@goat-sdk/core";

// Validation schema for Twitter-related settings
const TwitterConfigSchema = z.object({
    enabled: z.boolean(),
    username: z.string().min(1),
    dryRun: z.boolean().optional().default(false)
});

// Extended WalletProvider interface to ensure proper typing
interface ExtendedWalletProvider extends WalletClient {
    connection: Connection;
    getFormattedPortfolio: (runtime: IAgentRuntime) => Promise<string>;
    balanceOf: (tokenAddress: string) => Promise<number>;
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
        const volumeUsd = (alert.marketData.volume24h / 1000000).toFixed(2);
        const liquidityUsd = (alert.marketData.liquidity.usd / 1000000).toFixed(2);
        const trustScoreEmoji = alert.trustScore >= 0.8 ? "🟢" :
                               alert.trustScore >= 0.5 ? "🟡" : "🔴";

        return [
            `🤖 Trade Alert | ${new Date(alert.timestamp).toLocaleTimeString()}`,
            "",
            `${alert.token} | $${alert.amount.toFixed(2)}`,
            `Trust: ${trustScoreEmoji} ${(alert.trustScore * 100).toFixed(1)}%`,
            `Risk: ${alert.riskLevel}`,
            "",
            `📊 24h Change: ${priceChangePrefix}${alert.marketData.priceChange24h.toFixed(2)}%`,
            `📈 Volume: $${volumeUsd}M`,
            `💧 Liquidity: $${liquidityUsd}M`,
            "",
            `#SolanaDefi #Trading ${alert.token.replace(/[^a-zA-Z0-9]/g, '')}`
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

    // Log initial configuration
    elizaLogger.log("GOAT Plugin Configuration:", {
        rpcUrl: runtime?.getSetting("RPC_URL") || "https://api.mainnet-beta.solana.com",
        walletPublicKey: getSetting("WALLET_PUBLIC_KEY")?.slice(0, 8) + "...", // Truncate for security,
        environment: runtime?.getSetting("NODE_ENV") || "development",
        isEnabled: true,
        hasValidSettings: true,
        pluginVersion: "0.1.5-alpha.5",
        dexscreenerId: getSetting("DEXSCREENER_WATCHLIST_ID"),
        hasCoingeckoKey: !!getSetting("COINGECKO_API_KEY"),
        updateInterval: getSetting("UPDATE_INTERVAL") || "300",
        twitterEnabled: getSetting("TWITTER_ENABLED") === "true"
    });

    // Initialize Solana components
    let connection: Connection;
    let walletProvider: ExtendedWalletProvider;

    try {
        elizaLogger.log("Initializing Solana connection...");
        connection = new Connection(runtime?.getSetting("RPC_URL") || "https://api.mainnet-beta.solana.com");
        const walletPublicKey = new PublicKey(getSetting("WALLET_PUBLIC_KEY") || "");
        
        // Create WalletProvider instance with proper typing
        const provider = new WalletProvider(connection, walletPublicKey);
        
        // Extend the provider with WalletClient interface
        walletProvider = {
            ...provider,
            getChain: () => "solana",
            getAddress: () => walletPublicKey.toBase58(),
            signMessage: async (message: string) => {
                throw new Error("Message signing not implemented for Solana wallet");
            }
        } as ExtendedWalletProvider;

        elizaLogger.log("Solana connection and wallet provider initialized successfully");

    } catch (error) {
        elizaLogger.error("Failed to initialize Solana components:", error);
        throw new Error(`Solana initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    elizaLogger.log("Plugin initialized with Solana configuration", {
        hasWalletProvider: !!walletProvider,
        hasConnection: !!connection,
        network: runtime?.getSetting("RPC_URL") ? "custom" : "mainnet",
    });

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
        } else {
            elizaLogger.log("Twitter service disabled or runtime not available");
        }
    } catch (error) {
        elizaLogger.error("Failed to initialize Twitter service:", error);
    }

    // Set up trade notification function
    const tweetTrade = async (alert: TradeAlert) => {
        if (twitterService) {
            elizaLogger.log("Posting trade alert:", {
                token: alert.token,
                amount: alert.amount,
                riskLevel: alert.riskLevel,
                trustScore: alert.trustScore
            });
            await twitterService.postTradeAlert({
                ...alert,
                timestamp: Date.now()
            });
        } else {
            elizaLogger.log("Twitter service not available - skipping trade alert");
        }
    };

    elizaLogger.log("Initializing Solana plugin components...");
    const solana = solanaPlugin as SolanaPluginExtended;
    elizaLogger.log("Solana plugin loaded successfully", {
        hasEvaluators: (solana.evaluators || []).length > 0,
        hasProviders: (solana.providers || []).length > 0,
        hasActions: (solana.actions || []).length > 0
    });

    // Get on-chain actions with Twitter integration
    elizaLogger.log("Initializing on-chain actions...");
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
        elizaLogger.log(`Successfully initialized ${customActions.length} custom actions`);

        // Create combined plugin
        elizaLogger.log("Creating final plugin configuration...");
        const plugin: Plugin = {
            name: "[GOAT] Onchain Actions with Solana Integration",
            description: "Autonomous trading integration",
            evaluators: [trustEvaluator, ...(solana.evaluators || [])],
            providers: [walletProvider, trustScoreProvider, ...(solana.providers || [])],
            actions: [...customActions, ...(solana.actions || [])],
            services: []
        };

        elizaLogger.log("Plugin configuration complete", {
            totalEvaluators: plugin.evaluators.length,
            totalProviders: plugin.providers.length,
            totalActions: plugin.actions.length,
            totalServices: plugin.services.length
        });

        elizaLogger.log("GOAT plugin initialization completed successfully");
        return plugin;
    } catch (error) {
        elizaLogger.error("Failed to initialize plugin components:", error);
        throw new Error(`Plugin initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export default createGoatPlugin;
import { elizaLogger } from "@ai16z/eliza";
import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
} from "@ai16z/eliza";

const fetchTwitterWallet: Action = {
    name: "FETCH_TWITTER_USER_WALLET",
    similes: [
        "GET_USER_WALLET",
        "CHECK_WALLET_ADDRESS",
        "FIND_WALLET_ADDRESS",
        "LOOKUP_TWITTER_WALLET",
    ],
    description: "Fetch Twitter user's crypto wallet address from VLY Money API.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        // Validate if secret token is configured
        elizaLogger.log("process.env.VLY_MONEY_API_KEY", process.env.VLY_MONEY_API_KEY);
        return !!process.env.VLY_MONEY_API_KEY;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Composing state for message:", JSON.stringify(message));
        state = (await runtime.composeState(message)) as State;
        const userId = runtime.agentId;

        try {
            const secretToken = process.env.VLY_MONEY_API_KEY;
            const url = 'https://service.vly.money/api/third_party/user_mapping';

            const params = new URLSearchParams({
                chain: 'eth',
                name: 'CMarshal247',
                scope: 'twitter'
            });

            elizaLogger.log("Fetching wallet address from VLY Money API");
            const response = await fetch(`${url}?${params}`, {
                method: 'GET',
                headers: {
                    'secret-token': secretToken
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            elizaLogger.log("Successfully fetched wallet address from VLY Money");

            if(!callback) {
                elizaLogger.log("No Callback.");
            } else {
                callback(
                    {
                        text: "Successfully fetched Twitter user's wallet address",
                        attachments: [
                            {
                                id: crypto.randomUUID(),
                                title: "Twitter User's Crypto Wallet",
                                source: "vlyMoney",
                                description: "Crypto wallet address for Twitter user",
                                "url": "https://vly.money/",
                                text: data,
                            },
                        ],
                    },
                    []
                );
            }
        } catch (error) {
            elizaLogger.error("Failed to fetch from VLY Money:", error);
            callback({
                text: "Failed to fetch wallet address: " + error.message,
                error: true,
            });
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Get crypto wallet address for Twitter user CMarshal247" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's the wallet address from VLY Money",
                    action: "FETCH_TWITTER_USER_WALLET",
                },
            },
        ],
    ],
} as Action;

export const vlyMoneyPlugin: Plugin = {
    name: "vlyMoney",
    description: "Interact with VLY Money API to fetch crypto wallet addresses for Twitter users",
    actions: [fetchTwitterWallet],
    evaluators: [],
    providers: [],
};
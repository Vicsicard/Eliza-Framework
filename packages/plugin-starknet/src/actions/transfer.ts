// TODO: Implement this for Starknet.
// It should just transfer tokens from the agent's wallet to the recipient.

import {
    settings,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
    composeContext,
    generateObject,
} from "@ai16z/eliza";
import {
    getStarknetAccount,
    isTransferContent,
    validateSettings,
} from "../utils";
import { ERC20Token } from "../utils/ERC20Token";

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

these are known addresses, if you get asked about them, use these:
- BTC/btc: 0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac
- ETH/eth: 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7
- STRK/strk: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d

Example response:
\`\`\`json
{
    "tokenAddress": "0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    "recipient": "0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
    "amount": "0.001"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Token contract address
- Recipient wallet address
- Amount to transfer

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "SEND_TOKEN",
    similes: [
        "TRANSFER_TOKEN_ON_STARKNET",
        "TRANSFER_TOKENS_ON_STARKNET",
        "SEND_TOKENS_ON_STARKNET",
        "SEND_ETH_ON_STARKNET",
        "PAY_ON_STARKNET",
    ],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        return validateSettings(runtime);
    },
    description:
        "This allows the agent to transfer tokens on starknet from one wallet to another. Use this to transfer.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        console.log("Starting TRANSFER_TOKEN handler...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose transfer context
        const transferContext = composeContext({
            state,
            template: transferTemplate,
        });

        // Generate transfer content
        const content = await generateObject({
            runtime,
            context: transferContext,
            modelClass: ModelClass.MEDIUM,
        });

        console.log("Transfer content:", content);

        // Validate transfer content
        if (!isTransferContent(content)) {
            console.error("Invalid content for TRANSFER_TOKEN action.");
            if (callback) {
                callback({
                    text: "Not enough information to transfer tokens. Please respond with token address, recipient, and amount.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {
            const account = getStarknetAccount(runtime);
            const erc20Token = new ERC20Token(content.tokenAddress, account);
            const decimals = await erc20Token.decimals();
            // Convert decimal amount to integer before converting to BigInt
            const amountInteger = Math.floor(
                Number(content.amount) * Math.pow(10, Number(decimals))
            );
            const amountWei = BigInt(amountInteger.toString());
            const transferCall = erc20Token.transferCall(
                content.recipient,
                amountWei
            );

            console.log(
                "Transferring",
                amountWei,
                "of",
                content.tokenAddress,
                "to",
                content.recipient
            );

            const tx = await account.execute(transferCall);

            console.log(
                "Transfer completed successfully! tx: " + tx.transaction_hash
            );
            if (callback) {
                callback({
                    text:
                        "Transfer completed successfully! tx: " +
                        tx.transaction_hash,
                    content: {},
                });
            }

            return true;
        } catch (error) {
            console.error("Error during token transfer:", error);
            if (callback) {
                callback({
                    text: `Error transferring tokens: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 69 STRK to 0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Transfer to 0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF 0.01 ETH",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
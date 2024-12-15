import {
    composeContext,
    generateObjectArray,
    generateTrueOrFalse,
    MemoryManager,
    booleanFooter,
    ActionExample,
    Content,
    IAgentRuntime,
    Memory,
    ModelClass,
    Evaluator,
} from "@ai16z/eliza";
import { TrustScoreManager } from "../providers/trustScoreProvider.ts";
import { TokenProvider } from "../providers/token.ts";
import { WalletProvider } from "../providers/wallet.ts";
import { TrustScoreDatabase } from "@ai16z/plugin-trustdb";
import { Connection, PublicKey } from "@solana/web3.js";

const shouldProcessTemplate =
    `# Task: Decide if the recent messages should be processed for token recommendations.

    Look for messages that:
    - Mention specific token tickers or contract addresses
    - Contain words related to buying, selling, or trading tokens
    - Express opinions or convictions about tokens

    Based on the following conversation, should the messages be processed for recommendations? YES or NO

    {{recentMessages}}

    Should the messages be processed for recommendations? ` + booleanFooter;

export const formatRecommendations = (recommendations: Memory[]) => {
    const messageStrings = recommendations
        .reverse()
        .map((rec: Memory) => `${(rec.content as Content)?.content}`);
    const finalMessageStrings = messageStrings.join("\n");
    return finalMessageStrings;
};

const recommendationTemplate = `TASK: Extract recommendations to buy or sell memecoins from the conversation as an array of objects in JSON format.

    Memecoins usually have a ticker and a contract address. Additionally, recommenders may make recommendations with some amount of conviction. The amount of conviction in their recommendation can be none, low, medium, or high. Recommenders can make recommendations to buy, not buy, sell and not sell.

# START OF EXAMPLES
These are an examples of the expected output of this task:
{{evaluationExamples}}
# END OF EXAMPLES

# INSTRUCTIONS

Extract any new recommendations from the conversation that are not already present in the list of known recommendations below:
{{recentRecommendations}}

- Include the recommender's username
- Try not to include already-known recommendations. If you think a recommendation is already known, but you're not sure, respond with alreadyKnown: true.
- Set the conviction to 'none', 'low', 'medium' or 'high'
- Set the recommendation type to 'buy', 'dont_buy', 'sell', or 'dont_sell'
- Include the contract address and/or ticker if available

Recent Messages:
{{recentMessages}}

Response should be a JSON object array inside a JSON markdown block. Correct response format:
\`\`\`json
[
  {
    "recommender": string,
    "ticker": string | null,
    "contractAddress": string | null,
    "type": enum<buy|dont_buy|sell|dont_sell>,
    "conviction": enum<none|low|medium|high>,
    "alreadyKnown": boolean
  },
  ...
]
\`\`\``;

async function handler(runtime: IAgentRuntime, message: Memory) {
    try {
        console.log("[1] Starting trust evaluation");
        const state = await runtime.composeState(message);
        console.log("[2] State composed:", { agentId: state.agentId, roomId: state.roomId });

        const { agentId, roomId } = state;

        // Check if we should process the messages
        const shouldProcessContext = composeContext({
            state,
            template: shouldProcessTemplate,
        });
        console.log("[3] Should process context created");

        const shouldProcess = await generateTrueOrFalse({
            context: shouldProcessContext,
            modelClass: ModelClass.SMALL,
            runtime,
        });
        console.log("[4] Should process result:", shouldProcess);

        if (!shouldProcess) {
            console.log("[5] Skipping process - shouldProcess is false");
            return [];
        }

        console.log("[6] Getting recent recommendations");
        const recommendationsManager = new MemoryManager({
            runtime,
            tableName: "recommendations",
        });

        const recentRecommendations = await recommendationsManager.getMemories({
            roomId,
            count: 20,
        });
        console.log("[7] Recent recommendations retrieved:", recentRecommendations.length);

        const context = composeContext({
            state: {
                ...state,
                recentRecommendations: formatRecommendations(recentRecommendations),
            },
            template: recommendationTemplate,
        });
        console.log("[8] Context composed for recommendations");

        const recommendations = await generateObjectArray({
            runtime,
            context,
            modelClass: ModelClass.LARGE,
        });
        console.log("[9] Generated recommendations:", recommendations);

        if (!recommendations) {
            console.log("[10] No recommendations generated");
            return [];
        }

        const filteredRecommendations = recommendations.filter((rec) => {
            return (
                !rec.alreadyKnown &&
                (rec.ticker || rec.contractAddress) &&
                rec.recommender &&
                rec.conviction &&
                rec.recommender.trim() !== ""
            );
        });
        console.log("[11] Filtered recommendations:", filteredRecommendations.length);

        for (const rec of filteredRecommendations) {
            try {
                console.log("[12] Processing recommendation:", rec);
                
                const walletProvider = new WalletProvider(
                    new Connection(
                        runtime.getSetting("RPC_URL") ||
                            "https://api.mainnet-beta.solana.com"
                    ),
                    new PublicKey(
                        runtime.getSetting("SOLANA_PUBLIC_KEY") ??
                            runtime.getSetting("WALLET_PUBLIC_KEY")
                    )
                );
                console.log("[13] Wallet provider created");

                const tokenProvider = new TokenProvider(
                    rec.contractAddress,
                    walletProvider,
                    runtime.cacheManager
                );
                console.log("[14] Token provider created");

                if (!rec.contractAddress) {
                    console.log("[15] No contract address, attempting to find it");
                    const tokenAddress = await tokenProvider.getTokenFromWallet(
                        runtime,
                        rec.ticker
                    );
                    console.log("[16] Token address from wallet:", tokenAddress);
                    
                    rec.contractAddress = tokenAddress;
                    if (!tokenAddress) {
                        const result = await tokenProvider.searchDexScreenerData(
                            rec.ticker
                        );
                        console.log("[17] DexScreener search result:", result);
                        
                        const tokenAddress = result?.baseToken?.address;
                        rec.contractAddress = tokenAddress;
                        if (!tokenAddress) {
                            console.warn("[18] Could not find contract address for token");
                            continue;
                        }
                    }
                }

                const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);
                const trustScoreManager = new TrustScoreManager(
                    runtime,
                    tokenProvider,
                    trustScoreDb
                );
                console.log("[19] Trust score manager created");

                const participants = await runtime.databaseAdapter.getParticipantsForRoom(
                    message.roomId
                );
                console.log("[20] Room participants retrieved:", participants.length);

                const user = participants.find(async (actor) => {
                    const user = await runtime.databaseAdapter.getAccountById(actor);
                    return (
                        user.name.toLowerCase().trim() ===
                        rec.recommender.toLowerCase().trim()
                    );
                });
                console.log("[21] User found:", !!user);

                if (!user) {
                    console.warn("[22] Could not find user:", rec.recommender);
                    continue;
                }

                const account = await runtime.databaseAdapter.getAccountById(user);
                const userId = account.id;
                console.log("[23] Account retrieved:", { userId });

                const recMemory = {
                    userId,
                    agentId,
                    content: { text: JSON.stringify(rec) },
                    roomId,
                    createdAt: Date.now(),
                };

                await recommendationsManager.createMemory(recMemory, true);
                console.log("[24] Recommendation memory created");

                const buyAmounts = await tokenProvider.calculateBuyAmounts();
                console.log("[25] Buy amounts calculated:", buyAmounts);

                let buyAmount = buyAmounts[rec.conviction.toLowerCase().trim()];
                if (!buyAmount) {
                    buyAmount = 10;
                    console.log("[26] Using default buy amount:", buyAmount);
                }

                const shouldTrade = await tokenProvider.shouldTradeToken();
                console.log("[27] Should trade result:", shouldTrade);

                if (!shouldTrade) {
                    console.warn("[28] Token trading check failed");
                    continue;
                }

                switch (rec.type) {
                    case "buy":
                        console.log("[29] Processing buy recommendation");
                        await trustScoreManager.createTradePerformance(
                            runtime,
                            rec.contractAddress,
                            userId,
                            {
                                buy_amount: rec.buyAmount,
                                is_simulation: true,
                            }
                        );
                        console.log("[30] Trade performance created");
                        break;
                    default:
                        console.warn("[31] Unimplemented recommendation type:", rec.type);
                }
            } catch (recError) {
                console.error("[ERROR] Processing recommendation failed:", recError);
            }
        }

        return filteredRecommendations;
    } catch (error) {
        console.error("[FATAL] Trust evaluation failed:", error);
        throw error;
    }
}

export const trustEvaluator: Evaluator = {
    name: "EXTRACT_RECOMMENDATIONS",
    similes: [
        "GET_RECOMMENDATIONS",
        "EXTRACT_TOKEN_RECS",
        "EXTRACT_MEMECOIN_RECS",
    ],
    alwaysRun: true,
    validate: async (
        runtime: IAgentRuntime,
        message: Memory
    ): Promise<boolean> => {
        if (message.content.text.length < 5) {
            return false;
        }

        return message.userId !== message.agentId;
    },
    description:
        "Extract recommendations to buy or sell memecoins/tokens from the conversation, including details like ticker, contract address, conviction level, and recommender username.",
    handler,
    examples: [
        {
            context: `Actors in the scene:
{{user1}}: Experienced DeFi degen. Constantly chasing high yield farms.
{{user2}}: New to DeFi, learning the ropes.

Recommendations about the actors:
None`,
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Yo, have you checked out $SOLARUG? Dope new yield aggregator on Solana.",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Nah, I'm still trying to wrap my head around how yield farming even works haha. Is it risky?",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "I mean, there's always risk in DeFi, but the $SOLARUG devs seem legit. Threw a few sol into the FCweoTfJ128jGgNEXgdfTXdEZVk58Bz9trCemr6sXNx9 vault, farming's been smooth so far.",
                    },
                },
            ] as ActionExample[],
            outcome: `\`\`\`json
[
  {
    "recommender": "{{user1}}",
    "ticker": "SOLARUG",
    "contractAddress": "FCweoTfJ128jGgNEXgdfTXdEZVk58Bz9trCemr6sXNx9",
    "type": "buy",
    "conviction": "medium",
    "alreadyKnown": false
  }
]
\`\`\``,
        },

        {
            context: `Actors in the scene:
{{user1}}: Solana maximalist. Believes Solana will flip Ethereum.
{{user2}}: Multichain proponent. Holds both SOL and ETH.

Recommendations about the actors:
{{user1}} has previously promoted $COPETOKEN and $SOYLENT.`,
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "If you're not long $SOLVAULT at 7tRzKud6FBVFEhYqZS3CuQ2orLRM21bdisGykL5Sr4Dx, you're missing out. This will be the blackhole of Solana liquidity.",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Idk man, feels like there's a new 'vault' or 'reserve' token every week on Sol. What happened to $COPETOKEN and $SOYLENT that you were shilling before?",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "$COPETOKEN and $SOYLENT had their time, I took profits near the top. But $SOLVAULT is different, it has actual utility. Do what you want, but don't say I didn't warn you when this 50x's and you're left holding your $ETH bags.",
                    },
                },
            ] as ActionExample[],
            outcome: `\`\`\`json
[
  {
    "recommender": "{{user1}}",
    "ticker": "COPETOKEN",
    "contractAddress": null,
    "type": "sell",
    "conviction": "low",
    "alreadyKnown": true
  },
  {
    "recommender": "{{user1}}",
    "ticker": "SOYLENT",
    "contractAddress": null,
    "type": "sell",
    "conviction": "low",
    "alreadyKnown": true
  },
  {
    "recommender": "{{user1}}",
    "ticker": "SOLVAULT",
    "contractAddress": "7tRzKud6FBVFEhYqZS3CuQ2orLRM21bdisGykL5Sr4Dx",
    "type": "buy",
    "conviction": "high",
    "alreadyKnown": false
  }
]
\`\`\``,
        },

        {
            context: `Actors in the scene:
{{user1}}: Self-proclaimed Solana alpha caller. Allegedly has insider info.
{{user2}}: Degen gambler. Will ape into any hyped token.

Recommendations about the actors:
None`,
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "I normally don't do this, but I like you anon, so I'll let you in on some alpha. $ROULETTE at 48vV5y4DRH1Adr1bpvSgFWYCjLLPtHYBqUSwNc2cmCK2 is going to absolutely send it soon. You didn't hear it from me 🤐",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Oh shit, insider info from the alpha god himself? Say no more, I'm aping in hard.",
                    },
                },
            ] as ActionExample[],
            outcome: `\`\`\`json
[
  {
    "recommender": "{{user1}}",
    "ticker": "ROULETTE",
    "contractAddress": "48vV5y4DRH1Adr1bpvSgFWYCjLLPtHYBqUSwNc2cmCK2",
    "type": "buy",
    "conviction": "high",
    "alreadyKnown": false
  }
]
\`\`\``,
        },

        {
            context: `Actors in the scene:
{{user1}}: NFT collector and trader. Bullish on Solana NFTs.
{{user2}}: Only invests based on fundamentals. Sees all NFTs as worthless JPEGs.

Recommendations about the actors:
None
`,
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "GM. I'm heavily accumulating $PIXELAPE, the token for the Pixel Ape Yacht Club NFT collection. 10x is inevitable.",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "NFTs are a scam bro. There's no underlying value. You're essentially trading worthless JPEGs.",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "Fun staying poor 🤡 $PIXELAPE is about to moon and you'll be left behind.",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Whatever man, I'm not touching that shit with a ten foot pole. Have fun holding your bags.",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "Don't need luck where I'm going 😎 Once $PIXELAPE at 3hAKKmR6XyBooQBPezCbUMhrmcyTkt38sRJm2thKytWc takes off, you'll change your tune.",
                    },
                },
            ],
            outcome: `\`\`\`json
[
  {
    "recommender": "{{user1}}",
    "ticker": "PIXELAPE",
    "contractAddress": "3hAKKmR6XyBooQBPezCbUMhrmcyTkt38sRJm2thKytWc",
    "type": "buy",
    "conviction": "high",
    "alreadyKnown": false
  }
]
\`\`\``,
        },

        {
            context: `Actors in the scene:
{{user1}}: Contrarian investor. Bets against hyped projects.
{{user2}}: Trend follower. Buys tokens that are currently popular.

Recommendations about the actors:
None`,
            messages: [
                {
                    user: "{{user2}}",
                    content: {
                        text: "$SAMOYED is the talk of CT right now. Making serious moves. Might have to get a bag.",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "Whenever a token is the 'talk of CT', that's my cue to short it. $SAMOYED is going to dump hard, mark my words.",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Idk man, the hype seems real this time. 5TQwHyZbedaH4Pcthj1Hxf5GqcigL6qWuB7YEsBtqvhr chart looks bullish af.",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "Hype is always real until it isn't. I'm taking out a fat short position here. Don't say I didn't warn you when this crashes 90% and you're left holding the flaming bags.",
                    },
                },
            ],
            outcome: `\`\`\`json
[
  {
    "recommender": "{{user2}}",
    "ticker": "SAMOYED",
    "contractAddress": "5TQwHyZbedaH4Pcthj1Hxf5GqcigL6qWuB7YEsBtqvhr",
    "type": "buy",
    "conviction": "medium",
    "alreadyKnown": false
  },
  {
    "recommender": "{{user1}}",
    "ticker": "SAMOYED",
    "contractAddress": "5TQwHyZbedaH4Pcthj1Hxf5GqcigL6qWuB7YEsBtqvhr",
    "type": "dont_buy",
    "conviction": "high",
    "alreadyKnown": false
  }
]
\`\`\``,
        },
    ],
};

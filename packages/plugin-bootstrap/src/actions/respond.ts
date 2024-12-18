import {
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    type Action,
} from "@ai16z/eliza";

export const respondAction: Action = {
    name: "RESPOND",
    similes: [
        "RESPOND",
        "NO_ACTION",
        "NO_RESPONSE",
        "NO_REACTION",
        "RESPONSE",
        "REPLY",
        "DEFAULT",
    ],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true;
    },
    description:
        "Respond with a message, or post an original message. This is the default if no other action is specified.",
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _response: Memory,
        callback: HandlerCallback
    ): Promise<boolean> => {
        if (_response) {
            callback(_response.content as Content);
        }
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Hey whats up" },
            },
            {
                user: "{{user2}}",
                content: { text: "oh hey", action: "RESPOND" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "did u see some faster whisper just came out",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "yeah but its a pain to get into node.js",
                    action: "RESPOND",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "the things that were funny 6 months ago are very cringe now",
                    action: "RESPOND",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "lol true",
                    action: "RESPOND",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "too real haha", action: "RESPOND" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "gotta run", action: "RESPOND" },
            },
            {
                user: "{{user2}}",
                content: { text: "Okay, ttyl", action: "RESPOND" },
            },
            {
                user: "{{user1}}",
                content: { text: "", action: "IGNORE" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "heyyyyyy", action: "RESPOND" },
            },
            {
                user: "{{user2}}",
                content: { text: "whats up long time no see" },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "chillin man. playing lots of fortnite. what about you",
                    action: "RESPOND",
                },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "u think aliens are real", action: "RESPOND" },
            },
            {
                user: "{{user2}}",
                content: { text: "ya obviously", action: "RESPOND" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: { text: "drop a joke on me", action: "RESPOND" },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "why dont scientists trust atoms cuz they make up everything lmao",
                    action: "RESPOND",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "haha good one", action: "RESPOND" },
            },
        ],

        [
            {
                user: "{{user1}}",
                content: {
                    text: "hows the weather where ur at",
                    action: "RESPOND",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "beautiful all week", action: "RESPOND" },
            },
        ],
    ] as ActionExample[][],
} as Action;

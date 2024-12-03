import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
    elizaLogger,
    composeContext,
    generateObject,
    ModelClass,
    models,
    splitChunks,
    trimTokens,
    generateText,
} from "@ai16z/eliza";
import { ObsidianProvider } from "../providers/obsidianClient";
import { validateObsidianConfig } from "../enviroment";
import { NoteContent } from "../types";
import { baseSummaryTemplate, summaryTemplate } from "../templates/summary";

let obsidianInstance: ObsidianProvider | undefined;

async function getObsidian(runtime: IAgentRuntime): Promise<ObsidianProvider> {
    if (!obsidianInstance) {
        elizaLogger.info("Creating new ObsidianProvider instance");
        const config = await validateObsidianConfig(runtime);
        obsidianInstance = await ObsidianProvider.create(
            parseInt(config.OBSIDIAN_API_PORT),
            config.OBSIDIAN_API_TOKEN
        );
    }
    return obsidianInstance;
}

export const getActiveNoteAction: Action = {
    name: "GET_ACTIVE_NOTE",
    similes: [
        "FETCH_ACTIVE_NOTE",
        "READ_ACTIVE_NOTE",
        "CURRENT_NOTE",
        "ACTIVE_NOTE",
        "OPEN_NOTE",
        "CURRENT_FILE",
    ],
    description:
        "Retrieve and display the content of the currently active note in Obsidian",
    validate: async (runtime: IAgentRuntime) => {
        try {
            const obsidian = await getObsidian(runtime);
            await obsidian.connect();
            return true;
        } catch (error) {
            elizaLogger.error("Failed to validate Obsidian connection:", error);
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.info("Starting get active note handler");
        const obsidian = await getObsidian(runtime);

        try {
            elizaLogger.info("Fetching active note content");
            const noteContent: NoteContent = await obsidian.getActiveNote();

            elizaLogger.info(
                `Successfully retrieved active note: ${noteContent.path}`
            );

            if (callback) {
                callback({
                    text: noteContent.content,
                    metadata: {
                        path: noteContent.path,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error getting active note:", error);
            if (callback) {
                callback({
                    text: `Error retrieving active note: ${error.message}`,
                    error: true,
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
                    text: "What's in my current note?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{content}}",
                    action: "GET_ACTIVE_NOTE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the active note",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{content}}",
                    action: "GET_ACTIVE_NOTE",
                },
            },
        ],
    ],
};

export const summarizeActiveNoteAction: Action = {
    name: "SUMMARIZE_ACTIVE_NOTE",
    similes: [
        "SUMMARIZE_ACTIVE_NOTE",
        "SUMMARIZE_CURRENT_NOTE",
        "SUMMARIZE_OPEN_NOTE",
    ],
    description:
        "Generate a focused summary of the currently active note in Obsidian",
    validate: async (runtime: IAgentRuntime) => {
        try {
            elizaLogger.info("Validating Obsidian connection");
            const obsidian = await getObsidian(runtime);
            await obsidian.connect();
            elizaLogger.info("Obsidian connection validated successfully");
            return true;
        } catch (error) {
            elizaLogger.error("Failed to validate Obsidian connection:", error);
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.info("Starting summarize active note handler");
        const obsidian = await getObsidian(runtime);

        try {
            elizaLogger.info("Fetching active note content");
            const noteContent: NoteContent = await obsidian.getActiveNote();

            if (!state) {
                state = (await runtime.composeState(message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }
            const model = models[runtime.character.settings.model];
            const chunkSize = 6500;

            const chunks = await splitChunks(noteContent.content, chunkSize, 0);
            let currentSummary = "";

            elizaLogger.info("Composing summary context");
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                state.currentSummary = currentSummary;
                state.currentChunk = chunk;
                const context = composeContext({
                    state,
                    template: trimTokens(
                        baseSummaryTemplate,
                        chunkSize,
                        "gpt-4o-mini"
                    ),
                });
                const summary = await generateText({
                    runtime,
                    context,
                    modelClass: ModelClass.MEDIUM,
                });

                currentSummary = currentSummary + "\n" + summary;
            }
            if (!currentSummary) {
                elizaLogger.error("Error: No summary found");
                return false;
            }
            if (callback) {
                if (
                    currentSummary.trim()?.split("\n").length < 4 ||
                    currentSummary.trim()?.split(" ").length < 100
                ) {
                    callback({
                        text: `Here is the summary:\n\`\`\`md\n${currentSummary.trim()}\n\`\`\``,
                        metadata: {
                            path: noteContent.path,
                        },
                    });
                } else {
                    callback({
                        text: currentSummary.trim(),
                        metadata: {
                            path: noteContent.path,
                        },
                    });
                }
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error summarizing active note:", error);
            if (callback) {
                callback({
                    text: `Error summarizing active note: ${error.message}`,
                    error: true,
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
                    text: "Summarize my current note",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{content}}",
                    action: "SUMMARIZE_ACTIVE_NOTE",
                },
            },
        ],
    ],
};

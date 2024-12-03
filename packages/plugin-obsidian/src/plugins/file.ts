import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
    elizaLogger,
    Content,
} from "@ai16z/eliza";
import { ObsidianProvider } from "../providers/obsidianClient";
import { validateObsidianConfig } from "../enviroment";
import { NoteContent } from "../types";

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

export const grabNoteAction: Action = {
    name: "GRAB_OBSIDIAN_NOTE",
    similes: [
        "GET_NOTE",
        "FETCH_NOTE",
        "READ_NOTE",
        "RETRIEVE_NOTE",
        "LOAD_NOTE",
        "OPEN_NOTE",
        "ACCESS_NOTE",
        "VIEW_NOTE",
        "SHOW_NOTE",
        "GRAB",
    ],
    description:
        "Retrieve and display the content of a specific note from Obsidian vault by path. Use format: 'Grab FOLDER/SUBFOLDER/Note Name.md'",
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
        elizaLogger.info("Starting grab note handler");
        const obsidian = await getObsidian(runtime);

        try {
            let path = "";
            const text = message.content.text;

            // Extract path from text like "Grab FOLDER/Note.md"
            if (text) {
                const match = text.match(/^(?:Grab\s+)?(.+\.md)$/i);
                if (match) {
                    path = match[1];
                }
            }

            // Fallback to explicit path if provided
            if (!path && message.content.path) {
                path = message.content.path as string;
            }

            if (!path) {
                throw new Error(
                    "Note path is required. Use format: 'Grab FOLDER/SUBFOLDER/Note Name.md'"
                );
            }

            elizaLogger.info(`Fetching note at path: ${path}`);
            const noteContent: NoteContent = await obsidian.getNote(path);

            elizaLogger.info(`Successfully retrieved note: ${path}`);

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
            elizaLogger.error("Error grabbing note:", error);
            if (callback) {
                callback({
                    text: `Error retrieving note: ${error.message}`,
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
                    text: "Grab BLOG POSTS/How to Angel Invest, Part 1.md",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{content}}",
                    action: "GRAB_OBSIDIAN_NOTE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Grab BLOG POSTS/STARTUPS/Build a Team that Ships.md",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{content}}",
                    action: "GRAB_OBSIDIAN_NOTE",
                },
            },
        ],
    ],
};

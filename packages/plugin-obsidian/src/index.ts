import { searchVaultAction } from "./plugins/vault";
import {
    getActiveNoteAction,
    summarizeActiveNoteAction,
} from "./plugins/activeNote";
import { grabNoteAction } from "./plugins/file";
export const obsidianPlugin = {
    name: "obsidian",
    description: "Search Obsidian vault using Omnisearch",
    actions: [summarizeActiveNoteAction, getActiveNoteAction, grabNoteAction],
    evaluators: [],
    services: [],
    providers: [],
};

export * from "./types";
export { searchVaultAction };

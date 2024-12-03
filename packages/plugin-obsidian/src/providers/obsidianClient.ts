import { NoteContent, ResultNoteApi, ServerInfo } from "../types";
import { elizaLogger } from "@ai16z/eliza";

export class ObsidianProvider {
    private connected: boolean = false;
    private static instance: ObsidianProvider | null = null;

    private constructor(
        private port: number = 27123,
        private token: string
    ) {}

    static async create(
        port: number,
        token: string
    ): Promise<ObsidianProvider> {
        if (!this.instance) {
            this.instance = new ObsidianProvider(port, token);
            await this.instance.connect();
        }
        return this.instance;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        try {
            const response = await fetch(`http://127.0.0.1:${this.port}/`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const serverInfo: ServerInfo = await response.json();

            if (!serverInfo.authenticated) {
                throw new Error("Failed to authenticate with Obsidian API");
            }

            this.connected = true;
        } catch (error) {
            elizaLogger.error("Failed to connect to Obsidian:", error);
            this.connected = false;
            throw error;
        }
    }

    async getNote(path: string): Promise<NoteContent> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `http://127.0.0.1:${this.port}/vault/${encodeURIComponent(
                    path
                )}`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        accept: "application/vnd.olrapi.note+json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const noteContent: NoteContent = await response.json();
            return noteContent;
        } catch (error) {
            elizaLogger.error("Failed to fetch note content:", error);
            throw error;
        }
    }

    async getActiveNote(): Promise<NoteContent> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `http://127.0.0.1:${this.port}/active/`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        accept: "application/vnd.olrapi.note+json",
                    },
                }
            );

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error("No active file found in Obsidian");
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const noteContent: NoteContent = await response.json();
            return noteContent;
        } catch (error) {
            elizaLogger.error("Failed to fetch active note content:", error);
            throw error;
        }
    }

    async search(
        query: string,
        contextLength: number = 100
    ): Promise<ResultNoteApi[]> {
        if (!this.connected) {
            await this.connect();
        }

        // Split on OR to get main chunks
        const orQueries = query.split(/\s+OR\s+/).map((q) => q.trim());

        elizaLogger.info(
            `Processing search query with OR operator:`,
            orQueries
        );

        try {
            const allResults: ResultNoteApi[] = [];

            // Handle each OR chunk separately
            for (const orQuery of orQueries) {
                const response = await fetch(
                    `http://127.0.0.1:${
                        this.port
                    }/search/simple/?query=${encodeURIComponent(
                        orQuery
                    )}&contextLength=${contextLength}`,
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${this.token}`,
                            accept: "application/json",
                        },
                    }
                );
                elizaLogger.info(response.url);

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const results: ResultNoteApi[] = await response.json();
                allResults.push(...results);
            }

            // Remove duplicates based on filename
            const uniqueResults = Array.from(
                new Map(
                    allResults.map((item) => [item.filename, item])
                ).values()
            );

            elizaLogger.info(`Found ${uniqueResults.length} unique results`);
            elizaLogger.debug("Search results:", uniqueResults);
            return uniqueResults;
        } catch (error) {
            elizaLogger.error("Obsidian search failed:", error);
            throw error;
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    close() {
        this.connected = false;
        ObsidianProvider.instance = null;
    }
}

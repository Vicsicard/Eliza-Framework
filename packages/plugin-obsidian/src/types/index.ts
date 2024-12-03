import { z } from "zod";

export interface SearchMatchApi {
    context: string;
    match: {
        start: number;
        end: number;
    };
}

export interface NoteStats {
    ctime: number;
    mtime: number;
    size: number;
}

export interface NoteContent {
    tags: string[];
    frontmatter: Record<string, unknown>;
    stat: NoteStats;
    path: string;
    content: string;
}

export interface ResultNoteApi {
    filename: string;
    matches: SearchMatchApi[];
    score: number;
}

export interface ServerInfo {
    authenticated: boolean;
    ok: string;
    service: string;
    versions: {
        obsidian: string;
        self: string;
    };
}

export const SearchSchema = z.object({
    query: z.string().min(1),
    options: z
        .object({
            vault: z.string().optional(),
            includeExcerpt: z.boolean().optional(),
            limit: z.number().optional(),
        })
        .optional(),
});

export type SearchContent = z.infer<typeof SearchSchema>;

export function isSearchContent(obj: any): obj is SearchContent {
    try {
        SearchSchema.parse(obj);
        return true;
    } catch {
        return false;
    }
}

export const searchTemplate = `
Extract the following details for searching through an Obsidian vault:
- **query** (string): The search query to use for finding relevant notes.

Ensure that:
1. The query is relevant to the user's request
2. Use space-separated terms for combined search
3. Use OR operator when searching for alternatives
4. Keep the query focused and specific to the topic

Provide the details in the following JSON format:

\`\`\`json
{
    "query": "<search_query>"
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

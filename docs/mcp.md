# MCP server

Recall is an [MCP](https://modelcontextprotocol.io) server, so assistants such as Claude, Cursor or VS Code can use your library directly: make decks from a conversation, look up cards, or quiz you in chat with real scheduling.

- **Address:** `https://<your-recall>/mcp` (Streamable HTTP)
- **Auth:** sign in to Recall from the app (OAuth), or an API token from **Account settings → API tokens**, sent as `Authorization: Bearer rk_...`

The API tokens page shows the address and ready-to-copy setup, with a newly created token filled in.

## Connect

**Claude (claude.ai, desktop and mobile) and other apps that sign in**

Add a custom connector with the address `https://recall.example.com/mcp` and leave the client ID and secret empty.
The app opens Recall, you sign in and press **Allow**, and it's connected. The connection shows up as a token
named after the app under **Account settings → API tokens**; delete it there to disconnect.
Recall has to be reachable on a public HTTPS address for this (claude.ai connects from Anthropic's servers),
and `PUBLIC_URL` must be that address when Recall runs behind a proxy.

**Claude Code**

```bash
claude mcp add --transport http recall https://recall.example.com/mcp \
  --header "Authorization: Bearer rk_..."
```

**Cursor and other clients that read an `mcp.json`**

```json
{
  "mcpServers": {
    "recall": {
      "type": "http",
      "url": "https://recall.example.com/mcp",
      "headers": { "Authorization": "Bearer rk_..." }
    }
  }
}
```

Clients that only speak stdio can bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):
`npx mcp-remote https://recall.example.com/mcp --header "Authorization: Bearer rk_..."`.

## Tools

| Tool | What it does |
|---|---|
| `list_decks` | Decks and folders with ids, card totals and what's due now |
| `search_cards` | Find cards by text or tag, optionally in one deck or folder, or only flagged cards (paged, 200 max) |
| `import_decks` | Create decks, or add to the deck with the same name and folder ([JSON format](json-format.md)) |
| `add_cards` | Add cards to an existing deck by id |
| `rename_deck` | Rename a deck by id |
| `flag_card` | Flag a card to come back to (a typo, an unclear card), or clear the flag. Doesn't change scheduling |
| `get_stats` | Today's reviews, due counts, streak, 30-day retention, 7-day forecast |
| `next_card` | The next card to study: question, answer, and the interval each rating would give |
| `answer_card` | Rate a card `again` / `hard` / `good` / `easy`, which reschedules it |
| `undo_answer` | Undo the most recent rating |

Adding cards skips any card whose front (or cloze text) is already in the deck, so an assistant can safely retry.
The server tells the assistant to show only the question, wait for your answer, then reveal and rate.

## What a token can and can't do

A token can read your library, add decks and cards, rename decks, flag cards, and study. It can't edit card text, delete cards, decks or folders, change settings, or touch your account.
Revoke it on the API tokens page at any time. Signing out all other devices also deletes your tokens.

The endpoint ignores browser cookies, so only a request carrying a token works. It's stateless, answers plain JSON (no SSE), and has no sessions.

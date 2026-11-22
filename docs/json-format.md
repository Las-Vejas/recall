# Recall deck JSON

A simple format for creating decks from files, scripts or AI agents.
Import it from the **Import** page (drop a `.json` file or paste), or `POST` it to `/api/import/json`.
Machine-readable schema: `/recall-deck.schema.json` on your server.

```json
{
  "deck": "Spanish verbs",
  "folder": "Languages/Spanish",
  "description": "Present tense",
  "color": "#ff7a45",
  "newPerDay": 20,
  "cards": [
    { "front": "hablar", "back": "to speak", "tags": ["verb", "ar"] },
    ["comer", "to eat"],
    { "cloze": "Yo {{c1::hablo}} español y {{c2::como::comer}} pan", "extra": "present tense" }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `deck` | yes | Deck name |
| `folder` | no | `"Parent/Child"` or `["Parent", "Child"]`, created if missing |
| `description`, `color`, `newPerDay` | no | Only used when the deck is created |
| `cards` | yes | Up to 10,000 per import |

**Cards** come in three shapes:

- Basic: `{"front": "...", "back": "...", "tags": [...]}`. Markdown works.
- Short: `["front", "back"]`
- Cloze: `{"cloze": "... {{c1::answer}} ... {{c2::answer::hint}} ...", "extra": "..."}`. One card per number.

Several decks: `{"decks": [ {...}, {...} ]}` or a top-level list.

**Re-importing is safe.** If a deck with the same name already exists in the same folder, only cards whose front (or cloze text) isn't already there are added. The response reports `added` and `skipped` per deck.

**Errors** come back as HTTP 400 with an `errors` list, each with a path, e.g. `deck.cards[3].front: required`.

## For AI agents (API)

1. In Recall, open **Import → JSON → API access** and create a token. It is shown once.
2. The agent posts JSON:

```bash
curl -X POST https://recall.example.com/api/import/json \
  -H "Authorization: Bearer $RECALL_TOKEN" \
  -H "Content-Type: application/json" \
  --data @deck.json
```

The token can only import decks (`POST /api/import/json`) and read the library (`GET /api/decks`, `GET /api/folders`).
It can't edit, delete, study or change settings. Revoke or replace it on the same page.

The Import page also has a **Copy prompt for AI** button: paste it into any assistant and it will produce JSON in this format.

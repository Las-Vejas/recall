// Instructions a user can paste into any AI assistant so it produces importable decks.
export function agentPrompt(origin: string, withApi: boolean) {
  return `Create flashcards for my spaced-repetition app (Recall) as JSON in this exact format:

{
  "deck": "Deck name",
  "folder": "Optional/Folder/Path",
  "description": "Optional one-line description",
  "cards": [
    { "front": "Question (Markdown allowed)", "back": "Answer", "tags": ["optional", "tags"] },
    ["Short form: front", "back"],
    { "front": "Capital of Peru?", "back": "Lima", "typeIn": true },
    { "cloze": "The {{c1::hidden part}} becomes a blank; {{c2::another::with a hint}} makes a second card", "extra": "Optional note shown with the answer" }
  ]
}

Rules:
- Output only the JSON, no commentary.
- One fact per card; keep fronts specific and answers short.
- Use cloze cards for definitions, lists and sentences; basic cards for question → answer.
- Add "typeIn": true when the answer is short and exact (a word, name, number or spelling) so the learner types it.
- For several decks use {"decks": [ ... ]}.
- Re-importing the same deck name and folder only adds cards whose front/cloze text is new, so it's safe to retry.
- JSON Schema: ${origin}/recall-deck.schema.json
${withApi ? `
To add the deck directly, POST the JSON:
curl -X POST ${origin}/api/import/json \\
  -H "Authorization: Bearer $RECALL_TOKEN" \\
  -H "Content-Type: application/json" \\
  --data @deck.json
The response lists each deck with "added" and "skipped" counts. On a 400, "errors" lists every problem with its path (e.g. "deck.cards[3].front: required"); fix them and retry. GET ${origin}/api/decks lists existing decks.
` : ''}`;
}

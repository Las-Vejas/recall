// Unit tests for pure helpers: deck JSON validation and cloze parsing.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let parseDeckJson, clozeNumbers, parseOcclusion;
before(async () => {
  // these modules open the database on import: point them at a throwaway SQLite folder
  delete process.env.DATABASE_URL;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-unit-'));
  ({ parseDeckJson } = await import('../server/jsonImport.js'));
  ({ clozeNumbers, parseOcclusion } = await import('../server/cloze.js'));
});

describe('parseDeckJson', () => {
  it('accepts one deck, {decks: [...]}, a list of decks, or a JSON string', () => {
    const one = { deck: 'A', cards: [['q', 'a']] };
    assert.equal(parseDeckJson(one).length, 1);
    assert.equal(parseDeckJson({ decks: [one, { ...one, deck: 'B' }] }).length, 2);
    assert.equal(parseDeckJson([one]).length, 1);
    assert.equal(parseDeckJson(JSON.stringify(one))[0].name, 'A');
  });

  it('normalises cards, folders and tags', () => {
    const [d] = parseDeckJson({
      deck: ' Verbs ', folder: 'Languages / Spanish', cards: [
        ['hablar', 'to speak'],
        { front: 'comer', back: 'to eat', tags: ['verb', 'er ending'] },
        { cloze: 'Yo {{c1::hablo}}', extra: 'present' },
      ],
    });
    assert.equal(d.name, 'Verbs');
    assert.deepEqual(d.folder, ['Languages', 'Spanish']);
    assert.deepEqual(d.cards.map((c) => c.kind), ['basic', 'basic', 'cloze']);
    assert.equal(d.cards[1].tags, 'verb er_ending');
    assert.equal(d.cards[2].back, 'present');
  });

  it('reports every problem with its path', () => {
    try {
      parseDeckJson({ deck: '', color: 'red', cards: [{ back: 'x' }, { cloze: 'no blanks' }, 42] });
      assert.fail('should throw');
    } catch (e) {
      assert.deepEqual(e.errors.map((x) => x.split(':')[0]), ['deck.deck', 'deck.color', 'deck.cards[0].front', 'deck.cards[1].cloze', 'deck.cards[2]']);
    }
  });

  it('rejects empty imports and bad JSON', () => {
    assert.throws(() => parseDeckJson({ deck: 'A', cards: [] }), /no cards to import/);
    assert.throws(() => parseDeckJson('{oops'), /not valid JSON/);
  });
});

describe('clozeNumbers', () => {
  it('finds each distinct cloze number, sorted', () => {
    assert.deepEqual(clozeNumbers('{{c2::b}} {{c1::a}} {{c2::again}} {{c10::j::hint}}'), [1, 2, 10]);
    assert.deepEqual(clozeNumbers('no clozes here'), []);
    assert.deepEqual(clozeNumbers('{{c0::zero is not a cloze}}'), []);
  });
});

describe('parseOcclusion', () => {
  it('clamps boxes to the image and numbers unnumbered ones', () => {
    const o = parseOcclusion({ image: '/media/upload/a.png', masks: [{ x: 0.9, y: -1, w: 0.5, h: 0.2 }, { x: 0.1, y: 0.1, w: 0.1, h: 0.1, n: 7 }] });
    assert.equal(o.mode, 'one');
    assert.deepEqual(o.masks[0], { x: 0.9, y: 0, w: 0.1, h: 0.2, n: 1 });
    assert.equal(o.masks[1].n, 7);
  });

  it('refuses outside images, empty boxes and junk', () => {
    assert.throws(() => parseOcclusion({ image: 'https://evil.example/x.png', masks: [{ x: 0, y: 0, w: 1, h: 1 }] }), /uploaded to Recall/);
    assert.throws(() => parseOcclusion({ image: '/media/../etc/passwd', masks: [{ x: 0, y: 0, w: 1, h: 1 }] }), /uploaded to Recall/);
    assert.throws(() => parseOcclusion({ image: '/media/upload/a.png', masks: [] }), /at least one box/);
    assert.throws(() => parseOcclusion({ image: '/media/upload/a.png', masks: [{ x: 'a', y: 0, w: 1, h: 1 }] }), /numeric/);
    assert.throws(() => parseOcclusion('{nope'), /not valid JSON/);
  });
});

it('byName sorts numbered names naturally', async () => {
  const { byName } = await import('../server/folders.js');
  const names = ['10.1 Data Types', '1.10 Later', '2 Arrays', '1.2 Multimedia', 'b deck', '1.1 Data', 'A deck', '20 Last'];
  assert.deepEqual(names.map((name) => ({ name })).sort(byName).map((d) => d.name),
    ['1.1 Data', '1.2 Multimedia', '1.10 Later', '2 Arrays', '10.1 Data Types', '20 Last', 'A deck', 'b deck']);
});

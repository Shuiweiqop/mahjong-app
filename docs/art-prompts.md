# Image generation prompts for the game art

All three assets below now exist. The prompts are kept so that replacements, or
art for a new game, can match the style the existing pieces established.

> **Adding or replacing art:** put the original PNG in `art-src/games/` (lobby
> covers) or `art-src/games/cards/` (role cards), then run `npm run art` from
> `client/`. That resizes it and writes the WebP the app actually serves into
> `client/public/games/`.
>
> Do not put source PNGs in `client/public/` directly. The originals are around
> 40x the size of the served copies -- the full set was 40MB before this step
> existed, against 0.5MB after.

| Asset | Source | Served | Used by |
|---

## Shared style (the existing art all follows this)

Paste this into the generator along with whichever prompt you are using:

> Cute kawaii cartoon illustration, thick clean black outlines, flat cel shading
> with soft gradients, chibi proportions with big round eyes and blush cheeks.
> Deep midnight-blue and indigo palette (#1a1b3a, #2d2f5f) with violet-purple
> mid-tones and warm gold accents (#f0c674). Starry night atmosphere with small
> sparkles, dots and crescent moons. Friendly and whimsical, never scary or
> grim — a children's storybook feel. No text, no lettering, no watermark,
> no signature.

---

## 1. `kittens.png` — lobby cover (2752 × 1536, 16:9 landscape)

Match the format of the existing lobby covers: a horizontal ensemble scene, all
characters facing the viewer, a scenic background, no border frame.

> A wide 16:9 cartoon banner illustration for a party card game about exploding
> kittens. Four or five chubby cartoon kittens of different colours — ginger,
> grey tabby, white, calico — stand and sit in a row across the frame, facing
> the viewer with cheerful expressions. One kitten in the middle holds a
> cartoon bomb with a lit sparkling fuse, looking gleefully mischievous. Another
> kitten nearby peeks nervously from behind a large playing card. A few oversized
> playing cards float and scatter in the air around them, and a small pile of
> cards sits in the foreground. Cosy dark room at night behind them with a
> window showing a starry sky and a crescent moon, warm glowing lights,
> soft sparkles in the air. Composition balanced left to right with the
> characters centred, ample headroom at the top.
>
> [+ shared style block above]

**Negative prompt:** `text, letters, words, title, logo, watermark, signature, realistic, photorealistic, scary, gore, dark horror, blood, frame, border`

---

## 2. `card-witch.png` — role card (1696 × 2528, 2:3 portrait)

These are tarot-style cards: an ornate gold-and-violet decorative frame around
the edge, a single character seated centred inside it on a round patterned rug,
starry night background, glowing focal element.

> An ornate tarot-style portrait card. In the centre sits a cute cartoon witch:
> a young woman with long flowing hair, wearing a deep purple robe patterned with
> tiny gold stars, sitting cross-legged on a round patterned magic rug. She holds
> up one small glowing potion bottle in each hand — a softly glowing green
> healing potion in her right hand and a glowing violet potion in her left — both
> emitting gentle sparkles. Behind her a dark starry night sky with constellations,
> small galaxies and a crescent moon. Shelves of bottles and a bubbling cauldron
> are faintly visible in the dim background. The whole image is enclosed by an
> elaborate decorative border frame of gold filigree scrollwork on violet-blue,
> with small stars, crescent moons and diamond gems set into the corners and
> edges. Rounded card corners on a dark navy background.
>
> [+ shared style block above]

**Negative prompt:** `text, letters, words, numbers, watermark, signature, realistic, photorealistic, scary, evil, ugly, gore, wart, hag, green skin`

---

## 3. `card-hunter.png` — role card (1696 × 2528, 2:3 portrait)

Same frame and layout as the witch card, so they sit together as a set.

> An ornate tarot-style portrait card. In the centre sits a cute cartoon hunter:
> a friendly young man in a brown leather vest and a wide-brimmed hat with a
> feather, sitting cross-legged on a round patterned rug. He holds an
> old-fashioned wooden hunting rifle resting harmlessly across his lap, pointing
> safely off to the side and downwards, with both hands relaxed on it. He has a
> calm, resolute, kind expression. A small loyal hunting dog sits beside him
> looking up at him. Behind them a dark starry night sky with constellations and
> a crescent moon over a faint silhouette of pine forest. The whole image is
> enclosed by an elaborate decorative border frame of gold filigree scrollwork on
> violet-blue, with small stars, crescent moons and diamond gems set into the
> corners and edges. Rounded card corners on a dark navy background.
>
> [+ shared style block above]

**Negative prompt:** `text, letters, words, numbers, watermark, signature, realistic, photorealistic, violence, blood, gore, aiming weapon, pointing gun at viewer, muzzle flash, scary, military, modern firearm`

---

## Notes

- **Aspect ratio matters more than exact pixels.** Generators rarely hit
  1696 × 2528 exactly. Ask for 2:3 portrait for the cards and 16:9 landscape for
  the cover, then resize. The card is displayed at 200 × 300 CSS pixels and the
  cover at roughly 390 × 220, so anything at or above the sizes in the table is
  plenty.
- **The two role cards should be generated in the same session** if the tool
  supports it, so the frames match each other. The existing three cards share an
  almost identical border, which is what makes them read as a set.
- **The hunter prompt deliberately downplays the weapon** — resting, pointed
  away, with a dog for warmth. The existing art is gentle and family-friendly,
  and a card aiming a gun at the viewer would break that badly. Generators also
  tend to refuse or produce poor results for weapon prompts, so the framing
  helps on both counts.
- If a generator refuses the hunter entirely, an alternative that fits the game's
  mechanic just as well: a hunter with a **bow and quiver** instead of a rifle,
  bow unstrung and held at rest.

# R4: LLM-ready representation of documents, images and other media

Date: 2026-10-09. Status: research input, not a decision. Marking convention: **[V]** = seen in a search result or
fetched source this session; **[U]** = unverified (secondary source only, or from memory); **[R]** = reasoning, no data.
No personal data is used anywhere in this file.

## 1. Executive summary

1. There is no single standard, but a clear convergence: **Markdown for the LLM, a typed JSON tree with layout
   (bounding boxes, reading order, element roles) as the system of record.** Docling's `DoclingDocument` is the
   closest thing to an open standard of that shape [V] (<https://arxiv.org/pdf/2501.17887>).
2. EQStack should define its own thin envelope, `InterpretedMedia`, and treat every engine (Apple Vision, Docling,
   Mistral OCR, a VLM) as an adapter that fills it. Do not adopt any one engine's native schema as the contract.
3. The envelope holds three views of one artefact: `markdown` (what the chat LLM reads), `blocks[]` (typed,
   positioned, per-block confidence, may nest `children` for images inside images), and `provenance` (engine,
   model, version, context used).
4. Interpret once, cache by content hash + pipeline version, and feed the cached Markdown to later LLM calls. The
   LLM never re-views the pixels unless it asks for a specific region.
5. Pipeline: classify (cheap) -> route -> extract -> normalise to envelope -> optional context-aware pass -> cache.
6. Routing default on macOS: **Apple Vision text recognition for plain photos/screenshots** (free, local, fast);
   **Docling (local, MIT code) for PDFs and scanned documents**; a VLM pass only for figures, charts, and
   captions; a cloud OCR (Mistral OCR or Azure) as an opt-in fallback for hard scans.
7. Audio: transcript (Whisper-class) and a separate `soundscape` description; they are different fields, never merged.
8. Uncertainty is first-class: every block carries `confidence` in [0,1] plus a `status` of `ok | low | unsure`,
   and an `alternatives[]` list ("most likely X; or Y"). Engine confidences are not calibrated and must be
   normalised per engine (see section 5).
9. Context-awareness is a second, optional pass that gets the surrounding messages and is recorded in
   `provenance.contextUsed`; the first pass stays context-free so it is cacheable and reproducible.
10. Triage: photos, screenshots, voice notes, PDFs, then video; stop at links, stickers, contact cards and exotic
    office formats (section 4).

## 2. Established practice and engine comparison

### 2.1 What "established" means here

- The common currency is **Markdown plus a structured sidecar**. Azure's Layout API returns Markdown with
  paragraphs, headings, tables, figures, selection marks, formulas and barcodes when
  `outputContentFormat=markdown` is requested [V]
  (<https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/markdown-elements>).
  Docling exports Markdown or JSON from `DoclingDocument` [V]. Unstructured emits typed elements (Title,
  NarrativeText, ListItem, Table, FigureCaption, Image, Header, Footer, Formula) with tables as HTML in
  `metadata.text_as_html` [V] (<https://docs.unstructured.io/open-source/core-functionality/partitioning>).
- Markdown loses: bounding boxes, per-element confidence, nested figure structure, and the distinction between
  "caption of figure" and "paragraph that follows a figure". Hence the JSON sidecar.
- Bold/italic: Markdown can carry emphasis, but most layout engines keep it only partially. I found no source
  confirming emphasis fidelity for any of them [U]. Treat bold/italic as best-effort metadata, not guaranteed.
- George's "image of a document containing captioned images" case is the **hierarchical** case: a page region of
  type `figure` that itself has an OCR/description and a `caption` block. Docling (figure + caption linking,
  per secondary sources [U]) and Azure Content Understanding Layout (figure bounding boxes, PDF only [V]) are
  the nearest. Recursion (run the pipeline again on a cropped figure region) is the portable answer and is
  what `children[]` in the schema supports.

### 2.2 Comparison table

| Engine | Output | Structure kept | Local / cloud | Licence | Apple Silicon / macOS | Speed | Maturity |
|---|---|---|---|---|---|---|---|
| **Docling** (IBM / LF AI) | `DoclingDocument` -> Markdown, JSON, HTML | Layout analysis, table structure, reading order, figures; captions linked and headers/footers suppressed per secondary sources [U] | Local | Code MIT; each model has its own licence [V] | Yes. MLX acceleration is used for the Granite-Docling VLM pipeline, not the default pipeline [V] | Not measured here | High; very active (package at 2.95.x seen) [V] |
| **Marker** (Datalab) | Markdown, JSON, HTML | Headings, tables, equations, images, reading order (from project description [U]) | Local (PyTorch) or hosted | Code Apache 2.0; weights modified OpenRAIL-M, free for research/personal/startups under a revenue threshold ($5M seen; $2M in an older source, so check) [V] | PyTorch MPS works in practice [U] | Marketing claims ~25 pages/s on GPU [U] | Medium-high |
| **MinerU** (OpenDataLab) | Markdown, JSON | Layout, tables, formulas, reading order [U] | Local | One source: Apache-2.0-based "MinerU Open Source License" with scale and disclosure conditions; earlier AGPL belief not confirmed [V, single secondary source, verify LICENSE] | Reported to run on Apple Silicon [U] | Not measured | Medium-high, China-centred docs |
| **olmOCR 2** (AI2) | Markdown-like natural text | Reading order, tables, equations; strong on scans [U] | Local but needs NVIDIA GPU (7B VLM; 12 GB+ per newer write-ups, 20 GB per older README) [V]; or hosted APIs | Apache 2.0 reported, confirm LICENSE [V, secondary] | **Poor fit**: CUDA/vLLM oriented. Not viable on a Mac without a port [R] | GPU-bound | Good; tops olmOCR-Bench (82.4 vs Marker 76.1, MinerU 75.2, from a third-party guide, and the benchmark is by the same lab) [U] |
| **Mistral OCR** | Markdown, plus embedded image handles; tables as HTML [V partly] | Headings, tables, figures extracted as images; bbox coordinates not confirmed [U] | Cloud only | Proprietary API | N/A (cloud) | Fast, batch available | High. List price $4 per 1000 pages for the newest model on the official page; OCR 3 was $2 ($1 batch) [V] |
| **Azure Document Intelligence** (Layout) | JSON with spans plus Markdown option | Paragraph roles, headings, tables, figures, selection marks, formulas [V]; caption handling unconfirmed | Cloud (containers exist [U]) | Proprietary | N/A | Fast | Very high, enterprise. Price roughly $10 per 1000 pages in one third-party source, unverified [U] |
| **LlamaParse** | Markdown, JSON | Tiered; layout extraction extra; images extracted at tier rate [V] | Cloud only | Proprietary | N/A | Tier dependent | Medium-high. 1 / 3 / 10 / 45 credits per page for Fast / Cost-effective / Agentic / Agentic Plus, about $1.25 per 1000 credits [V]; rates differ between LlamaIndex doc sites |
| **Unstructured** | Typed element list, JSON | Titles, lists, tables (needs `infer_table_structure`), figure captions, headers/footers [V] | Local OSS library plus hosted API | Not confirmed from this session [U] (believed Apache 2.0) | Python, runs on Mac; hi-res strategy pulls heavy deps [U] | Slow in hi-res [U] | High as a connector layer, weaker as a pure OCR engine |
| **GOT-OCR2.0** | Plain or formatted (markdown, tikz, smiles, kern) via prompt [V] | Formulas, tables, charts, sheet music, region-level OCR by coordinates [V] | Local, 580M params [V] | Licence not confirmed here [U] | Small enough for MPS [R] | Light | Research-grade; not a full-page layout engine [R] |
| **Nougat** (Meta) | MultiMarkdown (`.mmd`) [V] | Academic PDFs: math, tables, footnotes | Local | Code MIT, **weights CC-BY-NC** [V] | Heavy; MPS works but slow [U] | Slow | Superseded; known repetition loops and hallucination, detected by logit heuristics [V]. **Not recommended** |
| **Apple Vision** `VNRecognizeTextRequest` / `RecognizeTextRequest` (macOS 15) | Observations: string candidates, normalised bounding boxes, confidence | Lines and words with boxes only. No headings, lists or tables | Local, on-device | Platform API | Native, Neural Engine; Swift only | Very fast | Very high. `.accurate` has no per-character boxes; confidence reported as mostly 0.5 or 1.0 in practice, so treat as a coarse signal [V] |
| **Apple Vision** `RecognizeDocumentsRequest` (macOS 26) | `DocumentObservation` with a container tree of paragraphs, tables, lists, barcodes; title and full text [V via secondary + Apple page snippet] | Paragraphs, tables, lists; one observation per image at present (verify) [V] | Local | Platform API | macOS 26+ only, so **not available on a macOS 15 host** | Fast | New (2025); exact table/list fields unverified [U] |

### 2.3 Reading of the table

- **Local + permissive + Mac-viable + structured** leaves Docling as the only strong candidate for documents.
  Apple Vision covers flat text. Marker is a second choice; its weights licence needs a check before shipping
  in an open-source project that others install.
- **olmOCR** and **Nougat** are out for different reasons (CUDA need; non-commercial weights and instability).
- **Cloud engines** (Mistral, Azure, LlamaParse) are a quality ceiling and an opt-in fallback. Any cloud path
  sends personal documents off-machine, so it needs the consent pattern already used elsewhere in the repo
  (default ask, never silent).
- **RecognizeDocumentsRequest** is the interesting future adapter: structure from the OS for free. Gate it on
  `#available(macOS 26)` and fall back to `RecognizeTextRequest`. A spike to see how much of the table/list tree
  is usable is worth a day.

## 3. Recommended intermediate format: `InterpretedMedia`

Design rules: (a) one envelope for every media kind; (b) Markdown is derived from blocks, never the other way;
(c) every claim has confidence and a way to say "unsure"; (d) provenance is mandatory; (e) schema is versioned
and engine-neutral so cache entries survive an engine swap by being marked stale, not unreadable.

```ts
// packages/media-interpretation/src/schema.ts (sketch, not final)
export const SCHEMA_VERSION = "1" as const;

export type MediaKind =
  | "photo" | "screenshot" | "chat_screenshot" | "document"   // document = scan, PDF page, receipt
  | "audio_speech" | "audio_other" | "video" | "other";

export type Status = "ok" | "low" | "unsure" | "failed" | "skipped";

export interface Confidence {
  score: number;                 // 0..1, normalised per engine (see calibration note)
  basis: "engine_native" | "logprob" | "verbalised" | "agreement" | "heuristic";
  status: Status;                // derived from thresholds, stored so consumers need not re-derive
}

export interface Alternative { text: string; score?: number }

export interface BBox { x: number; y: number; w: number; h: number; page?: number } // normalised 0..1, origin top-left

export type BlockRole =
  | "title" | "heading" | "paragraph" | "list_item" | "table" | "figure" | "caption"
  | "formula" | "code" | "header" | "footer" | "page_number" | "stamp" | "handwriting"
  | "bubble" | "timestamp_label" | "ui_chrome" | "barcode" | "other";

export interface Block {
  id: string;
  role: BlockRole;
  text?: string;                 // OCR text, verbatim
  markdown?: string;             // block rendered as markdown (tables as pipe tables or HTML)
  level?: number;                // heading level
  emphasis?: { bold?: boolean; italic?: boolean };   // best effort, often absent
  bbox?: BBox;
  readingOrder: number;
  language?: string;
  confidence: Confidence;
  alternatives?: Alternative[];  // "most likely X, or Y"
  // images inside images / figures inside scanned pages:
  description?: string;          // VLM description of a figure or photo region
  children?: Block[];            // recursion: a figure that contains its own text and captions
  captionOf?: string;            // block id this caption belongs to
  // chat screenshots:
  speaker?: { side: "left" | "right" | "centre"; label?: string; isSelf?: boolean };
  sentAt?: string;               // as printed in the image, not parsed
}

export interface AudioPart {
  transcript?: { segments: { start: number; end: number; text: string; speaker?: string;
                             confidence: Confidence }[]; language?: string };
  soundscape?: { description: string; tags?: string[]; confidence: Confidence }; // what can be heard, not said
}

export interface Provenance {
  engine: string;                // "apple-vision" | "docling" | "mistral-ocr" | "vlm:<id>" | "whisper" ...
  model?: string;
  version: string;               // engine or model version, exact
  pipelineVersion: string;       // EQStack adapter version; part of the cache key
  runAt: string;                 // ISO 8601
  local: boolean;                // false means content left the machine; surfaced to the user
  durationMs?: number;
  inputSha256: string;           // content hash of the source bytes
  contextUsed: ContextUsed | null;
}

export interface ContextUsed {
  kind: "none" | "adjacent_messages" | "thread_summary" | "contact_names" | "caption_text";
  messageIds?: string[];         // ids only; the text itself is not duplicated into the cache
  before: number; after: number; // how many surrounding messages were supplied
  note?: string;                 // what the context changed, e.g. "disambiguated a name"
}

export interface InterpretedMedia {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: MediaKind;
  summary?: string;              // 1-3 sentences for list views and search
  markdown: string;              // the LLM-facing rendering; derived from blocks + audio
  blocks: Block[];
  audio?: AudioPart;
  video?: { keyframes: { t: number; media: InterpretedMedia }[]; audio?: AudioPart };
  pages?: number;
  overall: Confidence;           // worst-plausible-case summary, not an average
  unsure: { what: string; why: string; mostLikely?: string; alternatives?: string[] }[];
  provenance: Provenance[];      // one per stage (ocr, layout, vlm, context pass)
  warnings?: string[];           // truncated, rotated, low resolution, password-protected ...
}
```

Notes on the design:

- **Markdown rendering rules** (so the LLM-facing view is stable): headings as `#`, tables as pipe tables (HTML
  when merged cells), figures as `> [figure: <description>] <caption>`, uncertain spans wrapped as
  `[?text|alt]`, chat bubbles as `**Them:** ...` / `**Me:** ...`. Keep the rules in one function, covered by
  golden tests, so a change in rendering is visible in review.
- **Images inside images:** `figure` block -> crop -> run pipeline -> result stored in `children`. Bound the
  recursion depth (2) and the count; the value drops fast.
- **Chat screenshots** are a document variant where `role: "bubble"` blocks have `speaker.side`. Side of the
  screen is a strong, cheap heuristic for who is speaking (right = sender in most chat apps) [R]; colour of the
  bubble is a second signal. Mark `speaker.label` as `unsure` when no name is visible, rather than guessing.
- **Audio:** keep `transcript` and `soundscape` as separate fields. A voice note with background traffic has both;
  music has a soundscape and maybe lyrics; silence has `skipped`. Whisper-class models expose per-segment
  `avg_logprob`, `compression_ratio` and `no_speech_prob`, which map to `Confidence.basis = "logprob"`
  [U, from memory of the Whisper implementation].
- **Video:** do not run a VLM per frame. Sample keyframes at scene changes plus a fixed cadence, interpret each
  as an image, transcribe the audio track once, and merge in `video`. Cap the frame count.
- **Cache key:** `inputSha256 + kind + pipelineVersion + contextHash`. First-pass (context-free) and
  context-pass results are separate entries so the cheap one is reusable.
- **Overall confidence is the minimum-risk summary**, not the mean: one unreadable amount on a receipt makes the
  receipt `low`, however clean the rest is.

## 4. Media-type triage

No usable frequency data exists in public sources for either channel. Searches this session returned only format
guidance (iMessage photos are HEIC/HEIF, video MOV/MP4, audio M4A; email commonly PDF, DOC/DOCX, JPEG/PNG,
spreadsheets) with no ranking [V]. A 2019 spam-vendor post that calls PDF the most common blocked type is one
vendor's filter data, not usage [V, weak]. **The ranking below is reasoning [R]. The cheapest real data source is
EQStack itself: a read-only count of attachments by UTI/MIME over the user's own local database (no content), which
should be the first task in the implementation plan.**

| Rank | Type | Channel | Why it ranks here [R] | Effort | Value | Plan |
|---|---|---|---|---|---|---|
| 1 | Photos (HEIC/JPEG) | iMessage, email | Highest volume by a wide margin; most are people, places, food | Low: Apple Vision classify/OCR plus one VLM caption call | Medium (alt text, search, "what was that photo") | Phase 1 |
| 2 | Screenshots (including chat screenshots) | iMessage mostly | Common, text-dense, high value per image; OCR is accurate on clean digital text | Low: `RecognizeTextRequest`; chat-bubble layout is a small extra | High | Phase 1 |
| 3 | Voice notes / audio messages | iMessage | Frequent, content is otherwise opaque, and transcription is mature | Low-medium: a local Whisper-class model; note existing IMAudioTranscription work in the repo | High | Phase 1 (check what already ships) |
| 4 | PDFs (text layer) | email, some iMessage | Very common in email; text layer needs no OCR, only structure | Low: Docling or text extraction | High | Phase 2 |
| 5 | Scanned / raster PDFs and phone-photographed documents | email, iMessage | Less common, but George's stated case; high value (receipts, forms, letters) | Medium: Docling plus Vision OCR, confidence handling | High | Phase 2 |
| 6 | Video | iMessage | Heavy and less frequent; interpret audio first, keyframes second | Medium-high | Medium | Phase 3 |
| 7 | Office docs (DOCX, XLSX, PPTX) | email | Text is already structured in the file; convert, do not OCR | Low with Docling / markitdown-style converters | Medium | Phase 3 |
| 8 | Link previews, stickers, Live Photos, Genmoji, contact cards, calendar invites | iMessage | Some already handled (Genmoji descriptions shipped per project history); the rest carry little hidden content | Low each | Low | Stop here |

**Diminishing returns** start after rank 5. Ranks 1 to 3 cover the large majority of volume by assumption
[R] and ranks 4 and 5 cover the highest-value documents. Beyond that, each type is niche, so handle it by
metadata only (filename, type, size) unless a user asks.

## 5. Context-aware interpretation and honest uncertainty

### 5.1 Context

What I found [V unless marked]:

- **MMDU** (<https://arxiv.org/html/2406.11833v2>) is a benchmark for multi-turn, multi-image dialogue, up to 20
  images and 27 turns. It shows open vision-language models degrade in long multi-turn image conversation. It
  evaluates dialogue about images, not "interpret this attachment given the messages around it", so it is
  adjacent evidence rather than a recipe.
- I found **no paper or established pattern specifically for feeding surrounding chat messages to a vision or audio
  model to improve attachment interpretation**. I believe this is under-studied. Treat the following as
  engineering judgement [R], to be validated with a small in-house eval.

Recommended pattern:

1. **Two passes.** Pass 1 is context-free and cached (OCR, layout, caption). Pass 2 is a text-level LLM call that
   receives pass-1 `markdown` plus N surrounding messages and produces a `summary`, resolves ambiguity
   ("the `0` vs `O` in a booking code", a name misread by OCR but present in the conversation), and sets
   `contextUsed`. Pass 2 never sees pixels unless a block is `unsure` and a re-crop is requested.
   Reason: contexts differ per message, pixels do not, so only pass 2 pays per use.
2. **Context as a prior, not as evidence.** The prompt must say: "use the messages only to choose between
   readings the image already supports; do not add text that is not visible." Otherwise the model will write
   what the conversation predicts rather than what the image says. Record in `contextUsed.note` any place the context
   changed the output, and keep the pre-context reading in `alternatives`.
3. **Small window by default** (about 5 messages before, 2 after, same sender and time-adjacent), widened only on
   `unsure`. A pointer-only record (`messageIds`) avoids copying private text into the cache.
4. **Audio:** pass the context as a vocabulary hint (names, places) to the recogniser's prompt/biasing where the
   engine supports it, and keep the transcript honest; do the disambiguation in pass 2 over text [R].

### 5.2 Calibrated "unsure + most likely"

Facts from the literature, with confidence in each:

- Models can estimate when they are likely right: Kadavath et al., "Language Models (Mostly) Know What They Know"
  (arXiv 2207.05221) [U, from memory, not re-fetched]. Verbalised confidence is usable but over-confident:
  Tian et al., "Just Ask for Calibration" (arXiv 2305.14975) and Xiong et al., "Can LLMs Express Their
  Uncertainty?" (arXiv 2306.13063) [U, from memory].
- Recent (2026) results found this session: frontier models rarely abstain even when abstaining is the
  utility-optimal choice (arXiv 2601.07767) [V, abstract level]; verbal confidence may predict the
  commit-or-abstain decision better than it predicts correctness, while log-probabilities track correctness
  better (arXiv 2603.22161, and a summary of 2606.29490) [V, abstract level; the sources differ on which is better, so
  neither can be assumed]. Conclusion: do not trust a single self-reported number.
- OCR engine confidence is also weak: Apple Vision `.accurate` was reported returning mostly 0.5 or 1.0 [V,
  forum thread 695693], so it is a coarse flag, not a probability.

Practical recipe [R], cheapest first:

1. **Prefer signals that are not self-reports:** engine-native confidence where it varies (Vision `.fast`,
   Docling per-element scores [U]), Whisper segment logprobs, and **agreement between two independent engines**
   (for example Vision vs Docling OCR on the same crop). Disagreement on a span is a strong, cheap `unsure` flag.
2. **Structural checks:** checksums and formats (dates, amounts, IBAN-like patterns, currency sums on a receipt
   adding up) turn a number into a verifiable claim.
3. **Verbalised confidence only as a tie-breaker**, requested as a bucket (`high | medium | low | cannot_read`)
   with a required reason, not a decimal.
4. **Calibrate per engine** on a small labelled set: map each raw signal to the three `Status` values by
   thresholds fitted so that `ok` spans are right at a target rate (say 98%). Store the mapping version in
   `provenance.pipelineVersion`. Without this step the numbers are decorative.
5. **Output contract:** the model is allowed (and prompted) to return `unsure` with `mostLikely` and
   `alternatives`; the Markdown rendering shows `[?text|alt]` and the summary must not state an `unsure` fact as plain
   fact. A `cannot_read` result is a valid, non-failure outcome.
6. **Do not silently re-view the image on every question.** If a downstream agent needs more certainty, it asks
   for a targeted re-interpretation of one block (crop, higher resolution, second engine), which updates the cache.

## 6. Open questions

1. **Real attachment mix.** What is the actual distribution by type and bytes on the user's own database? A
   read-only count by UTI/MIME answers the triage ranking in minutes.
2. **macOS target.** Is macOS 26 (`RecognizeDocumentsRequest`) a floor, an optional fast path, or ignored? The
   repo currently assumes a macOS 15 host.
3. **Docling on this machine.** Python dependency and model download size are a packaging cost for a
   Node/TypeScript monorepo. Options: a sidecar CLI invoked by the shared package, a Swift helper, or
   Granite-Docling via MLX. Needs a measured spike (cold start, pages per second, memory) [none measured here].
4. **Cloud fallback policy.** Which engines (if any) may receive document content, behind what consent, and with
   what redaction? Mistral OCR and Azure both send pages off-machine.
5. **Licences to confirm from the LICENSE files, not summaries:** MinerU (conflicting reports), Marker weights
   (threshold changed between sources), olmOCR, Unstructured, GOT-OCR2.0, Granite-Docling model weights.
6. **Emphasis and captions.** Do Docling and Apple's `RecognizeDocumentsRequest` expose bold/italic and
   figure-to-caption links in practice? Neither was confirmed here; test on a small sample of real documents.
7. **Context-pass value.** Does the context pass measurably improve accuracy, or mainly add hallucination risk?
   Needs an eval set with and without context before it becomes a default.
8. **Calibration set.** Who labels it, and can it be built from the user's own data without publishing any of it
   (the repo is public; the set must stay local and gitignored, with a synthetic set committed for CI)?
9. **Package boundary.** Where does `InterpretedMedia` live so both the iMessage and Gmail MCPs import it
   (a shared `packages/` entry versus the existing kit packages)? Coordinate with the other R-reports.

## Sources

- Docling technical report: <https://arxiv.org/pdf/2501.17887>
- Granite-Docling MLX card (via search): <https://ai.gitcode.com/hf_mirrors/ibm-granite/granite-docling-258M-mlx>
- Azure Markdown elements: <https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/markdown-elements>
- Azure Content Understanding Layout: <https://ai.azure.com/catalog/models/Azure-Content-Understanding-Layout>
- Apple `RecognizeDocumentsRequest`: <https://developer.apple.com/documentation/vision/recognizedocumentsrequest.md>
- Apple `RecognizeTextRequest`: <https://developer.apple.com/documentation/vision/recognizetextrequest.md>
- Apple forum, confidence 0.5/1.0: <https://developer.apple.com/forums/thread/695693>
- Apple forum, accurate mode boxes: <https://developer.apple.com/forums/thread/131510>
- olmOCR: <https://github.com/allenai/olmocr>, <https://pypi.org/project/olmocr>
- Marker: <https://pypi.org/project/marker-pdf/>
- Marker v2 vs MinerU, Docling (secondary): <https://www.marktechpost.com/2026/07/24/datalab-marker-v2-vs-mineru-docling-and-liteparse-benchmark-breakdown/>
- Mistral API pricing: <https://mistral.ai/fr/pricing/api/>
- LlamaParse pricing: <https://developers.llamaindex.ai/llamaparse/general/pricing/>
- Unstructured partitioning: <https://docs.unstructured.io/open-source/core-functionality/partitioning>
- GOT-OCR2.0: <https://arxiv.org/html/2409.01704v1>
- Nougat and Eclair: <https://arxiv.org/pdf/2502.04223>, <https://pypi.org/project/nougat-ocr>
- MMDU: <https://arxiv.org/html/2406.11833v2>
- Abstention and verbal confidence: <https://arxiv.org/pdf/2603.22161>, <https://www.arxiv.org/pdf/2407.16221>, <https://tianpan.co/blog/2026/04/27/calibrated-abstention-i-dont-know>

## Measured: attachment mix on gmac (added by eqstack, 2026-10-09)

Counts by type from one real chat.db (`GROUP BY mime_type`, counts only, no content read). This replaces the report's reasoned ranking above for iMessage:

| Rank | Type | Count | Interpretation path |
|---|---|---|---|
| 1 | images (jpeg 6996, png 2670, heic 2046, gif 121, tiff 2) | 11,835 | Vision OCR + caption; screenshots → bubbles |
| 2 | link-preview plugin payloads (null MIME) | 3,344 | not media: fold into the text row (gate card 8 `u`) |
| 3 | voice memos `.caf` (null MIME) + m4a 55 + amr 11 | 754 | the speech chain (gate card 1) |
| 4 | video (quicktime 598, mp4 12, 3gpp 19) | 629 | poster frame + audio track (audio interpretation, card 1d) |
| 5 | PDF | 204 | Docling / text extraction (shared with gmail) |
| 6 | vCard 187, location 91 | 278 | structured parse, no model needed |
| 7 | Office/CSV | 12 | metadata only (diminishing returns) |

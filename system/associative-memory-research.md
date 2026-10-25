# Associative memory — research survey and plan for Edva (2026-10-24)

The question: *interconnected, human-like memory, where concepts are stored interconnected and recalling one brings up all the memories associated with it.* This doc compares the field (existing systems and research papers, through Oct 2026) with what Edva already has (`system/wiki-architecture.md`). It then names the changes most likely to help, measurably.

**How the sources were read.** The research sandbox could not reach arxiv.org, OpenReview, the ACL Anthology or most vendor sites. Paper details come from search-engine extracts of those pages. GitHub source, PyPI and npm were read directly. Every benchmark number is the authors' or vendor's own claim unless marked otherwise. Treat single numbers as directional; §3 explains why.

**Implementation status (2026-10-24, same day, at the user's request to implement all of it).** Every step in § 5 is built and tested; what remains needs the live corpus on the host. Where each landed, and the design doc that now owns it (`system/wiki-architecture.md`):

| § 5 step | Code | Status |
|---|---|---|
| 0 · associative eval | `bin/wiki-recall-eval-gen`, `bin/wiki-recall-eval --set assoc` | built; the set is generated on the host (`wiki-recall-eval-gen --n 60`) |
| 1 · fan-normalized activation / PPR, third RRF list | `lib/wiki-assoc.mjs`, `searchPagesHybrid`, `wiki_associate` | `wiki_associate` and `episode_search associate:true` live; in `wiki_search`/`recall` behind `WIKI_ASSOC=sa\|ppr`, **off** until the eval decides |
| 2 · episodic context channel | day contiguity edges, `searchDaysAssociative`, `after`/`before` on the tools | live (date parsing stays with the agent — Rule #0b, so no regex date parser) |
| 3 · trigger cues | `page_cues.kind='trigger'`, `generateTriggerCues`, verbatim-evidence check | written nightly via `ai.claude.wiki-assoc-llm`; in ranking behind `WIKI_USE_TRIGGERS=1`, **off** until the eval decides |
| 4 · Hebbian co-retrieval | `lib/wiki-hebbian.mjs`, `wiki-link-weave` Step 5.5 | nightly via cron `wiki-assoc` |
| 5 · typed facts with validity | `lib/wiki-facts.mjs`, `wiki_read` facts block | written nightly; live in `wiki_read` and the association graph; as KNN entry points behind `WIKI_USE_FACTS=1`, **off** until the eval decides |
| 6 · base-level prior, reconsolidation | `lib/wiki-activation.mjs` (`WIKI_PRIOR=1`, off); `recalled_pages` + `jobs/dream.md` Step 4.7 | prior nightly, off in ranking; reconsolidation live in the dream |

One correction to § 5.1 found while building it: the association list's RRF weight has to be about 1.0, not "below 1". In RRF a page both direct lists find already scores ~2/61 against at most w/61 for an association-only page, so dominance is structural; at 0.6 an association-only page could never reach a top 10 against 60-long direct lists.

---

## 1. Bottom line

1. **Edva already has most of the structure the field uses.** It has a page graph (`page_links`), Memora-style cue anchors, hybrid BM25+KNN fused with RRF, nightly consolidation (the dream, the deep dream, link-weave), and episodic pages. What it lacks is a *retriever that uses the graph the way association works*, and an *eval that can see association at all*.
2. **The 1-hop expansion's zero gain was close to guaranteed by its design and its measurement.** It was not evidence against association (§2).
3. **Across the literature, association gains are real but modest.** They show up almost only on multi-hop and indirect-cue questions: roughly +1 to +3 points overall, larger on the multi-hop slice. Systems that keep the gains also keep dense and lexical retrieval dominant in the fusion.
4. **The biggest failure in 2026 benchmarks is the missing cue, not the missing hop.** Example: "planning dinner Friday" should bring up a guest's dietary restriction. Graph traversal at query time can't fix this. Cues written when the memory is saved can (T-Mem, Memora).
5. **Don't adopt a framework.** Nothing mature is Node+SQLite-native and Max-only. Graphiti needs Neo4j or FalkorDB and several LLM calls per write. Mem0 removed graph memory from its open-source SDK in 2026. GraphRAG is in maintenance mode. Borrow mechanisms instead; each one in §5 is a few hundred lines on the existing tables.

---

## 2. Why the 1-hop link expansion showed nothing

The code is `searchPagesHybrid` / `linkNeighbors` in `lib/wiki-embed.mjs`, from about line 823 and line 996. Four causes stack up:

| Cause | Where | Why it removes association |
|---|---|---|
| **The cosine floor re-gates neighbours by similarity to the query** (`EXPAND_FLOOR` 0.62) | `wiki-embed.mjs:1013-1019` | Associative recall exists to surface memories that are *not* similar to the cue but are strongly tied to what the cue activated (HeLa-Mem's definition). A hard similarity floor filters out exactly those. It also blocks every day page outright, because day narratives sit at 0.46–0.60 cosine. |
| **Wikilinks are followed forward only, and the hub cutoff is a hard step** (`HUB_DEGREE` 60) | `linkNeighbors` | "Recall <person> → everything about <person>" needs the *backward* edges: day pages link *to* people. Those are exactly the edges that were dropped. The cutoff also treats in-degree 59 as full strength and 61 as nothing. |
| **No convergence** | `linkNeighbors` keeps only the best seed per neighbour | Association pays off when a page is reached from *two or more* seeds at once (pattern completion). The current code doesn't add up evidence from several seeds. |
| **The eval can't register it** | `data/wiki-recall-eval.json`: every case has exactly one `expect` page, scored by hit@5 / MRR | "Brings up all associated memories" is a *set-recall* goal. A one-gold-page eval scores the same whether or not the associated pages came back. The architecture doc already notes the query set lacked multi-hop questions. |

The architecture doc's caveat holds: what was missing is a query set built around multi-hop questions, not evidence against the idea. Item 0 in §5 has to come first.

---

## 3. What the field shows (and how far to trust it)

- **Measured association gains are small:**
  - **HeLa-Mem** (ACL 2026): removing spreading activation costs about 2.5 F1 on LoCoMo (34.74 → 32.19).
  - **GAAMA** (2026): PPR alone adds about +1 pp over semantic search, and a well-tuned RAG baseline already beats HippoRAG and A-Mem.
  - **Mem0g:** graph memory added about 1.5 J over plain Mem0 (68.4 vs 66.9).
  - **Letta:** a filesystem agent using grep scored 74.0 on LoCoMo, above Mem0g.
- **The gains concentrate on multi-hop and temporal questions:**
  - SYNAPSE multi-hop 35.7 vs 27.0.
  - HippoRAG 2: +7 on MuSiQue / 2Wiki with *no* loss on single-hop.
  - Query-gated spreading activation: removing the gate costs 3.6–7.4 F1 and makes retrieval 1.5–4.9× slower.
- **The missing cue is the dominant open failure:**
  - **Keep It InMind** (2026): six vector, graph and agentic memory systems answer at most **14.4%** of indirect-cue queries, against 84% with the memory in context. An 8× larger embedding doesn't help.
  - **LoCoMo-Plus:** A-Mem falls from 67.9 to 18.2.
  - **T-Mem** (Tencent 2026) cuts that drop to about 5 points by writing *trigger cues* when the memory is saved.
- **More associative channels can hurt precision.** SuperLocalMemory V3.3 added Hopfield and spreading-activation channels and lost 14.9 pp on single-hop questions.
- **Vendor benchmark numbers are unreliable.**
  - Zep has been scored anywhere from 58 to 95 on LoCoMo, depending on who ran it, the judge model, and whether the 446 adversarial Category-5 questions were dropped.
  - MemDelta (2026) shows that swapping only the embedding model moves accuracy about 6 points and can flip rankings.
  - MemPalace's 96.6% was plain ChromaDB.
  - The consequence: only an eval on Edva's own corpus decides anything.

---

## 4. Landscape

### 4a. Existing systems (status checked on PyPI / npm / GitHub, 2026-10-24)

| System | Data model: what an edge means | How recall pulls in associated memories | LLM per write | Status | Take for Edva |
|---|---|---|---|---|---|
| **Zep / Graphiti** | Episodes → entities. An edge is a **fact sentence + embedding + bi-temporal validity** (`valid_at`/`invalid_at`, `created_at`/`expired_at`). Superseded facts are invalidated, not deleted. | Cosine + BM25 + BFS from hits. Reranked by RRF, graph distance, mention count, MMR or a cross-encoder. | Several (extract, resolve, dedup, invalidate) | 0.31.2, Apache-2.0, Python. Neo4j / FalkorDB only. Zep CE deprecated. | The fact-edge schema. |
| **Mem0** (v3 OSS) | Memories + entity collection. **Graph removed from OSS in 2026.** | Semantic candidates reranked by BM25 + entity-overlap boost. The boost **reorders; it never adds candidates.** | 1 (ADD-only) | py 2.2.1 / npm 3.3.1, Apache-2.0 | Entity boost as a reranker. |
| **Letta** (MemGPT) | Markdown memory files in git (MemFS). No graph. | The agent's own grep/search loop. A "sleep-time" agent consolidates in the background. | Background agent | 0.34.12; `letta-code` is TS | The closest in spirit to Edva. Validates the dream approach. |
| **Hindsight** (Vectorize) | Facts, experiences, observations, mental models. Entity, temporal, semantic and causal links. | **Four parallel channels: semantic, BM25, graph and temporal** (a date window parsed from the query). RRF, then cross-encoder, then recency multipliers. Graph score = `tanh(0.5·shared_entities)` + link weights. | ≥1 + consolidation | 1.1.0, MIT, Python server + Node client | **Best documented blueprint** for what's asked here. |
| **Cognee** | Entity / relation triplets. Edges carry `feedback_weight`. | Vector-seeded triplet traversal. Every edge rendered as text and embedded. `improve()` strengthens what was used. | Per chunk | 1.6.5, Apache-2.0. SQLite + Kuzu (Kuzu archived by Apple; fork is LadybugDB) | Triplet embeddings; feedback weights. |
| **HippoRAG 2** | Phrase nodes (OpenIE triples) + passage nodes + synonym edges | Query→triple match → LLM filter → **Personalized PageRank** seeded with phrases + dense-scored passages, weighted by node specificity | NER + OpenIE per passage | 2.0.0a5, MIT, low activity. Built for static corpora. | PPR in JS: a few ms on this corpus. |
| **Supermemory** | Memory→memory edges: **updates** (`isLatest`), **extends**, **derives** | Hybrid, latest version wins | Per add | MIT, TS, self-hostable | A cheap typed-edge vocabulary. |
| **Basic Memory** | Markdown + SQLite. `- [category] fact` observations, `- rel_type [[Target]]` **typed relations** | Hybrid FTS + vector; `build_context` walks relations | 0 | 0.24.1, **AGPL** | Nearest twin. Typed relations written in markdown. |
| **MemOS local plugin** | Traces / policies / world model / skills | FTS5 + vector + keyword, RRF + MMR | Several | `@memtensor/memos-local-plugin` 2.0.20, **Node + better-sqlite3**, MIT | Best Node+SQLite code to read; task-oriented. |
| **Memora** (MSR) | Primary abstraction + many-to-many cue anchors | **Iterative, LLM-steered anchor expansion with a stop decision** | Several | MIT, Python | Edva has the anchors; the iterative policy is the unborrowed part. |
| **A-MEM** | Zettelkasten notes; LLM-chosen links; "memory evolution" rewrites neighbours | kNN + linked notes | 2–3 | MIT, research code | Weak in third-party reruns (J≈48). |
| **LightRAG / GraphRAG** | Entities + relation descriptions; Leiden communities | Local / global / mix; map-reduce over communities | Per chunk + reports | MIT; GraphRAG in maintenance | Poor fit. Week/month pages already play the role of community summaries. |
| **MCP server-memory, Memento, rag-memory-mcp** | Entities / observations / typed relations | Substring or vector + attached relations | 0 | Node | Toys, but clean schemas. |

### 4b. Research mechanisms

| Mechanism | Papers | What propagates recall | Evidence | Cost |
|---|---|---|---|---|
| **Personalized PageRank** from query seeds | HippoRAG (NeurIPS '24), HippoRAG 2 (ICML '25), GAAMA | Random walk with restart; seeds weighted by specificity (≈IDF) | Strongest multi-hop record. Single-hop preserved only when dense passage scores are mixed into the seeds. | ~20 sparse matvecs, a few ms |
| **Spreading activation with the fan effect** (ACT-R) | SYNAPSE (ACL F '26), Query-Aware SA (2606.30133), ACT-R agent memory | `A_i = B_i + Σ W_j·S_ji`, `S_ji = S − ln(fan_j)`; lateral inhibition; per-step query gate | Query gate: +3.6–7.4 F1. SYNAPSE multi-hop +9 (against a disputed A-Mem baseline). | <10 ms |
| **Hebbian co-retrieval weights** | HeLa-Mem (ACL '26), Cognee, Kairos, BambooKG, AAR (2604.20850) | `w ← λ·w + η` when two memories are used together; edges decay | +2.5 F1 (HeLa-Mem). AAR: HotpotQA R@5 .831 → .916 from a 4M-parameter co-occurrence reranker, corpus-specific. | Nightly SQL |
| **Write-time trigger cues** | T-Mem (2606.15405), Memora, AssoMem | An LLM writes the *future situations* in which a memory should be recalled; these are indexed as anchors | The only mechanism with evidence on cue disconnect | Nightly LLM; zero at query time |
| **Context reinstatement + temporal contiguity** | TCM/CMR (Howard & Kahana), EM-LLM (ICLR '25), RaMem (2606.22844), TIDER, Zep bi-temporal | Retrieved episode → its time, people and places become new cues; D±1 neighbours pulled in | RaMem +10% F1, LoCoMo R@1 .366 → .418 | ~1 ms |
| **Base-level activation / forgetting** | ACT-R `B = ln Σ t^−d` (d≈0.5), Generative Agents, MemoryBank, FadeMem | Recency × frequency prior | No clean 2025–26 benchmark against vectors | Nightly SQL |
| **Reconsolidation** | Nader 2000; Retrieval-Driven Reconsolidation (2609.16053); MSR human-inspired arch (2605.08538) | A retrieved and contradicted page is marked for rewrite | Architectural; little measured | Nightly LLM, targeted |
| **CLS / sleep consolidation** | Auto-Dreamer, MemDream, HEMA, Letta sleep-time | Offline episodic → semantic distillation | Edva's dream already does this | — |
| **LLM-in-the-loop traversal; RL memory managers** | Memora policy, MRAgent, Mnemis System-2, MIRIX, Mem-α | An agent walks and prunes paths | Best headline numbers | Multiple LLM calls; doesn't fit 600 ms |

---

## 5. Plan for Edva, in order

Every step below is additive, behind a flag, and judged on the eval from step 0. That is how cues and expansion were already handled here.

### 0. Build an associative eval first (prerequisite)

The current 27-case set has one gold page each. Extend `wiki-recall-eval` with a multi-gold set:

- **Question templates:**
  - Bridge: "who did we have lunch with the day we went to X" → {X, day_D, person}.
  - Compositional: "what does Y's partner like".
  - Aggregation: "every restaurant with <friend> in 2026" → all matching days.
  - "What else happened when…".
  - Indirect cue: "planning dinner Friday" → a dietary-preference page that shares no words with the query.
  - Knowledge update: the head of a `supersedes` chain.
  - Event ordering.
  - Abstention, using a false premise.
- **Generation:**
  - A nightly or one-off `claude -p` pass samples 2–3-step paths. Weight each step by `ln(N/fan)` so paths avoid hubs.
  - Verbalize each path so the question names only the start entity.
  - Keep a question only if (a) it is answerable from all gold pages, (b) it is not answerable from any one gold page alone, and (c) BM25 does not put the final page in its top 3.
- **Three splits, reported separately:**
  - Wikilink paths.
  - **Text co-mention without a link.** This guards against circularity, since wikilink-generated questions favour wikilink expansion.
  - About 50 hand-labelled real questions from `edva_messages`, as the v2 set already does.
- **Metrics:**
  - **recall_all@k**: every gold page in the top k. This is LongMemEval's official definition.
  - recall_any@k, nDCG@10, and **final-hop recall**: the gold page BM25 can't reach.
  - The current single-hop set as a regression guard.
  - p50/p95 latency against the 600 ms `unified-recall` deadline.
  - Paired bootstrap per template.
- **Hygiene:** exclude eval runs from `wiki-access.jsonl`, or every access-derived signal below gets contaminated.

### 1. Replace hard-gated expansion with fan-normalized activation, fused as a third RRF list

This is a rewrite of `linkNeighbors`, with no LLM involved.

- **Load the graph:** about 1k nodes plus `page_links`, in memory, cached on the same `data_version` key as the vector index.
- **Edges:**
  - Traverse **both directions**.
  - Per-type base weights: `supersedes`/`related` > forward wikilink > backlink.
  - Add **receiving-side specificity** `S_j = max(0, ln(N/fan_j))` in place of `HUB_DEGREE`. a big topic hub (fan ≈1160) contributes 0; a much-linked person page (a few hundred) about 1.1; a typical person page about 4.6. Hubs fade smoothly instead of stepping off at 60.
- **Seeds:** top ~10 of the existing RRF fusion, with `W_j` set to their normalized fused scores.
- **Propagation:** 2 iterations of `a_i += Σ_j W_j·S_j·w_ji·g(i)`, keeping the top M≈20 (lateral inhibition).
- **Soft gate:** `g(i) = σ(κ·(cos(q, best_cue_i) − c0))` replaces the hard floor. Gating on the page's best *cue* rather than its whole-page vector is more discriminating.
- **Convergence comes free:** a page reached from several seeds adds up their activation.
- **Alternative to A/B:** PPR (α≈0.5, ~20 iterations, seeds `W_j·S_j`, final score ÷ `deg^0.5` so the walk doesn't pool in hubs). Pick whichever wins on the eval. Stacking both is not recommended.
- **Keep BM25 and dense dominant** (SYNAPSE weights semantic 0.5 / activation 0.3). The single-hop regression guard must hold.

### 2. Episodic context channel for day pages

This targets the day-page discrimination problem that `nomic-embed-text` cannot solve, without an LLM.

- **Structured conditions per day page:** date, people, places and trips. Most are free from existing wikilinks and the `places` frontmatter.
- **Query-time condition induction:** date parsing ("last Tuesday", "in <city>", "the week of…") plus dictionary match against the concept map (`data/wiki-link-concepts.json`).
- **Ranking:** rank pages that satisfy the conditions first, with content relevance as fallback (RaMem). Run this as a temporal channel alongside the others (Hindsight).
- **Contiguity:** when day D scores, pull in D±1 at decayed weight, forward about 1.5× backward (lag-CRP).
- **Context reinstatement as a second stage:** for "the day we…" questions, the anchor day's people and places become seeds for step 1.

### 3. Write-time trigger cues: turn on the aspect tier, reframed

This is the only fix with evidence for the missing-cue case.

- The `kind='aspect'` slot in `page_cues` already exists and is off because gemma3:1b invented tasks.
- Reframe the prompt from paraphrases to T-Mem's question: *"in what future situations should this be recalled?"* Examples: allergy → booking dinner, hosting, travel meals. Person → their birthday, their city, shared projects.
- Run it on the Sonnet rung for preference, person and project pages first, from the dream or a one-off batch. The doc's estimate for the corpus is about $2–3; incremental runs after that are small.
- The existing validator (rejects meta-questions) still applies. Add a grounding check: each cue must cite a span of the page.

### 4. Co-retrieval (Hebbian) weights, from logs Edva already writes

- **The signal already exists.** `data/auto-recall-judge.jsonl` records, for every judged message, which candidates the Sonnet judge **kept**. That is a labelled "used together" signal.
  - Pairs kept together → `coactivation(a, b, w, last_ts)`, updated nightly as `w = w·λ^Δdays + η` (HeLa-Mem: η≈0.02, λ≈0.995).
  - Count only judge-kept or answer-cited reads, never raw `wiki_search` hits. Kairos-style gating avoids a loop where the most-retrieved pages get retrieved more.
- **Use the weights two ways:**
  - Multiply edge weights in step 1: `w_ji · (1 + γ·w_hebb)`.
  - Feed strong co-activated pairs **with no link** to the weekly `wiki-link-weave` as `related` edge candidates. That job's model decides; the counts only propose.

### 5. Typed fact edges with validity (bigger lift; do after 1–4 are measured)

- **Most transferable schema** (Graphiti, Basic Memory, Supermemory): a `page_facts` table `(src, rel, dst, fact_text, embedding, valid_from, valid_to, superseded_by, source_page)`.
- **Write path:** extracted in nightly batches by the dream / `chat-consolidate`, not per write.
- **Recall:** the fact sentences become their own searchable channel ("<person> handles the supplier emails" matches directly).
- **Relation types:** a small vocabulary, `updates / extends / derives` plus kinship and role relations for people pages.
- **What it unlocks:** compositional questions (Y's partner → what they like), and knowledge-update questions answered by "latest wins" instead of prose.
- **Optional syntax:** Basic Memory's `- rel_type [[Target]]` inside the markdown keeps the pages human-editable.

### 6. Small priors (last, low weight)

- **ACT-R base-level activation** `ln Σ t_k^−d` (d=0.5; Petrov's approximation keeps k=10 exact references) from judge-kept accesses. Use it as a tie-breaker or a low-weight fourth list, never as a gate.
- **Reconsolidation:** when a page is read in a turn and the conversation contradicts or extends it, log it. The dream then rewrites *those* pages, with `supersedes` edges. This aims nightly LLM effort at pages that were actually used.

### Not recommended

- **Adopting Graphiti, Mem0, Cognee, HippoRAG or GraphRAG wholesale.** All are Python with external graph DBs and per-write LLM extraction. None runs Max-only via `claude -p`.
- **LLM-in-the-loop traversal on the hot path** (Memora's policy, MRAgent, Mnemis System-2). Too slow for 600 ms. Acceptable later as an opt-in "think harder" path for questions the agent flags as multi-hop.
- **GraphRAG / RAPTOR community summaries.** Week and month pages already serve this role, and the summaries do nothing for association.

---

## 6. Expected outcome

Based on the literature:

- Steps 1 + 2 should move **final-hop recall and recall_all on the bridge, aggregation and "what else happened" templates**, with single-hop flat.
- Step 3 is the only one that should move **indirect-cue** questions.
- Step 4 is worth about +2–3 points on associative slices.

If the text co-mention split shows no gain from step 1, the missing information is in the edges, not the propagation. In that case, invest in link-weave, Hebbian edges and fact edges rather than in tuning the propagation.

---

## Sources (primary links; see caveat at top)

**Systems**
- Graphiti: https://github.com/getzep/graphiti, arXiv 2501.13956
- Zep/Mem0 LoCoMo dispute: https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- Mem0 v3 migration (graph removed): https://docs.mem0.ai/migration/oss-v2-to-v3; Mem0 paper: arXiv 2504.19413
- Letta: https://www.letta.com/blog/benchmarking-ai-agent-memory, https://docs.letta.com/letta-code/memfs
- Hindsight: https://github.com/vectorize-io/hindsight (retrieval doc: `hindsight-docs/docs/developer/retrieval.md`), arXiv 2512.12818
- Cognee: https://github.com/topoteretes/cognee
- HippoRAG: https://github.com/OSU-NLP-Group/HippoRAG, arXiv 2405.14831, 2502.14802
- Supermemory: https://supermemory.ai/docs/concepts/graph-memory
- Basic Memory: https://github.com/basicmachines-co/basic-memory
- MemOS local plugin: https://www.npmjs.com/package/@memtensor/memos-local-plugin
- Memora: https://github.com/microsoft/Memora, arXiv 2602.03315
- A-MEM: arXiv 2502.12110

**Mechanisms**
- SYNAPSE: arXiv 2601.02744
- Query-Aware Spreading Activation: arXiv 2606.30133
- HeLa-Mem: arXiv 2604.16839, https://github.com/ReinerBRO/HeLa-Mem
- AAR, "Association Is Not Similarity": arXiv 2604.20850
- GAAMA: arXiv 2603.27910
- T-Mem: arXiv 2606.15405
- RaMem: arXiv 2606.22844
- RippleMem: arXiv 2608.13334
- AssoMem: arXiv 2510.10397
- EM-LLM: arXiv 2407.09450
- Generative Agents: arXiv 2304.03442
- MemoryBank: arXiv 2305.10250
- ACT-R activation equations: Anderson & Schooler 1991; Petrov 2006, https://alexpetrov.com/pub/iccm06
- TCM: Howard & Kahana 2002

**Benchmarks and critiques**
- LongMemEval: arXiv 2410.10813; `recall_all` in `src/retrieval/eval_utils.py`
- LoCoMo: arXiv 2402.17753
- LoCoMo-Plus: arXiv 2602.10715
- Keep It InMind: arXiv 2607.24368
- MemHop: arXiv 2607.19359
- BEAM: arXiv 2510.27246
- PerLTQA: arXiv 2402.16288
- MemoryAgentBench: arXiv 2507.05257
- MemDelta: arXiv 2606.29914
- Anatomy of Agentic Memory: arXiv 2602.19320
- ReFind: arXiv 2608.12888
- SuperLocalMemory V3.3: arXiv 2604.04514

**Surveys**
- From Human Memory to AI Memory: arXiv 2504.15965
- Memory Mechanism of LLM Agents: arXiv 2404.13501
- Rethinking Memory in AI: arXiv 2505.00675
- Memory in the Age of AI Agents: arXiv 2512.13564
- Graph-based Agent Memory taxonomy: arXiv 2602.05665

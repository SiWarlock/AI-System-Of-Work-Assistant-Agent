# Evaluation — Google Open Knowledge Format (OKF) for the System of Work Assistant

**Date:** 2026-06-29 · **Status:** Evaluated — **no architecture change adopted.** Kept on file as an optional future convention; revisit if OKF matures past v0.1 and gains adoption.

**Disposition:** `ARCHITECTURE.md` is left **as-is**. OKF is a low-regret *convention overlay* we could conform to later at near-zero cost, **not a dependency, not a V1 gate, and not a replacement for any subsystem (GBrain remains the semantic engine).**

---

## What OKF is (verified against primary sources)

Google Cloud published **Open Knowledge Format (OKF) v0.1 on 2026-06-12**, an open spec in `GoogleCloudPlatform/knowledge-catalog` (Apache-2.0; carries a "not an official Google product" disclaimer). It formalizes the "LLM-wiki pattern" (Karpathy's gist) into a portable convention. The whole spec fits on one page.

- A **bundle** = a directory tree of Markdown files; each file is a **"concept."**
- Each concept = **YAML frontmatter + Markdown body**. **Only `type` is required** (free string, not centrally registered; consumers MUST tolerate unknown types). Recommended optional fields: `title`, `description`, `resource` (URI), `tags`, `timestamp` (ISO-8601). Producers may add **custom keys; consumers MUST preserve unknown keys** when round-tripping.
- **Two reserved filenames:** `index.md` (directory listing / progressive disclosure, no frontmatter) and `log.md` (ISO-8601 date-grouped change history). Optional `# Citations` section. Optional `okf_version: "0.1"` in the root `index.md`.
- **Cross-links** are plain Markdown links — bundle-relative absolute (`/tables/customers.md`, recommended) or relative — forming an undirected graph; **consumers MUST tolerate broken links**.
- **Conformance is minimal:** parseable frontmatter + non-empty `type` + reserved-file shapes. Everything else is "soft guidance"; a consumer must not reject a bundle for missing optional fields, unknown types, unknown keys, or broken links.
- **Format, not platform** — no SDK, no runtime, no account. Reference tooling: a BigQuery enrichment agent, a self-contained static-HTML graph visualizer, sample bundles (GA4 / Stack Overflow / Bitcoin), and a ~50-line Python consumer (`pathlib`+`re`+`yaml`).

## Why it matters to us

**OKF is a formalization of the exact pattern we already built.** Our canonical layer is per-workspace **Obsidian-compatible Markdown repos**, each note = frontmatter (with a `type`) + body, cross-linked into a graph that GBrain indexes, with `index.md`/`log.md` conventions already in the OSB/GBrain lineage. Google independently converged on our design — a useful **external validation** of the finalized architecture's "user-owned, portable, human-and-agent-readable Markdown" principle.

## Fit analysis

**Aligns (near-zero cost):** We are ~90% conformant already. Honoring OKF means: every KnowledgeWriter-managed note has a non-empty `type` (we do); map the 5 recommended field names where they fit; optionally stamp `okf_version` on each workspace/global root `index.md`; align our `index.md`/`log.md` shapes to OKF's. Our richer governance frontmatter (`assistant-id`, `workspace-id`, visibility/egress, revision, stable IDs) and assistant-managed section markers ride along as **OKF custom keys** (which conformant consumers must preserve) — so OKF doesn't fight our schema.

**Diverges / falls short for us:**
1. **Structural, not semantic.** OKF standardizes the container, **not the meaning** — no registered type vocabulary, no typed-link semantics, no schema registry. We need that semantic layer (**GBrain schema packs**, typed links, bi-temporal facts, parity). OKF is a *subset* of our needs, **complementary to GBrain, not a substitute** — adopting it doesn't reduce build scope.
2. **Links.** OKF wants standard Markdown bundle-relative links; we use Obsidian `[[wikilinks]]`. GBrain parses both internally, but wikilinks won't resolve in *external* OKF consumers (non-fatal — broken links tolerated — but weakens portability). **The one real decision OKF surfaces.**
3. **Maturity/governance.** v0.1, days old, "starting point, not a finished standard," "not an official Google product," breaking major bumps expected. A reviewer noted the reference parser appears stricter than the spec (rejects files missing several fields though only `type` is "required") — a v0.1 inconsistency. Ecosystem gravity is still Google Cloud (Gemini + BigQuery). **Adopting it as a dependency now would be premature.**
4. **Domain skew.** Format is generic, but the spec + tooling target **data teams** (table schemas, metrics, BigQuery). The format fits us; the reference tooling mostly doesn't.

## Recommendation (for if/when revisited — NOT applied now)

Adopt OKF only as a **lightweight, reversible conformance profile**, never a dependency or hard gate. If revisited, where it would slot into `ARCHITECTURE.md`:

- **§6 (Knowledge):** a one-paragraph "OKF conformance profile" — KnowledgeWriter emits OKF-conformant frontmatter (`type` always present; map `title`/`description`/`timestamp`); GBrain schema-pack type values *are* the OKF `type`; governance fields are OKF custom keys; `index.md`/`log.md` follow OKF shapes.
- **§12:** a tiny OKF-conformance validator (the ~50-line reader is the reference) as a cheap CI check.
- **§18 / Phase-0:** one open decision — *managed links: standard Markdown bundle-relative (OKF-portable) vs Obsidian wikilinks (ergonomic)*. Lean: KnowledgeWriter emits standard Markdown links (Obsidian renders them); humans may still type wikilinks.

**Bottom line:** a smart, cheap bet to align with — validation of our design + a free portability/tooling option — but explicitly a convention overlay, not a new subsystem or dependency. Deferred for now; the architecture stands unchanged.

## Sources

- [OKF SPEC.md (GitHub)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [knowledge-catalog repo (Apache-2.0)](https://github.com/GoogleCloudPlatform/knowledge-catalog)
- [Google Cloud blog — how OKF can improve data sharing](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
- [MarkTechPost — neutral technical intro](https://www.marktechpost.com/2026/06/16/google-cloud-introduces-open-knowledge-format-okf-a-vendor-neutral-markdown-spec-for-giving-ai-agents-curated-context/)
- [Marc Bara — "A Standard, or Just a Folder?" (skeptical)](https://medium.com/@marc.bara.iniesta/googles-new-format-for-agent-context-a-standard-or-just-a-folder-82fb21d92041)
- [Suganthan — OKF analysis](https://suganthan.com/blog/open-knowledge-format/)

// VERBATIM copy of retrieveRelevantChunks' STAGE 2-3 as it was before rankCandidates()
// was extracted (retrieve.js). It exists only so rank-equivalence.test.mjs can prove the
// extraction changed nothing. Do not "improve" it: its value is that it never changes.
// RRF_K is the same constant as retrieve.js.
const RRF_K = 60;
export function legacyRank(candidates, topK) {
  if (!candidates.length) return [];

  // STAGE 2 — HYBRID RE-RANK. Pure cosine similarity is a single lens: it
  // finds semantically related text but has no special regard for exact
  // tokens, so a chunk holding the literal price, order code or name a
  // customer asked about can rank below a chunk merely "about the same
  // topic". Reciprocal Rank Fusion blends the vector rank with the keyword
  // rank computed above — a chunk strong on EITHER signal rises, without
  // either signal alone deciding membership (that's still MAX_DISTANCE).
  const byKeyword = [...candidates].sort((a, b) => Number(b.keywordRank) - Number(a.keywordRank));
  const vectorRank = new Map(candidates.map((c, i) => [c.id, i]));
  const keywordRank = new Map(byKeyword.map((c, i) => [c.id, i]));
  const fused = candidates
    .map((c) => ({
      ...c,
      score: 1 / (RRF_K + vectorRank.get(c.id)) + 1 / (RRF_K + keywordRank.get(c.id)),
    }))
    .sort((a, b) => b.score - a.score);

  // STAGE 3 — DIVERSITY, on TWO axes, DOCUMENT first and HEADING second.
  //
  // Heading-only round-robin (the original version of this stage) turned out
  // to give ZERO protection for the case it most needed to: two documents
  // that disagree. A single dense, dominant document naturally has many
  // DIFFERENT headings of its own — a "Pro" chunk, a "Plan Comparison" chunk,
  // an intro chunk — so grouping by heading text never even merges it with a
  // competing document's chunk (they don't share a heading key at all); the
  // dominant document's ten distinct headings simply outrank the other
  // document's one relevant chunk on fused score and fill every slot before a
  // second round of selection is ever reached. That silently defeated §6.10's
  // conflict-surfacing rule: the model never saw the contradicting chunk, so
  // it had nothing to flag. Confirmed against the exact fixture that exposed
  // it (a 10-chunk pricing docx vs. a 3-chunk conflicting price list) — the
  // conflicting chunk ranked 11th and never reached a topK of 6.
  //
  // The fix is to round-robin across DOCUMENTS as the primary axis — every
  // document represented before a second chunk from any one of them — and
  // only THEN diversify by heading within each document's own share, which
  // is what still protects the original case this stage was built for (a
  // long price table split into sub-chunks crowding out a different section
  // of the SAME document). `sourceTitle` is unique per tenant
  // (`@@unique([tenantId, title])`), so it is a safe, already-available
  // document identity to key on.
  const bySource = new Map();
  for (const c of fused) {
    if (!bySource.has(c.sourceTitle)) bySource.set(c.sourceTitle, new Map());
    const byHeadingInSource = bySource.get(c.sourceTitle);
    const key = c.heading ?? "";
    if (!byHeadingInSource.has(key)) byHeadingInSource.set(key, []);
    byHeadingInSource.get(key).push(c);
  }

  // Within one document, round-robin its own heading groups into a single
  // ordered list, best chunk first — the same algorithm as before, just
  // scoped per document instead of applied globally.
  const perSourceLists = [...bySource.values()].map((byHeadingInSource) => {
    const headingGroups = [...byHeadingInSource.values()].sort((a, b) => b[0].score - a[0].score);
    const ordered = [];
    for (let round = 0; headingGroups.some((g) => g[round]); round++) {
      for (const group of headingGroups) {
        if (group[round]) ordered.push(group[round]);
      }
    }
    return ordered;
  });
  // Documents visited in order of their OWN best chunk's score, so the
  // overall ranking priority among documents survives the round-robin.
  perSourceLists.sort((a, b) => b[0].score - a[0].score);

  const selected = [];
  for (let round = 0; selected.length < topK && perSourceLists.some((l) => l[round]); round++) {
    for (const list of perSourceLists) {
      if (selected.length >= topK) break;
      if (list[round]) selected.push(list[round]);
    }
  }

  return selected.slice(0, topK).map(({ score, keywordRank: _kw, ...rest }) => rest);
}

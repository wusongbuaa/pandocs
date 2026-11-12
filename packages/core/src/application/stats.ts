import { forbidden } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import { requireSpace, type AppContext } from "./context.js";
import type { DocumentService, TreeNode } from "./documents.js";
import type { SpaceService } from "./spaces.js";

export type Audience = "person" | "agent";

/** Someone at a browser, or a program: a token, the CLI or MCP, whoever it works for. */
export const audienceOf = (principal: Principal): Audience =>
  principal.kind === "user" && (principal.channel === "web" || principal.channel === "embed") ? "person" : "agent";

/** Writing these down one at a time would make reading a page a write. A replica that dies takes a few seconds of counts with it, which nobody will miss. */
const FLUSH_MS = 10_000;
const VIEWS_KEPT_DAYS = 400;
/** What people typed and asked can say more about them than which pages they read, so it goes sooner. */
const WORDS_KEPT_DAYS = 180;
const MAX_TERM_CHARS = 100;
const LISTED = 50;

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

/** One count for what is the same search: letter case and spacing make no difference. */
export const normalizeTerm = (term: string) => term.trim().replace(/\s+/gu, " ").toLowerCase().slice(0, MAX_TERM_CHARS);

export interface QuestionRecord {
  readonly space: string;
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly { readonly title: string; readonly url: string }[];
  readonly answered: boolean;
}

export class StatsService {
  private views = new Map<string, number>();
  private searches = new Map<string, { searches: number; empty: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService,
    private readonly spaces: SpaceService
  ) {}

  private get off(): boolean {
    return this.context.ports.statsDisabled === true;
  }

  private later(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  countView(documentId: string, audience: Audience): void {
    if (this.off) return;
    const key = `${today()}|${documentId}|${audience}`;
    this.views.set(key, (this.views.get(key) ?? 0) + 1);
    this.later();
  }

  countSearch(input: {
    readonly term: string;
    readonly results: number;
    readonly audience: Audience;
    readonly space?: string | undefined;
  }): void {
    const term = normalizeTerm(input.term);
    if (this.off || !term) return;
    const key = JSON.stringify([today(), input.space ?? "", term, input.audience]);
    const count = this.searches.get(key) ?? { searches: 0, empty: 0 };
    count.searches += 1;
    if (input.results === 0) count.empty += 1;
    this.searches.set(key, count);
    this.later();
  }

  /** Counts for a page deleted in the meantime are dropped rather than failing the rest. Sorted, because replicas add to the same rows. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const views = [...this.views]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => [...key.split("|"), count] as const);
    const searches = [...this.searches]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => [JSON.parse(key) as string[], count] as const);
    this.views = new Map();
    this.searches = new Map();
    try {
      if (views.length > 0) {
        await this.context.db.query(
          `INSERT INTO pandocs.page_views (day, document_id, audience, views)
           SELECT u.day, u.document_id, u.audience, u.views FROM unnest($1::date[], $2::uuid[], $3::text[], $4::bigint[]) AS u(day, document_id, audience, views)
           JOIN pandocs.documents d ON d.id = u.document_id
           ON CONFLICT (day, document_id, audience) DO UPDATE SET views = pandocs.page_views.views + EXCLUDED.views`,
          [views.map(row => row[0]), views.map(row => row[1]), views.map(row => row[2]), views.map(row => row[3])]
        );
      }
      if (searches.length > 0) {
        await this.context.db.query(
          `INSERT INTO pandocs.search_terms (day, space, term, audience, searches, empty)
           SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::bigint[])
           ON CONFLICT (day, space, term, audience) DO UPDATE SET searches = pandocs.search_terms.searches + EXCLUDED.searches, empty = pandocs.search_terms.empty + EXCLUDED.empty`,
          [
            searches.map(([key]) => key[0]),
            searches.map(([key]) => key[1]),
            searches.map(([key]) => key[2]),
            searches.map(([key]) => key[3]),
            searches.map(([, count]) => count.searches),
            searches.map(([, count]) => count.empty)
          ]
        );
      }
    } catch {
      // The numbers are a rough picture, and this runs on a timer with nobody to tell.
    }
  }

  /** `null` when nothing is being kept, which leaves nothing to say about the answer afterwards. */
  async recordQuestion(record: QuestionRecord): Promise<string | null> {
    if (this.off) return null;
    const { rows } = await this.context.db.query<{ id: string }>(
      `INSERT INTO pandocs.questions (space, question, answer, citations, answered) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [record.space, record.question, record.answer, JSON.stringify(record.citations), record.answered]
    );
    return rows[0]!.id;
  }

  /** The id is the only way to reach a question, and only whoever asked was given it. */
  async rateAnswer(id: string, helpful: boolean): Promise<void> {
    await this.context.db.query(`UPDATE pandocs.questions SET helpful = $2 WHERE id = $1`, [id, helpful]);
  }

  async sweep(): Promise<void> {
    await this.context.db.query(`DELETE FROM pandocs.page_views WHERE day < CURRENT_DATE - $1::integer`, [
      VIEWS_KEPT_DAYS
    ]);
    await this.context.db.query(`DELETE FROM pandocs.search_terms WHERE day < CURRENT_DATE - $1::integer`, [
      WORDS_KEPT_DAYS
    ]);
    await this.context.db.query(`DELETE FROM pandocs.questions WHERE created_at < now() - make_interval(days => $1)`, [
      WORDS_KEPT_DAYS
    ]);
  }

  /** The whole site for an administrator, or one space for those who look after it. A page someone cannot read is not in their numbers. */
  async insights(principal: Principal, input: { readonly space?: string | undefined; readonly days: number }) {
    const { db } = this.context;
    const { space, days } = input;
    if (space) await requireSpace(db, principal, space, "editor");
    else if (!principal.isAdmin) throw forbidden();
    await this.flush();
    const slugs = space ? [space] : (await this.spaces.list(principal)).map(item => item.slug);
    const pages = new Map<string, TreeNode & { readonly space: string }>();
    for (const slug of slugs)
      for (const node of await this.documents.tree(principal, slug)) pages.set(node.id, { ...node, space: slug });
    const ids = [...pages.keys()];
    const since = daysAgo(days);
    // A space's own words, or everyone's for the site as a whole.
    const inScope = space ?? null;

    const { rows: views } = await db.query<{ document_id: string; audience: Audience; views: string }>(
      `SELECT document_id, audience, sum(views) AS views FROM pandocs.page_views WHERE day >= $1 AND document_id = ANY($2::uuid[]) GROUP BY 1, 2`,
      [since, ids]
    );
    const { rows: daily } = await db.query<{ day: string; audience: Audience; views: string }>(
      `SELECT day::text AS day, audience, sum(views) AS views FROM pandocs.page_views WHERE day >= $1 AND document_id = ANY($2::uuid[]) GROUP BY 1, 2 ORDER BY 1`,
      [since, ids]
    );
    const { rows: votes } = await db.query<{ document_id: string; kind: string; count: string }>(
      `SELECT document_id, kind, count(*) AS count FROM pandocs.page_feedback WHERE created_at >= $1 AND document_id = ANY($2::uuid[]) GROUP BY 1, 2`,
      [since, ids]
    );
    const { rows: terms } = await db.query<{ term: string; audience: Audience; searches: string; empty: string }>(
      `SELECT term, audience, sum(searches) AS searches, sum(empty) AS empty FROM pandocs.search_terms WHERE day >= $1 AND ($2::text IS NULL OR space = $2) GROUP BY 1, 2`,
      [since, inScope]
    );
    const { rows: questions } = await db.query<{
      id: string;
      space: string;
      question: string;
      answer: string;
      citations: { title: string; url: string }[];
      answered: boolean;
      helpful: boolean | null;
      created_at: Date;
    }>(
      `SELECT * FROM pandocs.questions WHERE created_at >= $1 AND ($2::text IS NULL OR space = $2) ORDER BY created_at DESC LIMIT $3`,
      [since, inScope, LISTED]
    );
    const { rows: asked } = await db.query<{ total: string; unanswered: string; helpful: string; unhelpful: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE NOT answered) AS unanswered, count(*) FILTER (WHERE helpful) AS helpful, count(*) FILTER (WHERE NOT helpful) AS unhelpful
       FROM pandocs.questions WHERE created_at >= $1 AND ($2::text IS NULL OR space = $2)`,
      [since, inScope]
    );

    const pageRows = new Map<
      string,
      { people: number; agents: number; helpful: number; unhelpful: number; reports: number }
    >();
    const rowOf = (id: string) => {
      let row = pageRows.get(id);
      if (!row) pageRows.set(id, (row = { people: 0, agents: 0, helpful: 0, unhelpful: 0, reports: 0 }));
      return row;
    };
    for (const { document_id: id, audience, views: count } of views)
      rowOf(id)[audience === "person" ? "people" : "agents"] = Number(count);
    for (const { document_id: id, kind, count } of votes)
      rowOf(id)[kind === "helpful" ? "helpful" : kind === "unhelpful" ? "unhelpful" : "reports"] = Number(count);
    const byDay = new Map<string, { day: string; people: number; agents: number }>();
    for (const { day, audience, views: count } of daily) {
      const row = byDay.get(day) ?? { day, people: 0, agents: 0 };
      row[audience === "person" ? "people" : "agents"] = Number(count);
      byDay.set(day, row);
    }
    const termRows = new Map<string, { term: string; people: number; agents: number; empty: number }>();
    for (const { term, audience, searches, empty } of terms) {
      const row = termRows.get(term) ?? { term, people: 0, agents: 0, empty: 0 };
      row[audience === "person" ? "people" : "agents"] += Number(searches);
      row.empty += Number(empty);
      termRows.set(term, row);
    }
    const allTerms = [...termRows.values()];
    const total = (row: { people: number; agents: number }) => row.people + row.agents;
    const listedPages = [...pageRows].flatMap(([id, row]) => {
      const page = pages.get(id);
      return page ? [{ documentId: id, space: page.space, path: page.path, title: page.title, ...row }] : [];
    });
    return {
      collecting: !this.off,
      days,
      totals: {
        people: listedPages.reduce((sum, row) => sum + row.people, 0),
        agents: listedPages.reduce((sum, row) => sum + row.agents, 0),
        searches: allTerms.reduce((sum, row) => sum + total(row), 0),
        emptySearches: allTerms.reduce((sum, row) => sum + row.empty, 0),
        questions: Number(asked[0]!.total),
        unanswered: Number(asked[0]!.unanswered),
        helpfulAnswers: Number(asked[0]!.helpful),
        unhelpfulAnswers: Number(asked[0]!.unhelpful),
        helpful: listedPages.reduce((sum, row) => sum + row.helpful, 0),
        unhelpful: listedPages.reduce((sum, row) => sum + row.unhelpful, 0)
      },
      daily: [...byDay.values()],
      pages: listedPages.sort((a, b) => total(b) - total(a)).slice(0, LISTED),
      searches: [...allTerms].sort((a, b) => total(b) - total(a)).slice(0, LISTED),
      emptySearches: allTerms
        .filter(row => row.empty > 0)
        .sort((a, b) => b.empty - a.empty)
        .slice(0, LISTED),
      questions: questions.map(row => ({
        id: row.id,
        space: row.space,
        question: row.question,
        answer: row.answer,
        citations: row.citations,
        answered: row.answered,
        helpful: row.helpful,
        createdAt: new Date(row.created_at).toISOString()
      }))
    };
  }
}

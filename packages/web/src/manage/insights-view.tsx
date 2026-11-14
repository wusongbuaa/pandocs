import * as React from "react";
import clsx from "clsx";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Link } from "@rspress/core/theme";
import { Button } from "@/components/ui/button";
import { Filter } from "../ui/filter";
import { api, failureMessage } from "../api/client";
import { documentRoute } from "../data/paths";
import type { Space } from "../types";
import { toast } from "../ui/toast";
import { formatTime } from "../ui/time";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

interface SearchTerm {
  readonly term: string;
  readonly people: number;
  readonly agents: number;
  readonly empty: number;
}

interface Insights {
  readonly collecting: boolean;
  readonly totals: {
    readonly people: number;
    readonly agents: number;
    readonly searches: number;
    readonly emptySearches: number;
    readonly questions: number;
    readonly unanswered: number;
    readonly helpfulAnswers: number;
    readonly unhelpfulAnswers: number;
    readonly helpful: number;
    readonly unhelpful: number;
  };
  readonly daily: readonly { readonly day: string; readonly people: number; readonly agents: number }[];
  readonly pages: readonly {
    readonly documentId: string;
    readonly space: string;
    readonly path: string;
    readonly title: string;
    readonly people: number;
    readonly agents: number;
    readonly helpful: number;
    readonly unhelpful: number;
    readonly reports: number;
  }[];
  readonly searches: readonly SearchTerm[];
  readonly emptySearches: readonly SearchTerm[];
  readonly questions: readonly {
    readonly id: string;
    readonly question: string;
    readonly answer: string;
    readonly citations: readonly { readonly title: string; readonly url: string }[];
    readonly answered: boolean;
    readonly helpful: boolean | null;
    readonly createdAt: string;
  }[];
}

interface Feedback {
  readonly id: string;
  readonly space: string;
  readonly path: string;
  readonly title: string;
  readonly kind: "helpful" | "unhelpful" | "report";
  readonly audience: "person" | "agent";
  readonly reporter: string | null;
  readonly body: string;
  readonly quote: string;
  readonly createdAt: string;
  readonly resolvedBy: string | null;
}

const PERIODS = [7, 30, 90];
type Section = "pages" | "searches" | "questions" | "feedback";

function Number_({ label, value, note }: { label: string; value: number; note?: string | undefined }) {
  return (
    <div className="pd-insight">
      <span className="pd-insight__value">{value.toLocaleString()}</span>
      <span className="pd-insight__label">{label}</span>
      {note ? <span className="pd-insight__note">{note}</span> : null}
    </div>
  );
}

/** Reading over time: a place for each day of the period, so that where a bar is says when, stacked, with its numbers in its title. Days are UTC, as they are counted. */
function Days({ daily, days }: { daily: Insights["daily"]; days: number }) {
  const known = new Map(daily.map(row => [row.day, row]));
  const period = Array.from({ length: days }, (_, at) => {
    const day = new Date(Date.now() - (days - 1 - at) * 86_400_000).toISOString().slice(0, 10);
    return known.get(day) ?? { day, people: 0, agents: 0 };
  });
  const highest = Math.max(1, ...period.map(row => row.people + row.agents));
  return (
    <figure className="pd-days">
      <div className="pd-days__bars" role="img" aria-label={t("Pages read each day")}>
        {period.map(row => (
          <div
            key={row.day}
            className="pd-days__day"
            title={t("{0}: {1} by people, {2} by agents and tools", row.day, row.people, row.agents)}
          >
            <span className="pd-days__agents" style={{ height: `${(row.agents / highest) * 100}%` }} />
            <span className="pd-days__people" style={{ height: `${(row.people / highest) * 100}%` }} />
          </div>
        ))}
      </div>
      <figcaption>
        <span className="pd-days__key pd-days__key--people" />
        {t("People")}
        <span className="pd-days__key pd-days__key--agents" />
        {t("Agents and tools")}
        <span className="pd-days__range">
          {period[0]!.day} – {period.at(-1)!.day}
        </span>
      </figcaption>
    </figure>
  );
}

function PagesTable({ pages }: { pages: Insights["pages"] }) {
  if (pages.length === 0) return <EmptyState>{t("Nothing has been read in this time.")}</EmptyState>;
  return (
    <table className="pd-table">
      <thead>
        <tr>
          <th>{t("Page")}</th>
          <th className="pd-table__number">{t("People")}</th>
          <th className="pd-table__number">{t("Agents and tools")}</th>
          <th className="pd-table__number">{t("Helpful")}</th>
          <th className="pd-table__number">{t("Not helpful")}</th>
        </tr>
      </thead>
      <tbody>
        {pages.map(page => (
          <tr key={page.documentId}>
            <td>
              <Link href={documentRoute(page.space, page.path)}>{page.title}</Link>
            </td>
            <td className="pd-table__number">{page.people}</td>
            <td className="pd-table__number">{page.agents}</td>
            <td className="pd-table__number">{page.helpful}</td>
            <td className="pd-table__number">{page.unhelpful}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TermsTable({ terms, emptyText }: { terms: readonly SearchTerm[]; emptyText: string }) {
  if (terms.length === 0) return <EmptyState>{emptyText}</EmptyState>;
  return (
    <table className="pd-table">
      <thead>
        <tr>
          <th>{t("Searched for")}</th>
          <th className="pd-table__number">{t("People")}</th>
          <th className="pd-table__number">{t("Agents and tools")}</th>
          <th className="pd-table__number">{t("Found nothing")}</th>
        </tr>
      </thead>
      <tbody>
        {terms.map(row => (
          <tr key={row.term}>
            <td>{row.term}</td>
            <td className="pd-table__number">{row.people}</td>
            <td className="pd-table__number">{row.agents}</td>
            <td className="pd-table__number">{row.empty}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Questions({ questions }: { questions: Insights["questions"] }) {
  if (questions.length === 0) return <EmptyState>{t("Nobody has asked the AI anything in this time.")}</EmptyState>;
  return (
    <ul className="pd-questions">
      {questions.map(row => (
        <li key={row.id}>
          <details>
            <summary>
              <span>{row.question}</span>
              {row.answered ? null : <span className="pd-tag pd-tag--warning">{t("No answer in the pages")}</span>}
              {row.helpful === true ? <ThumbsUp size={14} aria-label={t("This helped")} /> : null}
              {row.helpful === false ? <ThumbsDown size={14} aria-label={t("This did not help")} /> : null}
              <time>{formatTime(row.createdAt)}</time>
            </summary>
            <p className="pd-questions__answer">{row.answer}</p>
            {row.citations.length > 0 ? (
              <p className="pd-questions__sources">
                {row.citations.map((citation, at) => (
                  <React.Fragment key={at}>
                    {at > 0 ? t(", ") : ""}
                    <Link href={citation.url}>{citation.title}</Link>
                  </React.Fragment>
                ))}
              </p>
            ) : null}
          </details>
        </li>
      ))}
    </ul>
  );
}

const KINDS = () => ({ helpful: t("Helpful"), unhelpful: t("Not helpful"), report: t("Reported a problem") });

function FeedbackList({ scope }: { scope: string }) {
  const [status, setStatus] = React.useState<"open" | "resolved">("open");
  const loaded = useLoaded(() => api.get<readonly Feedback[]>(`${scope}feedback?status=${status}`), [scope, status]);
  const settle = async (id: string, resolved: boolean) => {
    try {
      await api.send("POST", `feedback/${id}/resolve`, { body: { resolved } });
      loaded.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const kinds = KINDS();
  return (
    <>
      <div>
        <Filter
          label={t("Filter feedback")}
          value={status}
          items={[
            { value: "open", label: t("To look at") },
            { value: "resolved", label: t("Dealt with") }
          ]}
          onChange={setStatus}
        />
      </div>
      <LoadedContent loaded={loaded}>
        {items =>
          items.length === 0 ? (
            <EmptyState>
              {status === "open"
                ? t("Nothing to look at. Votes without words are counted with the pages.")
                : t("Nothing has been dealt with yet.")}
            </EmptyState>
          ) : (
            <ul className="pd-questions">
              {items.map(item => (
                <li key={item.id} className="pd-feedback">
                  <div className="pd-feedback__head">
                    <Link href={documentRoute(item.space, item.path)}>{item.title}</Link>
                    <span className={clsx("pd-tag", item.kind === "report" && "pd-tag--warning")}>
                      {kinds[item.kind]}
                    </span>
                    <span className="pd-muted">
                      {item.reporter ?? t("A reader")}
                      {item.audience === "agent" ? t(" (agent)") : ""}
                    </span>
                    <time>{formatTime(item.createdAt)}</time>
                  </div>
                  {item.quote ? <blockquote>{item.quote}</blockquote> : null}
                  <p>{item.body}</p>
                  <Button variant="outline" onClick={() => void settle(item.id, status === "open")}>
                    {status === "open" ? t("Mark as dealt with") : t("Open again")}
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </LoadedContent>
    </>
  );
}

/** How the documents are doing: read how much and by what, looked for how, asked what, and what people say about them. */
export function InsightsView({ space }: { space?: Space }) {
  const [days, setDays] = React.useState(30);
  const [section, setSection] = React.useState<Section>("pages");
  const scope = space ? `spaces/${encodeURIComponent(space.slug)}/` : "";
  const loaded = useLoaded(() => api.get<Insights>(`${scope}insights?days=${days}`), [scope, days]);
  const sections: readonly { readonly value: Section; readonly label: string }[] = [
    { value: "pages", label: t("Pages") },
    { value: "searches", label: t("Searches") },
    { value: "questions", label: t("Questions to AI") },
    { value: "feedback", label: t("Feedback") }
  ];
  return (
    <>
      <ManageHead
        title={space ? t("{0}: insights", space.name) : t("Site insights")}
        description={t("Counts only, with nothing about who: no addresses, cookies or names.")}
      >
        <Filter
          label={t("Period")}
          value={days}
          items={PERIODS.map(period => ({ value: period, label: t("{0} days", period) }))}
          onChange={setDays}
        />
      </ManageHead>
      <LoadedContent loaded={loaded}>
        {data => (
          <>
            {data.collecting ? null : (
              <p className="pd-doc-notice">
                {t("This site is set to keep no reading numbers, search terms or questions.")}
              </p>
            )}
            <div className="pd-insights">
              <Number_ label={t("Read by people")} value={data.totals.people} />
              <Number_ label={t("Read by agents and tools")} value={data.totals.agents} />
              <Number_
                label={t("Searches")}
                value={data.totals.searches}
                note={data.totals.emptySearches ? t("{0} found nothing", data.totals.emptySearches) : undefined}
              />
              <Number_
                label={t("Questions to AI")}
                value={data.totals.questions}
                note={data.totals.unanswered ? t("{0} not in the pages", data.totals.unanswered) : undefined}
              />
              <Number_
                label={t("Found a page helpful")}
                value={data.totals.helpful}
                note={data.totals.unhelpful ? t("{0} did not", data.totals.unhelpful) : undefined}
              />
            </div>
            <Days daily={data.daily} days={days} />
            <Filter label={t("What to show")} value={section} items={sections} onChange={setSection} />
            {section === "pages" ? <PagesTable pages={data.pages} /> : null}
            {section === "searches" ? (
              <>
                <h2 className="pd-insights__title">{t("What the documents did not have")}</h2>
                <TermsTable terms={data.emptySearches} emptyText={t("Every search found something.")} />
                <h2 className="pd-insights__title">{t("What is searched for most")}</h2>
                <TermsTable terms={data.searches} emptyText={t("Nobody has searched in this time.")} />
              </>
            ) : null}
            {section === "questions" ? <Questions questions={data.questions} /> : null}
            {section === "feedback" ? <FeedbackList scope={scope} /> : null}
          </>
        )}
      </LoadedContent>
    </>
  );
}

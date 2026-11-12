import * as React from "react";
import { api, failureMessage } from "../api/client";
import type { AskSource } from "./citations";
import { t } from "../i18n";

export interface AskStep {
  readonly kind: "search" | "read" | "list";
  readonly label: string;
}

export interface AskTurn {
  readonly key: number;
  readonly question: string;
  readonly steps: readonly AskStep[];
  readonly text: string;
  /** What the model has been shown so far, by the number it uses. */
  readonly sources: ReadonlyMap<number, { readonly title: string; readonly url: string }>;
  readonly status: "working" | "done" | "failed" | "stopped";
  /** Set once it is done, when the text has final numbers. */
  readonly citations: readonly AskSource[] | null;
  readonly answerId: string | null;
  readonly rating: boolean | null;
  readonly error: string | null;
}

interface AskState {
  readonly open: boolean;
  readonly turns: readonly AskTurn[];
}

const CLOSED: AskState = { open: false, turns: [] };
/** Earlier turns are context for the next, and more of them mostly costs more. */
const HISTORY_TURNS = 3;

let state = CLOSED;
let nextKey = 1;
let running: AbortController | null = null;
const listeners = new Set<() => void>();

const publish = (patch: Partial<AskState>) => {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
};

export function useAsk(): AskState {
  return React.useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => state, () => CLOSED);
}

export const openAsk = () => publish({ open: true });
export const closeAsk = () => publish({ open: false });
export const toggleAsk = () => publish({ open: !state.open });

const updateTurn = (key: number, change: (turn: AskTurn) => AskTurn) => publish({ turns: state.turns.map(turn => (turn.key === key ? change(turn) : turn)) });

type AskEvent =
  | ({ readonly type: "step" } & AskStep)
  | { readonly type: "sources"; readonly sources: readonly AskSource[] }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "restart" }
  | { readonly type: "done"; readonly id: string | null; readonly text: string; readonly citations: readonly AskSource[] }
  | { readonly type: "error"; readonly message: string };

function applyEvent(turn: AskTurn, event: AskEvent): AskTurn {
  switch (event.type) {
    case "step":
      return { ...turn, steps: [...turn.steps, { kind: event.kind, label: event.label }] };
    case "sources":
      return { ...turn, sources: new Map([...turn.sources, ...event.sources.map(({ n, title, url }) => [n, { title, url }] as const)]) };
    case "text":
      return { ...turn, text: turn.text + event.text };
    case "restart":
      return { ...turn, text: "" };
    case "done":
      return { ...turn, text: event.text, citations: event.citations, answerId: event.id, status: "done" };
    case "error":
      return { ...turn, status: "failed", error: event.message };
  }
}

export const isAsking = (turns: readonly AskTurn[]) => turns.some(turn => turn.status === "working");

export async function ask(question: string, context: { readonly space?: string | undefined; readonly document?: string | undefined; readonly lang?: string | undefined }): Promise<void> {
  const key = nextKey;
  nextKey += 1;
  const history = state.turns.filter(turn => turn.status === "done").slice(-HISTORY_TURNS).map(turn => ({ question: turn.question, answer: turn.text }));
  publish({ turns: [...state.turns, { key, question, steps: [], text: "", sources: new Map(), status: "working", citations: null, answerId: null, rating: null, error: null }] });
  const controller = new AbortController();
  running = controller;
  try {
    await api.stream("ask", { question, ...context, history }, event => updateTurn(key, turn => applyEvent(turn, event as AskEvent)), controller.signal);
    // A connection that ended without saying how it went.
    updateTurn(key, turn => (turn.status === "working" ? { ...turn, status: "failed", error: t("The answer was cut off. Try again.") } : turn));
  } catch (error) {
    updateTurn(key, turn => (controller.signal.aborted ? { ...turn, status: "stopped" } : { ...turn, status: "failed", error: failureMessage(error) }));
  } finally {
    if (running === controller) running = null;
  }
}

export const stopAsking = () => running?.abort();

export function clearConversation(): void {
  running?.abort();
  publish({ turns: [] });
}

export function rateAnswer(key: number, answerId: string, helpful: boolean): void {
  updateTurn(key, turn => ({ ...turn, rating: helpful }));
  void api.send("POST", `ask/${answerId}/rating`, { body: { helpful } }).catch(() => undefined);
}

import type { LucideIcon } from "lucide-react";
import type { PandocsPage } from "../data/pages";
import type { CapturedSelection } from "../reader/text-map";

/**
 * The extension points the theme does not have itself. Everything else, such as a slot before the
 * sidebar or after the footer, is one of the theme's own Layout props in src/theme/index.tsx.
 */

export interface SelectionContext {
  readonly page: PandocsPage;
  readonly selection: CapturedSelection;
  readonly range: Range;
  /** Drops the browser selection, which also closes the toolbar. */
  clear(): void;
}

export interface SelectionAction {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** `label` keeps its text on the toolbar, `icon` shows only the icon, `more` goes into the overflow menu. */
  readonly display: "label" | "icon" | "more";
  /** Actions with the same group sit together between separators. */
  readonly group: number;
  available?(context: SelectionContext): boolean;
  run?(context: SelectionContext): void;
  /** Instead of `run`: opens a menu of these. */
  readonly items?: readonly {
    readonly id: string;
    readonly label: string;
    readonly hint?: string;
    run(context: SelectionContext): void;
  }[];
}

export const selectionActions: SelectionAction[] = [];

/** Later registrations with the same id replace earlier ones, so a host can change a built-in. */
export function registerSelectionAction(action: SelectionAction): void {
  const at = selectionActions.findIndex(item => item.id === action.id);
  if (at >= 0) selectionActions[at] = action;
  else selectionActions.push(action);
}

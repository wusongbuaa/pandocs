import { t } from "@pandocs/i18n";
import { z } from "zod";
import { invalid, notFound } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import { audit, requireSpace, UUID, type AppContext } from "./context.js";

const BUILT_IN_PREFIX = "builtin:";

export const templateInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  markdown: z.string().max(200_000)
}).strict();

export interface PageTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  /** Comes with the product, for every space, and cannot be changed. */
  readonly builtIn: boolean;
}

/** Text a template can leave to be filled in when a page is made from it. */
const fill = (markdown: string, title: string) => markdown.replaceAll("{{title}}", title).replaceAll("{{date}}", new Date().toISOString().slice(0, 10));

const builtIns = (): readonly PageTemplate[] => [
  {
    id: `${BUILT_IN_PREFIX}meeting`,
    name: t("Meeting notes"),
    description: t("Who was there, what was decided, and who does what next."),
    markdown: t("**Date:** {{date}}\n\n**Attendees:**\n\n## Agenda\n\n- \n\n## Decisions\n\n- \n\n## Next steps\n\n- [ ] "),
    builtIn: true
  },
  {
    id: `${BUILT_IN_PREFIX}how-to`,
    name: t("How-to guide"),
    description: t("Steps for getting one thing done."),
    markdown: t("What this helps you do, and when you need it.\n\n## Before you start\n\n- \n\n## Steps\n\n1. \n2. \n\n## Check that it worked\n\n"),
    builtIn: true
  },
  {
    id: `${BUILT_IN_PREFIX}troubleshooting`,
    name: t("Troubleshooting"),
    description: t("What goes wrong, why, and how to fix it."),
    markdown: t("## What you see\n\n\n\n## Why it happens\n\n\n\n## How to fix it\n\n1. \n\n## If that does not help\n\n"),
    builtIn: true
  },
  {
    id: `${BUILT_IN_PREFIX}decision`,
    name: t("Decision record"),
    description: t("What was decided and why, for whoever asks later."),
    markdown: t("**Date:** {{date}}\n\n## Context\n\nWhat made this worth deciding.\n\n## Options\n\n- \n\n## Decision\n\n\n\n## What follows from it\n\n"),
    builtIn: true
  }
];

function mapTemplate(row: Record<string, unknown>): PageTemplate {
  return { id: String(row.id), name: String(row.name), description: String(row.description), markdown: String(row.markdown), builtIn: false };
}

/** Pages to start from, for a space's editors: their own, and a few that come with the product. */
export class TemplateService {
  constructor(private readonly context: AppContext) {}

  async list(principal: Principal, spaceSlug: string): Promise<readonly PageTemplate[]> {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "editor");
    const { rows } = await db.query(`SELECT * FROM pandocs.page_templates WHERE space_id = $1 ORDER BY lower(name)`, [space.id]);
    return [...rows.map(mapTemplate), ...builtIns()];
  }

  async create(principal: Principal, spaceSlug: string, input: z.output<typeof templateInput>): Promise<PageTemplate> {
    return this.context.db.transaction(async tx => {
      const { space } = await requireSpace(tx, principal, spaceSlug, "editor");
      const { rows } = await tx.query(
        `INSERT INTO pandocs.page_templates (space_id, name, description, markdown, created_name) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [space.id, input.name, input.description ?? "", input.markdown, principal.displayName]
      );
      await audit(tx, principal, "space.template.create", "space", space.id, { name: input.name });
      return mapTemplate(rows[0]!);
    });
  }

  /** Editors of the space it belongs to, which is all that can see it. */
  private async ownedSpace(db: Queryable, principal: Principal, id: string): Promise<{ spaceId: string; name: string }> {
    if (!UUID.test(id)) throw notFound(t("Template"));
    const { rows } = await db.query<{ slug: string; space_id: string; name: string }>(
      `SELECT s.slug, p.space_id, p.name FROM pandocs.page_templates p JOIN pandocs.spaces s ON s.id = p.space_id AND s.deleted_at IS NULL WHERE p.id = $1 FOR UPDATE OF p`,
      [id]
    );
    if (!rows[0]) throw notFound(t("Template"));
    await requireSpace(db, principal, rows[0].slug, "editor");
    return { spaceId: rows[0].space_id, name: rows[0].name };
  }

  async update(principal: Principal, id: string, input: { name?: string | undefined; description?: string | undefined; markdown?: string | undefined }): Promise<PageTemplate> {
    return this.context.db.transaction(async tx => {
      const { spaceId, name } = await this.ownedSpace(tx, principal, id);
      const { rows } = await tx.query(
        `UPDATE pandocs.page_templates SET name = COALESCE($2, name), description = COALESCE($3, description), markdown = COALESCE($4, markdown), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, input.name ?? null, input.description ?? null, input.markdown ?? null]
      );
      await audit(tx, principal, "space.template.update", "space", spaceId, { name: input.name ?? name });
      return mapTemplate(rows[0]!);
    });
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.context.db.transaction(async tx => {
      const { spaceId, name } = await this.ownedSpace(tx, principal, id);
      await tx.query(`DELETE FROM pandocs.page_templates WHERE id = $1`, [id]);
      await audit(tx, principal, "space.template.delete", "space", spaceId, { name });
    });
  }

  /** What a new page starts with, from a template of its space. */
  async contentFor(principal: Principal, spaceSlug: string, id: string, title: string): Promise<string> {
    const found = (await this.list(principal, spaceSlug)).find(template => template.id === id);
    if (!found) throw invalid("TEMPLATE_UNKNOWN", t("This space has no such template"));
    return fill(found.markdown, title);
  }
}

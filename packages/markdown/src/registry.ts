import { t } from "@pandocs/i18n";
import { z } from "zod";

export type BlockKind = "container" | "leaf" | "inline" | "fence";

/**
 * Pure data shared by the server, the editor and agents. Rendering lives in `@pandocs/web`, so
 * server and CLI paths never load React, and adding a block never touches the parsers.
 */
export interface BlockDefinition {
  readonly name: string;
  readonly kind: BlockKind;
  readonly summary: string;
  readonly example: string;
  readonly attrs: z.ZodObject;
  /** `false` when the block renders something other than its source, such as a diagram. */
  readonly visibleText?: false;
  /** `false` when the block shows its `[label]` away from where it is written, as a tab does, so offsets cannot count it. */
  readonly labelText?: false;
  /** Attributes holding links to other pages, which a move rewrites like any other relative link. */
  readonly linkAttrs?: readonly string[];
  readonly parseBody?: (body: string) => unknown;
}

export interface BlockRegistry {
  get(name: string): BlockDefinition | undefined;
  list(): readonly BlockDefinition[];
}

export function createBlockRegistry(definitions: readonly BlockDefinition[]): BlockRegistry {
  const byName = new Map<string, BlockDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) throw new Error(t("Block {0} is registered twice", definition.name));
    byName.set(definition.name, definition);
  }
  return { get: name => byName.get(name), list: () => [...byName.values()] };
}

export const CALLOUT_TONES = ["note", "tip", "info", "important", "warning", "caution", "danger"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

/** GitHub Alerts degrade to a blockquote anywhere, so third-party and agent content often uses them. */
export const ALERT_BLOCKS: Readonly<Record<string, CalloutTone>> = {
  NOTE: "note",
  TIP: "tip",
  IMPORTANT: "important",
  WARNING: "warning",
  CAUTION: "caution"
};

const calloutAttrs = z.object({
  emoji: z.string().max(16).optional(),
  title: z.string().max(200).optional(),
  tone: z.enum(CALLOUT_TONES).optional()
}).strict();

const toneBlocks: readonly BlockDefinition[] = CALLOUT_TONES.map(name => ({
  name,
  kind: "container",
  summary: `${name} callout`,
  example: `:::${name}[Title]\n\nContent\n\n:::`,
  attrs: calloutAttrs
}));

const chartBody = z.object({
  type: z.enum(["bar", "line", "area", "pie"]),
  xKey: z.string().min(1),
  yKeys: z.array(z.string().min(1)).min(1).optional(),
  data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).max(1000)
}).strict();
export type ChartBody = z.infer<typeof chartBody>;

export const MAX_HOTSPOTS = 50;

const hotspotsBody = z.array(z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  title: z.string().max(200),
  text: z.string().max(2000).optional()
}).strict()).max(MAX_HOTSPOTS);
export type HotspotsBody = z.infer<typeof hotspotsBody>;

export const builtinBlocks: readonly BlockDefinition[] = [
  ...toneBlocks,
  {
    name: "callout",
    kind: "container",
    summary: "Callout with a custom emoji",
    example: `:::callout{emoji="💡"}\n\nContent\n\n:::`,
    attrs: calloutAttrs
  },
  {
    name: "details",
    kind: "container",
    summary: "Collapsible section",
    example: ":::details[Show more]\n\nContent\n\n:::",
    attrs: calloutAttrs
  },
  {
    name: "columns",
    kind: "container",
    summary: "Columns, holding column blocks",
    example: `::::columns\n\n:::column{width="0.5"}\n\nLeft\n\n:::\n\n:::column{width="0.5"}\n\nRight\n\n:::\n\n::::`,
    attrs: z.object({}).strict()
  },
  {
    name: "column",
    kind: "container",
    summary: "One column, inside columns",
    example: `:::column{width="0.5"}\n\nContent\n\n:::`,
    attrs: z.object({
      width: z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u, { error: () => t("width must be a decimal between 0 and 1") }).optional()
    }).strict()
  },
  {
    name: "steps",
    kind: "container",
    summary: "Steps, with each heading a step",
    example: ":::steps\n\n### First step\n\nContent\n\n### Second step\n\nContent\n\n:::",
    attrs: z.object({}).strict()
  },
  {
    name: "tabs",
    kind: "container",
    summary: "Tabs, holding tab blocks. Tabs with the same group switch together.",
    example: "::::tabs\n\n:::tab[macOS]\n\nContent\n\n:::\n\n:::tab[Windows]\n\nContent\n\n:::\n\n::::",
    attrs: z.object({ group: z.string().max(64).optional() }).strict()
  },
  {
    name: "tab",
    kind: "container",
    summary: "One tab, inside tabs",
    example: ":::tab[Title]\n\nContent\n\n:::",
    attrs: z.object({}).strict(),
    labelText: false
  },
  {
    name: "cards",
    kind: "container",
    summary: "Cards, holding card blocks",
    example: `::::cards\n\n:::card[Quick start]{href="./start.md"}\n\nA first project in five minutes\n\n:::\n\n:::card[FAQ]{href="./faq.md"}\n\nLook here first when something goes wrong\n\n:::\n\n::::`,
    attrs: z.object({}).strict()
  },
  {
    name: "card",
    kind: "container",
    summary: "One card, inside cards, which can link to another page",
    example: `:::card[Title]{href="./page.md"}\n\nDescription\n\n:::`,
    attrs: z.object({ href: z.string().optional() }).strict(),
    linkAttrs: ["href"]
  },
  {
    name: "compare",
    kind: "leaf",
    summary: "Before and after, dragging a divider to compare two images",
    example: "::compare[The redesign]{before=\"assets/old.png\" after=\"assets/new.png\" beforeLabel=\"Before\" afterLabel=\"After\"}",
    attrs: z.object({
      before: z.string().min(1),
      after: z.string().min(1),
      beforeLabel: z.string().max(40).optional(),
      afterLabel: z.string().max(40).optional()
    }).strict()
  },
  {
    name: "video",
    kind: "leaf",
    summary: "Video",
    example: "::video[Product demo]{src=\"assets/demo.mp4\"}",
    attrs: z.object({ src: z.string().min(1), poster: z.string().optional() }).strict()
  },
  {
    name: "file",
    kind: "leaf",
    summary: "The original file, placed first on a page converted from it",
    example: "::file[Quarterly report.pdf]{src=\"assets/report.pdf\"}",
    attrs: z.object({ src: z.string().min(1) }).strict()
  },
  {
    name: "openapi",
    kind: "leaf",
    summary: "An API reference, from an OpenAPI document stored here",
    example: "::openapi{src=\"assets/api.yaml\"}",
    attrs: z.object({
      src: z.string().regex(/^(?:assets\/|\/)/u, { error: () => t("An OpenAPI document has to be uploaded here, or be an address on this site") })
    }).strict()
  },
  {
    name: "subpages",
    kind: "leaf",
    summary: "Lists a page's subpages by itself",
    example: "::subpages",
    attrs: z.object({}).strict()
  },
  {
    name: "tag",
    kind: "inline",
    summary: "Inline tag",
    example: ":tag[Done]{tone=\"tip\"}",
    attrs: z.object({ tone: z.enum(CALLOUT_TONES).optional() }).strict()
  },
  {
    name: "prompt",
    kind: "fence",
    summary: "A prompt to copy with one click, shown and copied exactly as written",
    example: "```prompt title=\"Find the error\" description=\"Paste this to your Agent\"\nRead the error log, find the cause, then tell me how to fix it.\n```",
    attrs: z.object({ title: z.string().max(200).optional(), description: z.string().max(400).optional() }).strict()
  },
  {
    name: "hotspots",
    kind: "fence",
    summary: "Notes on a screenshot, with x and y as percentages of its width and height",
    example: "```hotspots src=\"assets/screen.png\" alt=\"The console\"\n[{\"x\":20,\"y\":30,\"title\":\"Entry\",\"text\":\"Start here\"}]\n```",
    attrs: z.object({ src: z.string().min(1), alt: z.string().optional() }).strict(),
    visibleText: false,
    parseBody: body => hotspotsBody.parse(JSON.parse(body))
  },
  {
    name: "mindmap",
    kind: "fence",
    summary: "A mind map, with headings and lists for its levels",
    example: "```mindmap\n# Central topic\n\n- Branch one\n  - A point\n- Branch two\n```",
    attrs: z.object({ title: z.string().optional() }).strict(),
    visibleText: false
  },
  {
    name: "mermaid",
    kind: "fence",
    summary: "Mermaid diagram",
    example: "```mermaid\nflowchart LR\n  A --> B\n```",
    attrs: z.object({ title: z.string().optional() }).strict(),
    visibleText: false
  },
  {
    name: "tree",
    kind: "fence",
    summary: "File tree",
    example: "```tree\nsrc\n├── index.ts\n└── pages\n    └── home.tsx  # Front page\n```",
    attrs: z.object({ title: z.string().optional() }).strict(),
    visibleText: false
  },
  {
    name: "chart",
    kind: "fence",
    summary: "A chart described in JSON",
    example: "```chart title=\"Sales\"\n{\"type\":\"bar\",\"xKey\":\"Month\",\"data\":[{\"Month\":\"January\",\"Sales\":10}]}\n```",
    attrs: z.object({ title: z.string().optional() }).strict(),
    visibleText: false,
    parseBody: body => chartBody.parse(JSON.parse(body))
  }
];

export const defaultBlockRegistry: BlockRegistry = createBlockRegistry(builtinBlocks);

/** JSON Schema form of the catalog, so agents learn how to write blocks from the API. */
export function describeBlocks(registry: BlockRegistry = defaultBlockRegistry) {
  return registry.list().map(block => ({
    name: block.name,
    kind: block.kind,
    summary: block.summary,
    example: block.example,
    attributes: z.toJSONSchema(block.attrs, { io: "input" })
  }));
}

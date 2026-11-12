export type ImageAlign = "left" | "center" | "right";

export interface ImageLayout {
  readonly title: string;
  readonly align?: ImageAlign;
  readonly width?: number;
}

const ALIGN = /(?:^|\s)align=(left|center|right)(?=\s|$)/u;
const WIDTH = /(?:^|\s)width=(\d{1,4})(?=\s|$)/u;

/** `![图](a.png "示意图 align=center width=320")`: what remains after the settings is the image's own title. */
export function parseImageTitle(raw: string): ImageLayout {
  const align = ALIGN.exec(raw)?.[1] as ImageAlign | undefined;
  const width = WIDTH.exec(raw)?.[1];
  const title = raw.replace(ALIGN, "").replace(WIDTH, "").trim();
  return { title, ...(align ? { align } : {}), ...(width ? { width: Number(width) } : {}) };
}

export function formatImageTitle({ title, align, width }: ImageLayout): string | null {
  return [title, ...(align ? [`align=${align}`] : []), ...(width ? [`width=${width}`] : [])].filter(Boolean).join(" ") || null;
}

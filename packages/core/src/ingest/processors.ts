import type { Processor } from "../ports.js";

const normalize: Processor = {
  name: "normalize",
  async run(input) {
    const text = input.markdown ?? new TextDecoder("utf-8").decode(input.bytes ?? new Uint8Array());
    const markdown = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "").trimEnd();
    return { markdown: markdown ? `${markdown}\n` : "" };
  }
};

export const builtinProcessors: readonly Processor[] = [normalize];

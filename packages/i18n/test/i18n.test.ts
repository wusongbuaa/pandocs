import { afterEach, describe, expect, it } from "vitest";
import {
  addMessages,
  currentLanguage,
  DEFAULT_LANGUAGE,
  inLanguage,
  pickLanguage,
  setLanguageScope,
  t,
  type Language
} from "../src/index.js";

const inLanguageFixed = (language: Language) =>
  setLanguageScope({ current: () => language, run: (_language, work) => work() });

afterEach(() => inLanguageFixed(DEFAULT_LANGUAGE));

describe("text", () => {
  it("is the English itself until a language has a translation", () => {
    expect(t("Saved")).toBe("Saved");
    inLanguageFixed("zh");
    expect(t("Saved but not translated")).toBe("Saved but not translated");
    addMessages("zh", { Saved: "已保存" });
    expect(t("Saved")).toBe("已保存");
    inLanguageFixed("en");
    expect(t("Saved")).toBe("Saved");
  });

  it("fills in arguments, in whatever order a translation wants them", () => {
    addMessages("zh", { "{0} replied to {1}": "{1} 收到 {0} 的回复" });
    expect(t("{0} replied to {1}", "Ana", "Ben")).toBe("Ana replied to Ben");
    inLanguageFixed("zh");
    expect(t("{0} replied to {1}", "Ana", "Ben")).toBe("Ben 收到 Ana 的回复");
  });

  it("does not look again inside what it filled in", () => {
    expect(t("Use {0} and {1}", "{1}", "{url}")).toBe("Use {1} and {url}");
  });

  it("leaves braces alone that are not arguments", () => {
    expect(t("\\text{Formula} {url}")).toBe("\\text{Formula} {url}");
  });

  it("picks the word for a count", () => {
    const moved = (count: number) => t("Moved {0} {0|page|pages}", count);
    expect(moved(1)).toBe("Moved 1 page");
    expect(moved(0)).toBe("Moved 0 pages");
    expect(moved(12)).toBe("Moved 12 pages");
  });

  it("is not confused by the names of an object's built-in properties", () => {
    inLanguageFixed("zh");
    expect(t("constructor")).toBe("constructor");
  });
});

describe("a language in a scope", () => {
  it("does nothing until something provides a scope", () => {
    expect(inLanguage("zh", () => currentLanguage())).toBe(DEFAULT_LANGUAGE);
  });
});

describe("what a browser asks for", () => {
  it.each([
    ["zh-CN,zh;q=0.9,en;q=0.8", "zh"],
    ["en-US,en;q=0.9,zh-CN;q=0.8", "en"],
    ["zh-TW", "zh"],
    ["fr-FR,de;q=0.9", "en"],
    ["fr,zh;q=0.5,en;q=0.3", "zh"],
    ["en;q=0.3,zh;q=0.7", "zh"],
    ["zh;q=0,en", "en"],
    ["en-GB,zh", "en"],
    ["", "en"],
    [null, "en"],
    [undefined, "en"],
    ["*", "en"]
  ])("%s gets %s", (accepted, language) => {
    expect(pickLanguage(accepted)).toBe(language);
  });
});

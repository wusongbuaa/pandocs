// These tests read the app's Chinese, which checks the dictionary along with everything else. language.test.tsx reads the English.
for (const [name, value] of Object.entries({ language: "zh-CN", languages: ["zh-CN"] })) {
  Object.defineProperty(navigator, name, { configurable: true, value });
}

const { loadMessages } = await import("../src/i18n");
await loadMessages();

export {};

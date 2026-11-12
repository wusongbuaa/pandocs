import { createHash } from "node:crypto";

/**
 * How signing in looks wherever it happens: the pages here, and the app's dialog, which loads this as `/sign-in.css`.
 * It uses the theme's variables, so inside the app it follows the theme, light or dark, and a page here sets them itself.
 */
export const SIGN_IN_STYLE = `
.pd-sign-in {
  --pd-sign-in-paper: var(--rp-c-bg);
  --pd-sign-in-danger: #d42b3d;
  --pd-sign-in-logo-rim: none;
  position: relative;
  box-sizing: border-box;
  width: 100%;
  max-width: 400px;
  padding: 32px 32px 28px;
  color: var(--rp-c-text-1);
  font-family: var(--rp-font-family-base);
  font-size: 15px;
  line-height: 1.6;
  text-align: left;
  background: var(--pd-sign-in-paper);
  border: 1px solid var(--rp-c-divider-light);
  border-radius: 16px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 24px 48px -28px rgba(0, 0, 0, 0.28);
}
/* The panda is drawn in dark ink, which a dark page swallows without a light rim round it. */
html.rp-dark .pd-sign-in { --pd-sign-in-paper: #1c1c20; --pd-sign-in-danger: #ff7a85; --pd-sign-in-logo-rim: drop-shadow(0 0 1px rgba(255, 255, 245, 0.7)); }
.pd-sign-in *, .pd-sign-in *::before, .pd-sign-in *::after { box-sizing: border-box; }

/* The logo sits on the top edge, the way the panda in Pandocs' own sits on its book: the one thing here that is not plain. */
.pd-sign-in__logo { position: absolute; top: -50px; left: 50%; width: 64px; height: 64px; margin: 0 0 0 -32px; }
.pd-sign-in__logo img { display: block; width: 100%; height: 100%; object-fit: contain; filter: var(--pd-sign-in-logo-rim); }

.pd-sign-in__title { margin: 8px 0 0; font-size: 22px; font-weight: 600; line-height: 1.35; text-align: center; text-wrap: balance; }
.pd-sign-in__lead { margin: 6px 0 0; color: var(--rp-c-text-2); font-size: 14px; text-align: center; text-wrap: balance; }
.pd-sign-in__text { margin: 16px 0 0; color: var(--rp-c-text-2); font-size: 14px; }
.pd-sign-in__text strong { color: var(--rp-c-text-1); font-weight: 500; }
.pd-sign-in__list { margin: 12px 0 0; padding-left: 20px; font-size: 14px; }
.pd-sign-in__list li + li { margin-top: 4px; }
.pd-sign-in__code { font-family: var(--rp-font-family-mono); font-size: 13px; word-break: break-all; }
.pd-sign-in__problem { margin: 20px 0 0; padding: 10px 12px; color: var(--pd-sign-in-danger); font-size: 14px; background: color-mix(in srgb, var(--pd-sign-in-danger) 9%, transparent); border-radius: 10px; }

.pd-sign-in__providers { display: flex; flex-direction: column; gap: 8px; margin-top: 24px; }
.pd-sign-in__or { display: flex; align-items: center; gap: 12px; margin: 20px 0 0; color: var(--rp-c-text-2); font-size: 13px; }
.pd-sign-in__or::before, .pd-sign-in__or::after { flex: 1; border-top: 1px solid var(--rp-c-divider-light); content: ""; }

.pd-sign-in__form { display: flex; flex-direction: column; gap: 16px; margin: 24px 0 0; }
.pd-sign-in__field { display: flex; flex-direction: column; gap: 6px; }
.pd-sign-in__label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.pd-sign-in__label { font-size: 14px; font-weight: 500; }
.pd-sign-in__input {
  width: 100%;
  height: 40px;
  margin: 0;
  padding: 0 12px;
  color: var(--rp-c-text-1);
  font: inherit;
  background: var(--rp-c-bg);
  border: 1px solid var(--rp-c-divider);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.pd-sign-in__input:focus { border-color: var(--rp-c-brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rp-c-brand) 24%, transparent); }
.pd-sign-in__input[aria-invalid="true"] { border-color: var(--pd-sign-in-danger); }
.pd-sign-in__field-problem { margin: 0; color: var(--pd-sign-in-danger); font-size: 13px; }

.pd-sign-in__submit, .pd-sign-in__provider, .pd-sign-in__secondary {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 40px;
  margin: 0;
  padding: 0 16px;
  font: inherit;
  font-weight: 500;
  text-decoration: none;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}
.pd-sign-in__submit { margin-top: 4px; color: #fff; font-weight: 600; background: var(--rp-c-brand); border: 1px solid transparent; }
.pd-sign-in__submit:hover { background: var(--rp-c-brand-dark); }
.pd-sign-in__submit:disabled { cursor: default; opacity: 0.7; }
.pd-sign-in__provider, .pd-sign-in__secondary { color: var(--rp-c-text-1); background: transparent; border: 1px solid var(--rp-c-divider); }
.pd-sign-in__provider:hover, .pd-sign-in__secondary:hover { background: var(--rp-c-bg-mute); }
.pd-sign-in__actions { display: flex; gap: 10px; margin-top: 24px; }
.pd-sign-in__actions > * { flex: 1; margin: 0; }

.pd-sign-in__aside { color: var(--rp-c-text-2); font-size: 13px; text-decoration: none; }
.pd-sign-in__note { margin: 20px 0 0; color: var(--rp-c-text-2); font-size: 13px; text-align: center; }
.pd-sign-in__note a, .pd-sign-in__aside:hover { color: var(--rp-c-brand); text-decoration: underline; text-underline-offset: 3px; }
.pd-sign-in__close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--rp-c-text-2);
  background: none;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.pd-sign-in__close:hover { color: var(--rp-c-text-1); background: var(--rp-c-bg-mute); }

.pd-sign-in :is(a, button, .pd-sign-in__close):focus-visible { outline: 2px solid var(--rp-c-brand); outline-offset: 2px; }
@media (max-width: 480px) {
  .pd-sign-in { padding: 32px 20px 24px; border-radius: 14px; }
  /* Below 16 pixels a phone zooms into the field. */
  .pd-sign-in__input { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .pd-sign-in * { transition: none; }
}
`;

/**
 * What a page of its own adds: the theme's variables, which only the app's pages otherwise have, and room above the
 * card for the logo. The values are the theme's, from its `base-vars.css`, except that a dark page stays plain black
 * behind the card where the theme would use its slate.
 */
export const SIGN_IN_PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --rp-c-bg: #ffffff;
  --rp-c-bg-soft: #f8f8f9;
  --rp-c-bg-mute: #f1f1f1;
  --rp-c-text-1: #242424;
  --rp-c-text-2: rgba(0, 0, 0, 0.7);
  --rp-c-divider: rgba(0, 0, 0, 0.25);
  --rp-c-divider-light: rgba(0, 0, 0, 0.12);
  --rp-font-family-base: 'Inter var experimental', 'Inter var', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
  --rp-font-family-mono: Menlo, Monaco, Consolas, 'Courier New', monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --rp-c-bg: #121212;
    --rp-c-bg-soft: #121212;
    --rp-c-bg-mute: #343a46;
    --rp-c-text-1: rgba(255, 255, 245, 0.93);
    --rp-c-text-2: rgba(255, 255, 245, 0.65);
    --rp-c-divider: rgba(84, 84, 84, 0.65);
    --rp-c-divider-light: rgba(84, 84, 84, 0.48);
  }
  :root .pd-sign-in { --pd-sign-in-paper: #1c1c20; --pd-sign-in-danger: #ff7a85; --pd-sign-in-logo-rim: drop-shadow(0 0 1px rgba(255, 255, 245, 0.7)); }
}
body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0;
  padding: 72px 16px 32px;
  font-family: var(--rp-font-family-base);
  background: var(--rp-c-bg-soft);
  -webkit-font-smoothing: antialiased;
}
`;

/** The app asks for the stylesheet each time, and gets "not changed" while this is the same. */
export const SIGN_IN_STYLE_TAG = `"${createHash("sha256").update(SIGN_IN_STYLE).digest("base64url").slice(0, 16)}"`;

# Comparing with the official theme

`@pandocs/web` aims to look the same as official Rspress. This runs the same Markdown through a real Rspress build and through this app, and compares them pixel by pixel.

```bash
node packages/web/parity/run.mjs
```

The script installs `@rspress/core` and the comparison tools in `parity/.work`, which is ignored, so they stay out of the repository's dependencies. It needs Chrome on the machine, and `PARITY_BROWSER_CHANNEL` picks another browser channel.

- **Range**: the pages in `fixtures/`, at widths of 1440, 1024 and 390, light and dark. The pages have to be the same height, and differ by no more than 0.2%.
- **It compares the theme alone**, without the toolbars and account menu this app adds. The "last updated" times differ, so they are hidden. `src/styles/density.css`, the one place the reading pages depart from the theme on purpose, is left out, so anything else that departs from it still shows up.
- Screenshots and diffs are in `parity/.work/shots`.
- The pages are in Chinese on purpose, since that is where the typography has most to get wrong, so the browser is set to Chinese too.

Run it after upgrading `vendor/rspress`, or changing the Markdown pipeline or global styles. It needs the network and a browser, so it is not part of the usual tests.

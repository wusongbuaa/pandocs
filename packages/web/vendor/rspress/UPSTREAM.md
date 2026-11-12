# 上游来源

这个目录是 [Rspress](https://github.com/web-infra-dev/rspress) 的原样副本，只去掉了测试和服务端渲染入口。

- 版本：v2.1.0，commit `e079a46`
- 许可证：MIT（见 `LICENSE`）

| 这里 | 上游 |
| --- | --- |
| `theme/` | `packages/core/src/theme` |
| `runtime/` | `packages/core/src/runtime`，去掉 `ssr*`、`createServerRouter.ts`、`csrClientEntry.tsx` |
| `node/mdx/rehypePlugins/` | `packages/core/src/node/mdx/rehypePlugins` 里的 `headerAnchor`、`codeMeta`、`shiki`、`transformers` |
| `node/runtimeModule/i18n/DEFAULT_I18N_TEXT.ts` | 同路径 |
| `node/utils/getSocialIcons.ts`、`error.ts` | 同路径 |
| `shiki-transformers.ts` | `packages/core/src/shiki-transformers.ts` |
| `static/MediumZoom.*` | `packages/core/static/MediumZoom.*` |

## 规则

不改这里的文件。外观因此和官方一致，升级时也只需要整体替换。扩展都放在 `src/`：

- 数据：`src/virtual/` 替换构建时注入的虚拟模块。
- 界面：`src/theme/index.tsx` 用官方的主题覆盖方式，重新导出主题再覆盖 `Layout` 等组件。

确实需要改时，把文件和原因记在下面，并更新 `test/vendor-integrity.test.ts` 里的清单。

## 已改动的文件

无。

## 升级

1. 用新版本的文件替换这个目录，更新上面的 commit。
2. 运行 `pnpm exec vitest run --project web -u` 更新校验清单，确认差异都来自上游。
3. 运行 `packages/web/parity/README.md` 里的像素比对。

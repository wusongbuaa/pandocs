interface ImportMeta {
  readonly webpackHot?: { accept(path: string, callback: () => void): void };
}

declare module "*/standalone.js?url" {
  const url: string;
  export default url;
}

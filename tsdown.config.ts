import { defineConfig } from "tsdown";

const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-settings-plugins/client",
] as const;

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: true,
    clean: true,
  },
  {
    name: "dsh-pseudo-vision/client",
    entry: { client: "src/client/index.tsx" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    target: "es2024",
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id: string) =>
        CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number])
          ? undefined
          : true,
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner:
        'window.__ModuleLoader__.load({ id: "dsh-pseudo-vision", factory: (require) => {',
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
]);
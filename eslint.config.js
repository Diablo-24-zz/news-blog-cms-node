const eslint = require("@eslint/js");

module.exports = [
  {
    ignores: ["node_modules/**", "coverage/**", "public/**/*.min.js"],
  },
  eslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        Headers: "readonly",
        FormData: "readonly",
        URLSearchParams: "readonly",
        navigator: "readonly",
      },
    },
    rules: {
      curly: ["error", "multi-line"],
      eqeqeq: ["error", "always"],
      "no-console": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
    },
  },
];

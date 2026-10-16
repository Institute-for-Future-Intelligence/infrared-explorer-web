module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended'],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
  overrides: [
    {
      // Shared verbatim with the app (src/lib/frameSelection.ts), whose lint has no-bitwise on: the
      // file carries that rule's disable directive, and the rule is on here too so the directive is
      // used rather than reported as unused. Keep the two copies byte-identical.
      // The copies under src/labProjects/core/ of the app's frameSelection.ts and sandboxPage.ts carry
      // the same directive.
      files: ['functions/src/frameSelection.ts', 'src/labProjects/core/frameSelection.ts', 'src/labProjects/core/sandboxPage.ts'],
      rules: { 'no-bitwise': 'warn' },
    },
    {
      // Verbatim copies of the app repository's src/lib/labProjects/* (scripts/sync-lab-core.mjs; see
      // src/labProjects/core/SOURCE.md). Its planEditor.ts reads a no-break space by the character
      // itself; the copies are not edited here, so the rule that would flag it is off for them.
      files: ['src/labProjects/core/*.ts'],
      rules: { 'no-irregular-whitespace': 'off' },
    },
  ],
};

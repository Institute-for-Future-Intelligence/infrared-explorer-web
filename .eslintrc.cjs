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
      files: ['functions/src/frameSelection.ts'],
      rules: { 'no-bitwise': 'warn' },
    },
  ],
};

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'main.js', 'main.js.map', 'polyfills/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    files: ['**/*.{ts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    plugins: {
      'no-only-tests': noOnlyTests,
      'simple-import-sort': simpleImportSort
    },
    rules: {
      'no-only-tests/no-only-tests': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error'
    }
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: ['tsconfig.json', 'tsconfig.spec.json']
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'arrow-body-style': 'error',
      'arrow-parens': 'off',
      'comma-dangle': 'off',
      'constructor-super': 'error',
      curly: 'error',
      eqeqeq: ['error', 'always'],
      'guard-for-in': 'error',
      'id-blacklist': 'off',
      'id-match': 'off',
      'linebreak-style': 'off',
      'max-len': [
        'error',
        {
          // Ignore long import and export lines; Prettier will handle formatting
          ignorePattern: '^import [^,]+ from |^export | implements',
          code: 120
        }
      ],

      'new-parens': 'off',
      'newline-per-chained-call': 'off',
      'no-bitwise': 'off',
      'no-caller': 'error',
      'no-eval': 'error',
      'no-fallthrough': 'error',
      'no-new-wrappers': 'error',
      'no-throw-literal': 'error',
      'no-undef-init': 'error',
      'no-unused-labels': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: ":matches(PropertyDefinition, MethodDefinition)[accessibility='private']",
          message: 'Use #private instead'
        }
      ],
      '@typescript-eslint/array-type': [
        'error',
        {
          default: 'generic'
        }
      ],

      '@typescript-eslint/consistent-type-assertions': 'error',
      '@typescript-eslint/consistent-type-definitions': 'error',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/unbound-method': ['error', { ignoreStatic: true }],
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],

      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
          accessibility: 'explicit'
        }
      ],

      '@typescript-eslint/member-ordering': 'off',

      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'property',
          format: ['strictCamelCase'],

          filter: {
            regex: '^(Content-Type|_type|_tag)$',
            match: false
          }
        }
      ],

      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-interface': 'error',

      '@typescript-eslint/no-inferrable-types': [
        'error',
        {
          ignoreParameters: true
        }
      ],

      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      'no-shadow': 'off',

      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowNullableBoolean: true,
          allowNullableNumber: false,
          allowNullableString: true
        }
      ],

      '@typescript-eslint/no-shadow': [
        'error',
        {
          hoist: 'all'
        }
      ],

      'no-only-tests/no-only-tests': 'error',

      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/prefer-function-type': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/unified-signatures': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error'
    }
  },
  {
    files: ['esbuild.config.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ['**/*.{spec,test}.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
);

# CLAUDE.md

## Development Rules

- **Do not start the dev server unless necessary.** Unless the user explicitly asks to run/start the app or needs the change verified in the real running app, do not automatically run commands that start a dev server such as `yarn start` / `npm run dev`. Prefer type-checking, building, or tests to verify changes.

- **When committing to git, only commit what was changed in the current session.** Do not run `git add .` / `git add -A` to stage the entire working tree. Only `git add` the files you actually modified in this session; leave any unrelated working-tree changes untouched and do not bundle them into this commit.

# CLAUDE.md

## Development Rules

- **Do not start the dev server unless necessary.** Unless the user explicitly asks to run/start the app or needs the change verified in the real running app, do not automatically run commands that start a dev server such as `yarn start` / `npm run dev`. Prefer type-checking, building, or tests to verify changes.

- **When committing to git, only commit what was changed in the current session.** Do not run `git add .` / `git add -A` to stage the entire working tree. Only `git add` the files you actually modified in this session; leave any unrelated working-tree changes untouched and do not bundle them into this commit.

- **Do not commit to git on your own initiative.** Unless a plan explicitly states that each step should be committed as it is completed, do not run `git commit` without being asked. Finish the work and leave the changes staged/unstaged for the user to review and commit, unless the user (or the agreed plan) has told you to commit.

- **When deploying functions, never delete the `labProject*` functions.** The app repo (`infrared-explorer-app`) deploys its own functions codebase, `labprojects`, from its `functions/` folder to this same Firebase project: `labProjectCreate`, `labProjectList`, `labProjectGet`, `labProjectTurn`, `labProjectEdit`, `labProjectAttach`, `labProjectDelete` and `labProjectsOnUserDeleted`. They are not in this repo's source on purpose. If `firebase deploy` (directly or through `npm run deploy:functions` / `deploy:all`) asks whether to delete any function whose name starts with `labProject`, answer **No**; the rest of the deploy still goes ahead. Don't add `--force` to a functions deploy (it deletes without asking), and don't run `firebase functions:delete` on them even if the CLI suggests it.

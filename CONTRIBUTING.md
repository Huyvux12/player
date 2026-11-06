# Contributing

Issues and pull requests are welcome. Please be kind.

## Pull requests

- Keep each one small and about one thing. For a new feature or a larger change, open an issue first.
- Say what it fixes or adds. For the renderer or motion, the character and the pose that show it help a lot.
- Understand and test what you send, whatever tools helped you write it.
- Translations are welcome: add `README.<lang>.md` and link it from the language line at the top of each README. English is the reference, and translations may fall behind it.

For a code change, run this first:

```sh
npm run check && npm test && npm run build && npm run test:browser
```

## What we can't take

- Changes to the featured characters in `characters/`, or new ones. See their [licence](characters/LICENSE.md) and [credits](characters/CREDITS.md).
- Code or assets that can't be released under the Apache License 2.0, including anything that needs a vendor's licence.

## How it is merged

`src/runtime/` is the renderer and motion code that livliv.ai runs, and this repository is published from LivLiv's own copy of it. A pull request is reviewed and merged here as usual; we then apply it to our copy as well, so the next release keeps it.

Contributions are under the Apache License 2.0, like the rest of the code (section 5 of the licence).

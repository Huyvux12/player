# Contributing

Issues and pull requests are welcome.

`src/runtime/` is the renderer and motion code that livliv.ai runs, and this repository is published from LivLiv's own
copy of it. A pull request is reviewed and merged here as usual; we then apply it to our copy as well, so the next
release keeps it. Changes to the runtime are easiest to take when they are small and say what they fix: the character
and the pose that shows it help a lot.

Before you send one:

```sh
npm run check && npm test && npm run build && npm run test:browser
```

Contributions are under the Apache License 2.0, like the rest of the code (section 5 of the licence).

The featured characters in `characters/` are LivLiv's and take no changes; see their [licence](characters/LICENSE.md).

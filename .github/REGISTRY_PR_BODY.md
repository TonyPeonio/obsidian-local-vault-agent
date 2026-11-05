# I am submitting a new Community Plugin

## Repo URL

Link to my plugin: https://github.com/TonyPeonio/obsidian-local-vault-agent

## Release Checklist

- [x] I have tested the plugin on
  - [x] Windows
  - [ ] macOS
  - [ ] Linux
  - [ ] Android _(if applicable)_
  - [ ] iOS _(if applicable)_
- [x] My GitHub release contains all required files
  - [x] `main.js`
  - [x] `manifest.json`
  - [x] `styles.css` _(optional)_
- [x] GitHub release name matches the exact version number specified in my manifest.json (_**Note:** Use the exact version number, don't include a prefix `v`_)
- [x] The `id` in my `manifest.json` matches the `id` in the `community-plugins.json` file.
- [x] My README.md describes the plugin's purpose and provides clear usage instructions.
- [x] I have read the developer policies at https://docs.obsidian.md/Developer+policies, and have assessed my plugin's adherence to these policies.
- [x] I have read the tips in https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines and have self-reviewed my plugin to avoid these common pitfalls.
- [x] I have added a license in the LICENSE file.
- [x] My project respects and is compatible with the original license of any code from other plugins that I'm using.
  I have given proper attribution to these other projects in my `README.md`.

## Network use disclosure

The plugin sends prompts and the contents of notes the agent reads to the Ollama server at the URL the user configures (default `http://localhost:11434`, i.e. the user's own machine). It never contacts any other host and collects no telemetry. This is disclosed in the README under "Privacy and network use".

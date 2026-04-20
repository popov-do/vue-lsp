# Privacy Policy

**vue-lsp** is a Claude Code plugin that runs entirely on your local machine.

## Data Collection

This plugin:
- Collects **no** personal data
- Sends **no** data to external servers
- Has **no** telemetry or analytics
- Makes **no** network requests

## How It Works

The plugin spawns two local LSP processes (`vue-language-server` and `typescript-language-server`) and multiplexes their stdio communication. All data stays on your machine within the Claude Code process.

## Debug Logging

When `VUE_LSP_DEBUG=1` is set, logs are written to a local file (`/tmp/vue-lsp.log` or `%TEMP%/vue-lsp.log`). No logs are created by default. Logs are never transmitted anywhere.

## Contact

For questions, open an issue at https://github.com/popov-do/vue-lsp/issues

# Security

BetterC0de is beta software. Security fixes target the latest development branch and latest published beta; there is no long-term support commitment for older versions.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** option in this repository's Security tab when private vulnerability reporting is enabled. If the option is unavailable, ask the maintainer for a private reporting channel through the [BetterC0de community](https://discord.gg/bettercode), without posting vulnerability details publicly.

Include the affected version, operating system, impact, and reproducible steps. Use a minimal reproduction with dummy credentials and synthetic project data. Do not submit working API keys, private repositories, or personal conversation logs.

Ordinary bugs can go through the issue tracker or the app's report panel. That panel is not a dedicated confidential vulnerability-reporting channel.

## Areas that deserve particular care

- Provider authentication and credential storage.
- File access, project boundaries, and remote pairing.
- Electron main-process IPC, browser previews, and untrusted content.
- Agent permissions, tool execution, and plugin installation.
- Update metadata, release artifacts, and signing credentials.

## Local and CI configuration

Keep secrets in local environment variables or your CI secret store. `.env.example` contains documentation only. Automated repository workflows disable heartbeat and automatic error reporting; see [diagnostic controls](docs/development/README.md#diagnostics-during-development).

## If a signing credential leaks

The phone app's signing credentials are secrets of the `release` environment and offline backups; see [code signing](docs/development/code-signing.md#the-phone-app-is-signed).

- **`EXPO_TOKEN`**: revoke it at expo.dev → Access tokens, create a new one, and replace the secret.
- **App Store Connect API key**: revoke it in App Store Connect → Users and Access → Integrations, create a new one, and store it with `eas credentials`.
- **Android release keystore**: anyone holding it can sign APKs that install as updates of BetterC0de Remote. Publish an advisory, create a new key, pin its certificate, and release a build signed with it. Users must uninstall and reinstall to move to the new key (or receive a v3 key rotation; see the code-signing page), and pair again.

Known dependency advisories and the decisions taken during source preparation are documented in the [dependency security review](docs/development/dependency-security.md). Re-run the audit before a release; the recorded results are a dated snapshot.

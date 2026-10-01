# Provider API-key UI verification

These screenshots use synthetic key metadata and model IDs in an isolated local browser fixture. They contain no credentials or user settings.

- [Before](provider-keys-before.png)
- [Default dark](provider-keys-dark.png)
- [White](provider-keys-light.png)

The actual provider settings components were exercised with mocked backend responses: add, blank-secret edit, rename, reorder, disable/enable, delete, authentication check, external-source confirmation/cancel, and a failed save. Keyboard submission and a visible focus ring were checked. Owned button transitions are disabled with reduced motion enabled.

Default dark, white, system (dark), and imported light/dark themes were inspected at 720, 480, and 320 pixel panel widths, plus white at 125% zoom. API-key panels had no horizontal overflow. Loading, plaintext-storage, and cooldown states are also covered by the component tests. Live paid requests and animation playback at 10% speed were not verified.

UI polish review: No actionable UI-polish findings in the inspected states.

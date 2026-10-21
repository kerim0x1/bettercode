# Third-party notices

BetterC0de's source, dependency packages, and third-party assets do not all share one license. Preserve upstream license and copyright notices when redistributing their material. BetterC0de source is released under the MIT License in [`LICENSE`](LICENSE). Selecting that license for BetterC0de does not replace third-party terms.

## Bundled assets

| Material | Upstream | Notice |
| --- | --- | --- |
| File and folder icons | [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme), pinned to 5.38.1 | MIT; the existing [license text](apps/ui/public/file-icons/LICENSE.material-icon-theme.txt) is included beside the icons. |
| Mechanical keyboard recordings | [Mechvibes](https://github.com/hainguyents13/mechvibes) and [MechVibesPlusPlus](https://github.com/PyroCalzone/MechVibesPlusPlus) | MIT; see the [Mechvibes notice](licenses/mechvibes.MIT.txt) and [MechVibesPlusPlus notice](licenses/mechvibes-plus-plus.MIT.txt). |
| Mouse recordings | [MechVibesPlusPlus](https://github.com/PyroCalzone/MechVibesPlusPlus) | MIT; see the [included notice](licenses/mechvibes-plus-plus.MIT.txt). |
| Chart components in `apps/ui/src/components/charts` | [EvilCharts](https://github.com/legions-developer/evilcharts) | MIT; adapted source, see the [EvilCharts notice](licenses/evilcharts.MIT.txt). Each file keeps an attribution header. |
| Figtree font packages | [Figtree](https://github.com/erikdkennedy/figtree) | SIL Open Font License 1.1, as declared by the installed font packages. The [font license text](licenses/figtree.OFL.txt) is included; also preserve the packages' notices. |

The bundled keyboard and mouse audio files were compared with upstream Git blob hashes during preparation. The upstream references and matching paths are recorded in [audio provenance](docs/development/audio-provenance.json).

## Dependencies with separate terms

**Anthropic Claude Agent SDK.** The installed `@anthropic-ai/claude-agent-sdk` package declares that use is governed by Anthropic's Commercial Terms of Service. Do not describe it as licensed under BetterC0de's own license. Consult the [SDK's license and terms](https://github.com/anthropics/claude-agent-sdk-typescript#license-and-terms) and retain any component-specific notices.

**Remotion.** Optional video/demo tooling uses Remotion packages with a separate free/company licensing model. The installed license contains eligibility and usage restrictions. Consult [Remotion's license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) before using that tooling commercially or redistributing its components. BetterC0de's license does not grant additional rights to Remotion.

Other direct dependency declarations are recorded in the [dependency license inventory](docs/development/dependency-licenses.md). Transitive dependencies also carry licenses; their installed package notices remain authoritative.

## Names, logos, and other images

Provider, framework, operating-system, and service names and marks identify integrations. They remain associated with their respective owners, and inclusion does not imply endorsement. The small marks in `apps/ui/public/icons` are those third-party marks. They are not relicensed by the MIT License.

The project owner supplies the BetterC0de logo, the brand guide, `apps/ui/public/background.webp`, and `assets/betterc0de-website.png`. A source-code license does not by itself grant permission to imply that a modified distribution is an official BetterC0de release.

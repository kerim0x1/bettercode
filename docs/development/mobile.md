# Building and testing the phone app

The phone app, BetterC0de Remote, lives in `apps/mobile` (Expo SDK 56, React Native 0.85). This page covers its native builds and device tests. For the app itself (architecture, demo mode, the JavaScript tests) see [`apps/mobile/README.md`](../../apps/mobile/README.md).

| What | Where it is built | Command |
| --- | --- | --- |
| Android APK | locally (Windows, macOS, Linux) and in CI | `npm run mobile:apk -- build` |
| iOS app for the simulator, signed ad hoc to run there | macOS and CI | `npm run mobile:ios:sim -- build` |
| iOS app for TestFlight | EAS (Expo's build service) | not automated yet; the release workflow will run it |

`npm run release:check` builds and device-tests the app on every platform whose toolchain it finds (`--mobile auto`), and says which it skipped and why. `--mobile android`, `ios` or `all` make a missing toolchain an error; `--mobile none` leaves the app out. CI builds the app in its own jobs (`mobile-android`, `mobile-ios` in `.github/workflows/ci.yml`), so the desktop legs pass `--mobile none`.

## Toolchain

```bash
npm run mobile:toolchain              # what is found and what is missing
npm run mobile:toolchain -- --maestro # also download the device-test runner now
```

**Android** (any OS):

- **JDK 17.** React Native builds with it, and CI uses it. `JAVA_HOME` is used only when it points at a JDK 17. Machines often point it at a newer one (a JDK 25 here), so the scripts otherwise look in the usual install folders (`C:\Program Files\Microsoft`, `Eclipse Adoptium`, …, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`). `BETTERC0DE_JAVA_HOME` overrides the search.
- **Android SDK** in `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or where Android Studio puts it (`%LOCALAPPDATA%\Android\Sdk`, `~/Library/Android/sdk`, `~/Android/Sdk`). The packages come from React Native's version catalog (`node_modules/react-native/gradle/libs.versions.toml`), so they follow React Native upgrades. Today that means `platform-tools`, `platforms;android-36`, `build-tools;36.0.0`, `ndk;27.1.12297006` and, for device tests, `emulator`. The toolchain check prints the `sdkmanager` command for whatever is missing.
- **An emulator** for the device tests, named `BetterC0de_Test` (or `BETTERC0DE_AVD`):

  ```bash
  sdkmanager "system-images;android-36;google_apis;x86_64"
  avdmanager create avd -n BetterC0de_Test -k "system-images;android-36;google_apis;x86_64"
  ```

  On Windows the emulator needs the Windows Hypervisor Platform (`emulator -accel-check`).

**iOS** (macOS only): Xcode 26 or newer, selected with `xcode-select` or `DEVELOPER_DIR`, and CocoaPods. From Windows, iOS builds go through EAS.

**Maestro** runs the device tests. Its version and SHA-256 are pinned in [`apps/mobile/maestro/maestro.json`](../../apps/mobile/maestro/maestro.json). The first device test downloads it into `%LOCALAPPDATA%\betterc0de\maestro`, `~/Library/Caches/betterc0de/maestro` or `~/.cache/betterc0de/maestro` (or `BETTERC0DE_MAESTRO_HOME`). A download whose checksum differs from the pin is deleted. To update Maestro, change the version, URL and checksum together; the checksum is the `sha256` digest GitHub shows for the release's `maestro.zip`.

## Android

```bash
npm run mobile:apk -- build                    # test key (the default)
npm run mobile:apk -- build --signing release  # release key
npm run mobile:apk -- verify <apk> [--signing release]
npm run mobile:apk -- e2e [<apk>]              # emulator or attached device
npm run mobile:apk -- all                      # build, then e2e
```

`build` compiles the shared schema and regenerates `apps/mobile/android` with the pinned template (`scripts/mobile-prebuild.mjs`; the folder is build output and never committed). It then runs Gradle's `assembleRelease` with JDK 17 and verifies the result. The APK lands in `apps/mobile/build/android/`:

- `BetterC0de-Remote-<version>.apk`, signed with the release key. Only this name can be published.
- `BetterC0de-Remote-<version>-test-key.apk`, signed with a key made for that one build. It installs and runs like the release, but can never update a release install.

`verify` checks what a user installs, and lists every problem it finds:

- **Signature:** APK Signature Scheme v2, exactly one signer. A release must carry the certificate pinned in `apps/mobile/signing/android-release.json`. A test build must carry neither that certificate nor the React Native template's debug key, whose password is public.
- **Identity:** package `com.betterc0de.remote`; version name and code from the desktop version (see [Versions](#versions)); minimum and target SDK from React Native; native code for `arm64-v8a`, `armeabi-v7a` and `x86_64`. The APK must not be debuggable.
- **Permissions:** exactly the permissions listed in `scripts/mobile-android.mjs`. A new permission shows up in the install dialog, so it needs a reason there.
- **Native libraries:** the 64-bit libraries load on devices with 16 KB memory pages.
- **Size:** within the budget in `scripts/mobile-android.mjs`.

`e2e` runs on the test emulator: it uses the `BetterC0de_Test` AVD (or `BETTERC0DE_AVD`) when it is already running, and boots it otherwise. It never touches another emulator or a phone, because it uninstalls the app and turns animations off; to test on one anyway, name it with `ANDROID_SERIAL`. It installs the APK, checks that the app starts and stays up, then runs the Maestro flows in `apps/mobile/maestro/flows`. A failed run leaves the Maestro report, a screenshot and logcat in `apps/mobile/build/e2e/android/`.

### Signing keys

A test build needs nothing: the key is made on the fly.

The **release key** comes from these variables, in the environment or in the git-ignored `.env.signing` at the repository root:

```bash
BETTERC0DE_ANDROID_KEYSTORE=/absolute/path/to/betterc0de-release.p12
BETTERC0DE_ANDROID_KEYSTORE_PASSWORD=...
BETTERC0DE_ANDROID_KEY_ALIAS=betterc0de-release
BETTERC0DE_ANDROID_KEY_PASSWORD=...
```

CI passes the keystore itself as `BETTERC0DE_ANDROID_KEYSTORE_BASE64`. It is written to a temporary file for the build and deleted afterwards. The signing plugin (`apps/mobile/plugins/with-android-release-signing.cjs`) fails a release build that has no key, so an APK can never come out signed with the template's debug key.

To create the release key once (JDK 17's `keytool`; PowerShell shown):

```powershell
$kt = (Resolve-Path "C:\Program Files\Microsoft\jdk-17*\bin\keytool.exe").Path
& $kt -genkeypair -v -storetype PKCS12 -keystore "$HOME\.betterc0de-signing\betterc0de-release.p12" -alias betterc0de-release -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=BetterC0de Remote, C=DE"
& $kt -list -v -keystore "$HOME\.betterc0de-signing\betterc0de-release.p12"
```

Then pin its certificate in `apps/mobile/signing/android-release.json`: the SHA-256 fingerprint `keytool` prints, in lowercase without colons.

```json
{ "sha256": "0a1b…", "subject": "CN=BetterC0de Remote, C=DE" }
```

**Keep the keystore and both passwords backed up in two places.** Android installs an update only when it is signed with the same key. Without the key, every existing installation needs an uninstall to move to a new one, and loses its pairing.

## iOS

```bash
npm run mobile:ios:sim -- build   # Release build for the simulator, signed ad hoc
npm run mobile:ios:sim -- e2e     # boot a simulator, install, run the Maestro flows
npm run mobile:ios:sim -- all
```

The build regenerates `apps/mobile/ios`, runs `pod install` and builds the Release configuration for the simulator without code signing into `apps/mobile/build/ios`. That configuration puts the JavaScript bundle inside the app, as in TestFlight. It then checks the Info.plist:

- bundle identifier and version;
- the network policy (ATS);
- the encryption declaration;
- the camera prompt and no microphone prompt;
- the `betterc0de://` scheme.

`e2e` uses the simulator `BETTERC0DE_SIMULATOR` names, or an iPhone on the newest iOS. The signed App Store build is made by EAS. This build proves that the native project compiles and that the app runs.

## Versions

The app carries the desktop's version (`package.json` at the root) and is released with it. `apps/mobile/config/version.cjs` maps it onto the stores' formats:

| Desktop | Android `versionName` | Android `versionCode` | iOS version |
| --- | --- | --- | --- |
| `0.1.0-beta.2` | `0.1.0-beta.2` | `100302` | `0.1.0` |
| `0.1.0-rc.1` | `0.1.0-rc.1` | `100501` | `0.1.0` |
| `0.1.0` | `0.1.0` | `100900` | `0.1.0` |
| `0.2.0-beta.1` | `0.2.0-beta.1` | `200301` | `0.2.0` |

The version code is `major·10⁷ + minor·10⁵ + patch·10³ + stage`, where the stage is alpha 100+n, beta 300+n, rc 500+n and final 900. It grows with every release, prereleases included. The iOS build number is counted by EAS.

## Device tests

The flows in `apps/mobile/maestro/flows` run against the demo mode, so they need no desktop:

- `pairing-input.yaml`: a bare pairing code is refused before anything is sent.
- `demo-chat.yaml`: the demo from the pairing screen through a streamed, approved reply to **Exit demo**.
- `demo-link.yaml`: `betterc0de://demo` opens the demo. This checks the scheme the native project registers.
- `demo-git.yaml`: source control from a project: a file and one of a README's two changes staged, a generated message, a commit and a push.

They find elements by `testID`, which Maestro sees as the element's id on both platforms. Renaming or removing one breaks a flow, and CI with it.

Two things in the flows are the device's rather than the app's:

- **iOS asks before a link opens an app** ("Open in “BetterC0de Remote”?"). Maestro does not always see that question, since iOS shows it and not the app. The link flow taps **Open** by its text, and where it sits on the screen when the pairing screen still shows afterwards.
- **The Android emulator can drop adb for a moment.** In CI its adbd sometimes closes the connection just after Maestro clears the app's data, and the next command fails with "device offline". `e2e` runs a flow that failed that way once more, and says so in the log. A flow that failed on anything else fails the run. Maestro's JUnit report calls that failure "Unknown error"; the cause is in the flow's `commands.json`.

Choosing photos needs the system's photo picker or camera, which the flows do not drive. The screen tests (`src/__tests__/chat-photos.test.tsx`) cover photos with the picker replaced, and the helpers that size and encode them have their own tests.

To run one flow against an attached device, call the cached Maestro directly (`npm run mobile:toolchain -- --maestro` prints where it is), with JDK 17 as `JAVA_HOME`:

```bash
<maestro> test apps/mobile/maestro/flows/demo-chat.yaml
```

## Troubleshooting

- **`OutOfMemoryError: Metaspace` in a Kotlin task.** Kotlin compiled inside the Gradle process runs out of the metaspace the React Native template gives it (`org.gradle.jvmargs` in `android/gradle.properties`). The build script compiles Kotlin in a separate process per task (`kotlin.compiler.execution.strategy=out-of-process`) for that reason.
- **`npm ci` fails with EBUSY or EPERM on Windows after an Android build.** React Native libraries build inside their `node_modules` folders, and a Gradle or Kotlin daemon keeps those files open. The build script uses neither daemon. After a build by other means, run `gradlew --stop` in `apps/mobile/android`.
- **CMake warns that an object file path is too long.** Windows limits paths to 260 characters unless long paths are enabled, and the native build nests deeply inside `apps/mobile/android/app/.cxx`. Keep the repository at a short path (for example `C:\src\bettercode`), or enable long paths (`LongPathsEnabled` in the registry, and `git config --system core.longpaths true`).
- **The emulator does not start, or is very slow.** On Windows, `emulator -accel-check` must report WHPX; a running virtual machine can hold the hypervisor. Close other heavy programs during the device tests: the flows time out on a starved emulator.
- **Prebuild creates a project for a different React Native.** `expo` 56.0.16 bundles the template of the next SDK, so `scripts/mobile-prebuild.mjs` pins `expo-template-bare-minimum@56.0.36`. `eas.json` uses the same pin, and a test keeps the two equal.
